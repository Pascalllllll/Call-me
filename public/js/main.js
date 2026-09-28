import { api, ApiError } from './api.js';
import { CallSession } from './call.js';
import { formatDay, formatTime, h, icon, initials } from './dom.js';

const app = document.getElementById('app');
const toasts = document.getElementById('toasts');

const state = {
  user: null,
  spaces: [],
  details: new Map(), // spaceId -> detail (channels, members, role)
  spaceId: null,
  channelId: null,
  messages: new Map(), // channelId -> { list, loadedAll }
  online: new Set(),
  voice: new Map(), // channelId -> peers[]
  typing: new Map(), // channelId -> Map(userId -> { name, until })
  speaking: new Set(), // peerIds currently speaking
  ws: null,
  selfPeerId: null,
  iceServers: [],
  call: null, // { session, channelId, spaceId }
  pendingInvite: null,
  focusPeer: null,
  panel: null, // 'nav' | 'members' on narrow screens
  showMembers: true,
};

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  toasts.append(el);
  setTimeout(() => el.remove(), 5000);
}

function fail(err) {
  if (err instanceof ApiError && err.status === 401) {
    signedOut();
    return;
  }
  toast(err?.message || 'Something went wrong', 'error');
}

function navigate(path, replace = false) {
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
}

function currentSpace() {
  return state.details.get(state.spaceId) || null;
}

function currentChannel() {
  return currentSpace()?.channels.find((c) => c.id === state.channelId) || null;
}

function canManage(space = currentSpace()) {
  return space && (space.role === 'admin' || space.role === 'owner');
}

function avatar(name, extra = '') {
  return h('span', { class: `avatar ${extra}`, 'aria-hidden': 'true' }, initials(name));
}

// Turns http(s) URLs into links. Everything else stays plain text.
function linkify(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    let url = m[0].replace(/[.,!?;:)\]]+$/, '');
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        out.push(h('a', { href: parsed.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
      } else out.push(url);
    } catch {
      out.push(url);
    }
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}

function openDialog(title, body, { onClose, wide = false } = {}) {
  const close = () => dlg.close();
  const dlg = h(
    'dialog',
    { class: `dialog ${wide ? 'dialog-wide' : ''}`, 'aria-labelledby': 'dlg-title' },
    h(
      'header',
      { class: 'dialog-head' },
      h('h2', { id: 'dlg-title' }, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x')),
    ),
    h('div', { class: 'dialog-body' }, body),
  );
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

function confirmDialog(message, actionLabel, { danger = true, requireText = null } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const input = requireText
      ? h('input', { type: 'text', autocomplete: 'off', 'aria-label': `Type ${requireText} to confirm` })
      : null;
    const confirmBtn = h('button', { type: 'submit', class: danger ? 'btn btn-danger' : 'btn btn-primary' }, actionLabel);
    if (input) {
      confirmBtn.disabled = true;
      input.addEventListener('input', () => (confirmBtn.disabled = input.value !== requireText));
    }
    const { close } = openDialog(
      'Are you sure?',
      h(
        'form',
        {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            result = true;
            close();
          },
        },
        h('p', {}, message),
        input && h('label', { class: 'field' }, h('span', {}, `Type “${requireText}” to confirm`), input),
        h(
          'div',
          { class: 'row-end' },
          h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
          confirmBtn,
        ),
      ),
      { onClose: () => resolve(result) },
    );
  });
}

function formDialog(title, fields, submitLabel, onSubmit) {
  const inputs = {};
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel);
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
          await onSubmit(values);
          close();
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) return fail(err);
          error.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
    fields.map((f) => {
      const el =
        f.type === 'select'
          ? h('select', { name: f.name }, f.options.map(([value, label]) => h('option', { value }, label)))
          : h('input', {
              name: f.name,
              type: f.type || 'text',
              value: f.value ?? '',
              placeholder: f.placeholder,
              required: f.required !== false,
              maxLength: f.maxLength,
              autocomplete: f.autocomplete || 'off',
            });
      if (f.type === 'select' && f.value) el.value = f.value;
      inputs[f.name] = el;
      return h('label', { class: 'field' }, h('span', {}, f.label), el, f.hint && h('small', {}, f.hint));
    }),
    error,
    h('div', { class: 'row-end' }, h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'), submit),
  );
  const { close } = openDialog(title, form);
  form.querySelector('input, select')?.focus();
}

function renderAuth(mode = 'login') {
  app.replaceChildren();
  document.title = 'Call-me';
  const isLogin = mode === 'login';
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, isLogin ? 'Sign in' : 'Create account');
  const username = h('input', {
    name: 'username',
    required: true,
    autocomplete: 'username',
    minLength: 3,
    maxLength: 32,
    pattern: '[A-Za-z0-9_.\\-]{3,32}',
    placeholder: 'your_name',
    title: '3-32 characters: letters, numbers, _ . -',
  });
  const displayName = isLogin ? null : h('input', { name: 'displayName', maxLength: 48, placeholder: 'How people see you' });
  const password = h('input', {
    name: 'password',
    type: 'password',
    required: true,
    minLength: isLogin ? 1 : 10,
    maxLength: 200,
    autocomplete: isLogin ? 'current-password' : 'new-password',
  });

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          const body = { username: username.value.trim(), password: password.value };
          if (!isLogin) body.displayName = displayName.value.trim() || body.username;
          const { user } = await api.post(isLogin ? '/auth/login' : '/auth/register', body);
          await signedIn(user);
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
          password.select();
        }
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Username'), username),
    displayName && h('label', { class: 'field' }, h('span', {}, 'Display name'), displayName),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Password'),
      password,
      !isLogin && h('small', {}, 'At least 10 characters.'),
    ),
    error,
    submit,
  );

  app.append(
    h(
      'div',
      { class: 'auth' },
      h(
        'section',
        { class: 'auth-intro' },
        h('p', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 36, height: 36 }), 'Call-me'),
        h('h1', { class: 'auth-title' }, state.pendingInvite ? 'Someone saved you a seat.' : 'Your group’s place to talk.'),
        h(
          'p',
          { class: 'auth-lede' },
          state.pendingInvite
            ? 'Sign in or create an account to accept your invite.'
            : 'Text channels, voice rooms, camera and screen sharing. Calls run as long as you need.',
        ),
      ),
      h(
        'section',
        { class: 'auth-card', 'aria-label': isLogin ? 'Sign in' : 'Create account' },
        h('h2', {}, isLogin ? 'Welcome back' : 'Create your account'),
        form,
        h(
          'p',
          { class: 'muted small' },
          isLogin ? 'New here? ' : 'Already have an account? ',
          h(
            'button',
            { type: 'button', class: 'link-btn', onclick: () => renderAuth(isLogin ? 'register' : 'login') },
            isLogin ? 'Create an account' : 'Sign in',
          ),
        ),
      ),
    ),
  );
  username.focus();
}

async function signedIn(user) {
  state.user = user;
  await loadSpaces();
  connectSocket();
  renderShell();
  if (state.pendingInvite) {
    const code = state.pendingInvite;
    state.pendingInvite = null;
    showInvite(code);
  } else {
    route();
  }
}

function signedOut() {
  leaveCall(false);
  state.ws?.close();
  state.ws = null;
  state.user = null;
  state.spaces = [];
  state.details.clear();
  state.messages.clear();
  state.voice.clear();
  state.spaceId = state.channelId = null;
  document.querySelectorAll('dialog').forEach((d) => d.close());
  navigate('/', true);
  renderAuth('login');
}

async function loadSpaces() {
  const { spaces } = await api.get('/spaces');
  state.spaces = spaces;
}

async function loadSpace(spaceId) {
  const { space } = await api.get(`/spaces/${spaceId}`);
  state.details.set(spaceId, space);
  const summary = state.spaces.find((s) => s.id === spaceId);
  if (summary) {
    summary.name = space.name;
    summary.role = space.role;
  }
  return space;
}

async function loadMessages(channelId, older = false) {
  const entry = state.messages.get(channelId) || { list: [], loadedAll: false };
  const before = older && entry.list.length ? entry.list[0].createdAt : undefined;
  const { messages } = await api.get(`/channels/${channelId}/messages${before ? `?before=${before}` : ''}`);
  entry.list = older ? [...messages, ...entry.list] : messages;
  entry.loadedAll = messages.length < 50;
  state.messages.set(channelId, entry);
  return entry;
}

async function route() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'i' && parts[1]) {
    navigate('/app', true);
    return showInvite(parts[1]);
  }
  let [, spaceId, channelId] = parts[0] === 'app' ? parts : [];
  if (!spaceId || !state.spaces.some((s) => s.id === spaceId)) spaceId = state.spaces[0]?.id;
  await selectSpace(spaceId || null, channelId, true);
}

async function selectSpace(spaceId, channelId, replace = false) {
  state.spaceId = spaceId;
  state.panel = null;
  if (!spaceId) {
    state.channelId = null;
    navigate('/app', replace);
    return renderShell();
  }
  try {
    const space = state.details.get(spaceId) || (await loadSpace(spaceId));
    const channel =
      space.channels.find((c) => c.id === channelId) ||
      space.channels.find((c) => c.kind === 'text') ||
      space.channels[0];
    await selectChannel(channel?.id || null, replace);
  } catch (err) {
    fail(err);
  }
}

async function selectChannel(channelId, replace = false) {
  state.channelId = channelId;
  state.panel = null;
  unread.delete(channelId);
  navigate(channelId ? `/app/${state.spaceId}/${channelId}` : `/app/${state.spaceId}`, replace);
  const ch = currentChannel();
  if (ch?.kind === 'text' && !state.messages.has(ch.id)) {
    renderShell();
    try {
      await loadMessages(ch.id);
    } catch (err) {
      fail(err);
    }
  }
  renderShell();
  // The log was built while history was still loading, and renderShell keeps an existing log.
  if (ch?.kind === 'text' && state.channelId === ch.id) {
    if (state.messages.has(ch.id)) renderMessages(true);
    else showMessagesError(ch.id);
  }
  if (ch?.kind === 'text') document.getElementById('composer')?.focus({ preventScroll: true });
}

window.addEventListener('popstate', () => state.user && route());

let reconnectDelay = 1000;
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onSocketMessage(msg);
  });
  ws.addEventListener('close', async (e) => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.call) {
      leaveCall(false);
      toast('Connection lost. You left the call.', 'error');
    }
    if (e.code === 4001) return signedOut();
    // Handshake refused with 401 surfaces as code 1006; confirm the session before retrying.
    try {
      if (!(await api.get('/session')).user) return signedOut();
    } catch {
      // Server unreachable: keep retrying below.
    }
    setTimeout(() => state.user && !state.ws && connectSocket(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
}

function wsSend(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

async function onSocketMessage(msg) {
  switch (msg.type) {
    case 'hello':
      state.selfPeerId = msg.peerId;
      state.iceServers = msg.iceServers;
      state.online = new Set(msg.online);
      state.online.add(state.user.id);
      state.voice.clear();
      for (const v of msg.voice) state.voice.set(v.channelId, v.peers);
      renderShell();
      break;
    case 'space.sync':
      for (const id of msg.online) state.online.add(id);
      for (const v of msg.voice) state.voice.set(v.channelId, v.peers);
      renderShell();
      break;
    case 'presence':
      if (msg.online) state.online.add(msg.userId);
      else state.online.delete(msg.userId);
      renderMembers();
      break;
    case 'voice.state':
      if (msg.peers.length) state.voice.set(msg.channelId, msg.peers);
      else state.voice.delete(msg.channelId);
      renderSidebar();
      renderMain();
      break;
    case 'voice.joined':
      if (!state.call || state.call.pendingChannelId !== msg.channelId) {
        wsSend({ type: 'voice.leave' });
        break;
      }
      state.call.channelId = msg.channelId;
      state.call.spaceId = msg.spaceId;
      state.call.session.joined(msg);
      wsSend({ type: 'voice.update', ...state.call.session.initialState() });
      renderShell();
      break;
    case 'voice.peer-joined':
      state.call?.session.peerJoined(msg.peer);
      break;
    case 'voice.peer-left':
      state.call?.session.peerLeft(msg.peerId);
      break;
    case 'voice.left':
      if (state.call) {
        leaveCall(false);
        const reasons = {
          'joined-elsewhere': 'You joined a call from another tab or device.',
          removed: 'You were removed from this space.',
          'channel-deleted': 'The voice channel was deleted.',
        };
        toast(reasons[msg.reason] || 'You left the call.');
      }
      break;
    case 'signal':
      state.call?.session.signal(msg.from, msg.data);
      break;
    case 'message.created': {
      const entry = state.messages.get(msg.message.channelId);
      if (entry && !entry.list.some((m) => m.id === msg.message.id)) {
        entry.list.push(msg.message);
        if (msg.message.channelId === state.channelId) renderMessages(true);
      }
      state.typing.get(msg.message.channelId)?.delete(msg.message.authorId);
      if (msg.message.channelId !== state.channelId && msg.message.authorId !== state.user.id) {
        markUnread(msg.message.channelId, msg.spaceId);
      }
      break;
    }
    case 'message.deleted': {
      const entry = state.messages.get(msg.channelId);
      if (entry) {
        entry.list = entry.list.filter((m) => m.id !== msg.messageId);
        if (msg.channelId === state.channelId) renderMessages(false);
      }
      break;
    }
    case 'typing':
      if (msg.userId === state.user.id) break;
      if (!state.typing.has(msg.channelId)) state.typing.set(msg.channelId, new Map());
      state.typing.get(msg.channelId).set(msg.userId, { name: msg.displayName, until: Date.now() + 4000 });
      if (msg.channelId === state.channelId) renderTyping();
      break;
    case 'channel.created':
    case 'channel.updated':
    case 'channel.deleted':
    case 'members.changed':
    case 'member.added':
    case 'member.removed':
    case 'space.updated': {
      const spaceId = msg.spaceId || msg.channel?.spaceId;
      if (msg.type === 'space.updated') {
        const s = state.spaces.find((x) => x.id === spaceId);
        if (s) s.name = msg.name;
      }
      if (state.details.has(spaceId)) {
        try {
          await loadSpace(spaceId);
        } catch {
          break;
        }
        if (msg.type === 'channel.deleted' && state.channelId === msg.channelId && state.spaceId === spaceId) {
          await selectSpace(spaceId, null, true);
          break;
        }
      }
      renderShell();
      break;
    }
    case 'space.removed': {
      state.spaces = state.spaces.filter((s) => s.id !== msg.spaceId);
      state.details.delete(msg.spaceId);
      if (msg.reason === 'kicked') toast('You were removed from a space.');
      if (msg.reason === 'banned') toast('You were banned from a space.');
      if (state.spaceId === msg.spaceId) await selectSpace(state.spaces[0]?.id || null, null, true);
      else renderShell();
      break;
    }
    case 'error':
      toast(msg.error, 'error');
      break;
    default:
      break;
  }
}

const unread = new Map();
function markUnread(channelId, spaceId) {
  unread.set(channelId, spaceId);
  renderRail();
  renderSidebar();
}

function spaceHasUnread(spaceId) {
  for (const s of unread.values()) if (s === spaceId) return true;
  return false;
}

async function joinCall(channelId) {
  if (state.call?.channelId === channelId) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return toast('Still connecting. Try again in a moment.', 'error');
  if (state.call) leaveCall(true);
  const session = new CallSession({
    send: wsSend,
    iceServers: state.iceServers,
    onChange: () => {
      renderMain();
      renderSidebar();
    },
    onSpeaking: (peerId, speaking) => {
      if (speaking) state.speaking.add(peerId);
      else state.speaking.delete(peerId);
      document.querySelectorAll(`[data-peer="${CSS.escape(peerId)}"]`).forEach((el) => {
        el.classList.toggle('speaking', speaking);
      });
    },
    onError: (m) => toast(m, 'error'),
  });
  state.call = { session, channelId: null, pendingChannelId: channelId, spaceId: state.spaceId };
  renderMain();
  await session.prepare();
  if (state.call?.session !== session) return session.leave();
  wsSend({ type: 'voice.join', channelId });
}

function leaveCall(notify = true) {
  if (!state.call) return;
  if (notify) wsSend({ type: 'voice.leave' });
  state.call.session.leave();
  state.call = null;
  state.focusPeer = null;
  state.speaking.clear();
  if (state.user) renderShell();
}

window.addEventListener('beforeunload', () => {
  if (state.call) wsSend({ type: 'voice.leave' });
});

function renderShell() {
  if (!state.user) return;
  let shell = document.querySelector('.shell');
  if (!shell) {
    shell = h(
      'div',
      { class: 'shell' },
      h('nav', { class: 'rail', 'aria-label': 'Spaces' }),
      h('aside', { class: 'sidebar', 'aria-label': 'Channels' }),
      h('main', { class: 'main', id: 'main' }),
      h('aside', { class: 'members', 'aria-label': 'Members' }),
      h('div', { class: 'scrim', onclick: () => setPanel(null) }),
    );
    app.replaceChildren(shell);
  }
  shell.classList.toggle('panel-nav', state.panel === 'nav');
  shell.classList.toggle('panel-members', state.panel === 'members');
  shell.classList.toggle('hide-members', !state.showMembers || !currentSpace());
  const space = currentSpace();
  const ch = currentChannel();
  document.title = ch ? `${ch.kind === 'text' ? '#' : ''}${ch.name} · ${space.name} · Call-me` : 'Call-me';
  renderRail();
  renderSidebar();
  renderMain();
  renderMembers();
}

function setPanel(panel) {
  state.panel = state.panel === panel ? null : panel;
  const shell = document.querySelector('.shell');
  shell?.classList.toggle('panel-nav', state.panel === 'nav');
  shell?.classList.toggle('panel-members', state.panel === 'members');
}

function renderRail() {
  const rail = document.querySelector('.rail');
  if (!rail) return;
  rail.replaceChildren(
    h(
      'ul',
      { class: 'rail-list' },
      state.spaces.map((s) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              class: `rail-btn ${s.id === state.spaceId ? 'active' : ''} ${s.id !== state.spaceId && spaceHasUnread(s.id) ? 'unread' : ''}`,
              title: s.name,
              'aria-label': s.id !== state.spaceId && spaceHasUnread(s.id) ? `${s.name}, new messages` : s.name,
              'aria-current': s.id === state.spaceId ? 'page' : null,
              onclick: () => selectSpace(s.id),
            },
            initials(s.name),
          ),
        ),
      ),
    ),
    h(
      'button',
      { class: 'rail-btn rail-add', title: 'Create or join a space', 'aria-label': 'Create or join a space', onclick: showNewSpace },
      icon('plus'),
    ),
  );
}

function showNewSpace() {
  const { close } = openDialog(
    'Start something',
    h(
      'div',
      { class: 'choice-list' },
      h(
        'button',
        {
          class: 'choice',
          onclick: () => {
            close();
            quickMeeting();
          },
        },
        h('strong', {}, 'Start a meeting now'),
        h('span', {}, 'Creates a room and an invite link you can share right away.'),
      ),
      h(
        'button',
        {
          class: 'choice',
          onclick: () => {
            close();
            formDialog('Create a space', [{ name: 'name', label: 'Space name', maxLength: 64, placeholder: 'Design team' }], 'Create', async ({ name }) => {
              const { space } = await api.post('/spaces', { name });
              state.spaces.push(space);
              await selectSpace(space.id);
            });
          },
        },
        h('strong', {}, 'Create a space'),
        h('span', {}, 'A permanent home with text and voice channels, like a Discord server.'),
      ),
      h(
        'button',
        {
          class: 'choice',
          onclick: () => {
            close();
            formDialog(
              'Join with an invite',
              [{ name: 'link', label: 'Invite link or code', placeholder: `${location.origin}/i/…` }],
              'Continue',
              async ({ link }) => {
                const code = link.trim().split('/').filter(Boolean).pop();
                await api.get(`/invites/${encodeURIComponent(code)}`);
                setTimeout(() => showInvite(code));
              },
            );
          },
        },
        h('strong', {}, 'Join with an invite'),
        h('span', {}, 'Paste a link someone sent you.'),
      ),
    ),
  );
}

async function quickMeeting() {
  try {
    const { space, invite } = await api.post('/meetings', {});
    state.spaces.push(space);
    const detail = await loadSpace(space.id);
    const voice = detail.channels.find((c) => c.kind === 'voice');
    await selectSpace(space.id, voice.id);
    showInviteLink(invite);
    joinCall(voice.id);
  } catch (err) {
    fail(err);
  }
}

function renderSidebar() {
  const bar = document.querySelector('.sidebar');
  if (!bar) return;
  const space = currentSpace();
  const children = [];

  if (space) {
    children.push(
      h(
        'header',
        { class: 'side-head' },
        h('h2', { class: 'side-title', title: space.name }, space.name),
        h('button', { class: 'icon-btn', title: 'Invite people', 'aria-label': 'Invite people', onclick: () => showCreateInvite(space) }, icon('link')),
        h('button', { class: 'icon-btn', title: 'Space settings', 'aria-label': 'Space settings', onclick: () => showSpaceSettings(space) }, icon('gear')),
      ),
    );
    const section = (kind, label) => {
      const list = space.channels.filter((c) => c.kind === kind);
      return h(
        'section',
        { class: 'chan-section' },
        h(
          'div',
          { class: 'chan-section-head' },
          h('h3', {}, label),
          canManage(space) &&
            h(
              'button',
              {
                class: 'icon-btn small',
                title: `Add ${kind} channel`,
                'aria-label': `Add ${kind} channel`,
                onclick: () =>
                  formDialog(
                    `New ${kind} channel`,
                    [{ name: 'name', label: 'Channel name', maxLength: 48, placeholder: kind === 'text' ? 'announcements' : 'Standup' }],
                    'Create',
                    async ({ name }) => {
                      const { channel } = await api.post(`/spaces/${space.id}/channels`, { name, kind });
                      await loadSpace(space.id);
                      await selectChannel(channel.id);
                    },
                  ),
              },
              icon('plus'),
            ),
        ),
        list.length === 0 && h('p', { class: 'muted small pad' }, `No ${kind} channels yet.`),
        h(
          'ul',
          { class: 'chan-list' },
          list.map((c) => {
            const peers = state.voice.get(c.id) || [];
            return h(
              'li',
              {},
              h(
                'button',
                {
                  class: `chan ${c.id === state.channelId ? 'active' : ''} ${unread.has(c.id) ? 'unread' : ''}`,
                  'aria-label': unread.has(c.id) ? `${c.name}, new messages` : null,
                  'aria-current': c.id === state.channelId ? 'page' : null,
                  onclick: () => selectChannel(c.id),
                },
                icon(kind === 'text' ? 'hash' : 'speaker'),
                h('span', { class: 'chan-name' }, c.name),
                kind === 'voice' && peers.length > 0 && h('span', { class: 'count' }, peers.length),
              ),
              kind === 'voice' &&
                peers.length > 0 &&
                h(
                  'ul',
                  { class: 'voice-peers' },
                  peers.map((p) =>
                    h(
                      'li',
                      { class: `voice-peer ${state.speaking.has(p.peerId) ? 'speaking' : ''}`, dataset: { peer: p.peerId } },
                      avatar(p.displayName, 'avatar-xs'),
                      h('span', { class: 'chan-name' }, p.displayName),
                      p.screen && h('span', { class: 'tag' }, 'Live'),
                      p.deafened ? icon('headphonesOff', 'Deafened') : p.muted ? icon('micOff', 'Muted') : null,
                    ),
                  ),
                ),
            );
          }),
        ),
      );
    };
    children.push(h('div', { class: 'chan-scroll' }, section('text', 'Text channels'), section('voice', 'Voice channels')));
  } else {
    children.push(h('div', { class: 'chan-scroll' }));
  }

  if (state.call) {
    const callSpace = state.details.get(state.call.spaceId);
    const callChannel = callSpace?.channels.find((c) => c.id === (state.call.channelId || state.call.pendingChannelId));
    const s = state.call.session;
    children.push(
      h(
        'section',
        { class: 'callbar', 'aria-label': 'Current call' },
        h(
          'button',
          {
            class: 'callbar-info',
            onclick: () => selectSpace(state.call.spaceId, state.call.channelId || state.call.pendingChannelId),
          },
          h('strong', {}, state.call.channelId ? 'In call' : 'Connecting…'),
          h('span', { class: 'muted small' }, `${callChannel?.name || 'Voice'} · ${callSpace?.name || ''}`),
        ),
        h(
          'div',
          { class: 'callbar-controls' },
          h('button', { class: `icon-btn ${s.muted ? 'off' : ''}`, 'aria-pressed': String(s.muted), 'aria-label': s.muted ? 'Unmute' : 'Mute', title: s.muted ? 'Unmute' : 'Mute', onclick: () => s.setMuted(!s.muted) }, icon(s.muted ? 'micOff' : 'mic')),
          h('button', { class: `icon-btn ${s.deafened ? 'off' : ''}`, 'aria-pressed': String(s.deafened), 'aria-label': s.deafened ? 'Undeafen' : 'Deafen', title: s.deafened ? 'Undeafen' : 'Deafen', onclick: () => s.setDeafened(!s.deafened) }, icon(s.deafened ? 'headphonesOff' : 'headphones')),
          h('button', { class: 'icon-btn danger', 'aria-label': 'Leave call', title: 'Leave call', onclick: () => leaveCall() }, icon('leave')),
        ),
      ),
    );
  }

  children.push(
    h(
      'footer',
      { class: 'me' },
      avatar(state.user.displayName),
      h('div', { class: 'me-names' }, h('strong', {}, state.user.displayName), h('span', { class: 'muted small' }, `@${state.user.username}`)),
      themeButton(),
      h('button', { class: 'icon-btn', 'aria-label': 'Your settings', title: 'Your settings', onclick: showUserSettings }, icon('gear')),
    ),
  );
  bar.replaceChildren(...children);
}

function topbar(title, iconName, extra = []) {
  return h(
    'header',
    { class: 'topbar' },
    h('button', { class: 'icon-btn only-narrow', 'aria-label': 'Open channels', onclick: () => setPanel('nav') }, icon('menu')),
    iconName && icon(iconName),
    h('h1', { class: 'topbar-title' }, title),
    h('div', { class: 'topbar-actions' }, extra),
    currentSpace() &&
      h(
        'button',
        {
          class: 'icon-btn',
          'aria-label': 'Toggle member list',
          'aria-pressed': String(state.showMembers),
          title: 'Members',
          onclick: () => {
            if (matchMedia('(max-width: 1100px)').matches) return setPanel('members');
            state.showMembers = !state.showMembers;
            renderShell();
          },
        },
        icon('users'),
      ),
  );
}

function renderMain() {
  const main = document.getElementById('main');
  if (!main) return;
  const space = currentSpace();
  const ch = currentChannel();
  if (ch?.kind === 'text') return renderTextChannel(main, ch);

  // Rebuilding the view drops keyboard focus; put it back on the same control.
  const focusedLabel = main.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
  main.dataset.view = '';
  renderOtherView(main, space, ch);
  if (focusedLabel) main.querySelector(`[aria-label="${CSS.escape(focusedLabel)}"]`)?.focus();
}

function renderOtherView(main, space, ch) {
  if (!state.spaces.length) {
    main.replaceChildren(
      topbar('Welcome', null),
      h(
        'div',
        { class: 'empty' },
        h('h2', {}, 'You’re not in any spaces yet'),
        h('p', { class: 'muted' }, 'Start a meeting to get an invite link right away, or create a space for your team or friends.'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn btn-primary', onclick: quickMeeting }, 'Start a meeting'),
          h('button', { class: 'btn', onclick: showNewSpace }, 'More options'),
        ),
      ),
    );
    return;
  }
  if (!space) {
    main.replaceChildren(topbar('Loading…', null));
    return;
  }
  if (!ch) {
    main.replaceChildren(
      topbar(space.name, null),
      h('div', { class: 'empty' }, h('h2', {}, 'No channels'), h('p', { class: 'muted' }, canManage(space) ? 'Add a text or voice channel from the sidebar.' : 'An admin hasn’t added any channels yet.')),
    );
    return;
  }
  return renderVoiceChannel(main, ch);
}

function renderTextChannel(main, ch) {
  if (main.dataset.view !== `text:${ch.id}`) {
    main.dataset.view = `text:${ch.id}`;
    const composer = h('textarea', {
      id: 'composer',
      rows: 1,
      maxLength: 4000,
      placeholder: `Message #${ch.name}`,
      'aria-label': `Message #${ch.name}`,
    });
    let lastTyping = 0;
    composer.addEventListener('input', () => {
      composer.style.height = 'auto';
      composer.style.height = `${Math.min(composer.scrollHeight, 200)}px`;
      if (Date.now() - lastTyping > 3000 && composer.value.trim()) {
        lastTyping = Date.now();
        wsSend({ type: 'typing', channelId: ch.id });
      }
    });
    const sendMessage = async () => {
      const body = composer.value.trim();
      if (!body) return;
      composer.value = '';
      composer.style.height = 'auto';
      try {
        const { message } = await api.post(`/channels/${ch.id}/messages`, { body });
        const entry = state.messages.get(ch.id);
        if (entry && !entry.list.some((m) => m.id === message.id)) {
          entry.list.push(message);
          renderMessages(true);
        }
      } catch (err) {
        composer.value = body;
        fail(err);
      }
    };
    composer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    const log = h('div', { class: 'messages', id: 'messages', role: 'log', 'aria-live': 'polite', tabindex: '0' });
    log.addEventListener('scroll', async () => {
      const entry = state.messages.get(ch.id);
      if (log.scrollTop < 40 && entry && !entry.loadedAll && !entry.loading) {
        entry.loading = true;
        const prevHeight = log.scrollHeight;
        try {
          await loadMessages(ch.id, true);
          renderMessages(false);
          log.scrollTop = log.scrollHeight - prevHeight;
        } catch (err) {
          fail(err);
        } finally {
          entry.loading = false;
        }
      }
    });
    main.replaceChildren(
      topbar(ch.name, 'hash'),
      log,
      h('div', { class: 'typing', id: 'typing', 'aria-live': 'polite' }),
      h(
        'form',
        {
          class: 'composer',
          onsubmit: (e) => {
            e.preventDefault();
            sendMessage();
          },
        },
        composer,
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send'),
      ),
    );
    renderMessages(true);
  } else {
    main.querySelector('.topbar')?.replaceWith(topbar(ch.name, 'hash'));
  }
}

function renderMessages(stickToBottom) {
  const log = document.getElementById('messages');
  const entry = state.messages.get(state.channelId);
  if (!log) return;
  if (!entry) {
    log.replaceChildren(h('p', { class: 'muted pad' }, 'Loading messages…'));
    return;
  }
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const space = currentSpace();
  const items = [];
  if (entry.loadedAll) {
    items.push(
      h(
        'div',
        { class: 'chan-start' },
        h('h2', {}, `Welcome to #${currentChannel()?.name ?? ''}`),
        h('p', { class: 'muted' }, 'This is the start of the channel.'),
      ),
    );
  }
  let prev = null;
  for (const m of entry.list) {
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
    if (newDay) items.push(h('div', { class: 'day', role: 'separator' }, h('span', {}, formatDay(m.createdAt))));
    const grouped = !newDay && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60_000;
    const canDelete = m.authorId === state.user.id || canManage(space);
    items.push(
      h(
        'article',
        { class: `msg ${grouped ? 'grouped' : ''}` },
        grouped ? h('span', { class: 'msg-gutter' }) : avatar(m.authorName),
        h(
          'div',
          { class: 'msg-body' },
          !grouped &&
            h(
              'header',
              {},
              h('strong', { title: `@${m.authorUsername}` }, m.authorName),
              h('time', { datetime: new Date(m.createdAt).toISOString() }, formatTime(m.createdAt)),
            ),
          h('p', { class: 'msg-text' }, linkify(m.body)),
        ),
        canDelete &&
          h(
            'button',
            {
              class: 'icon-btn small msg-delete',
              'aria-label': 'Delete message',
              title: 'Delete message',
              onclick: async () => {
                if (!(await confirmDialog('Delete this message? This can’t be undone.', 'Delete'))) return;
                try {
                  await api.del(`/messages/${m.id}`);
                } catch (err) {
                  fail(err);
                }
              },
            },
            icon('trash'),
          ),
      ),
    );
    prev = m;
  }
  if (entry.list.length === 0 && entry.loadedAll) {
    items.push(h('p', { class: 'muted pad' }, 'No messages yet. Say hi.'));
  }
  log.replaceChildren(...items);
  if (stickToBottom || nearBottom) log.scrollTop = log.scrollHeight;
  renderTyping();
}

function showMessagesError(channelId) {
  document.getElementById('messages')?.replaceChildren(
    h(
      'div',
      { class: 'empty' },
      h('p', { class: 'muted' }, 'Couldn’t load messages.'),
      h('button', { class: 'btn', onclick: () => selectChannel(channelId, true) }, 'Try again'),
    ),
  );
}

function renderTyping() {
  const el = document.getElementById('typing');
  if (!el) return;
  const map = state.typing.get(state.channelId);
  const now = Date.now();
  const names = map ? [...map.values()].filter((t) => t.until > now).map((t) => t.name) : [];
  el.textContent =
    names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length <= 3 ? `${names.join(', ')} are typing…` : 'Several people are typing…';
}
setInterval(renderTyping, 1500);

function renderVoiceChannel(main, ch) {
  const inThisCall = state.call && (state.call.channelId === ch.id || state.call.pendingChannelId === ch.id);
  const peers = state.voice.get(ch.id) || [];

  if (!inThisCall) {
    main.replaceChildren(
      topbar(ch.name, 'speaker'),
      h(
        'div',
        { class: 'empty' },
        h('h2', {}, ch.name),
        h(
          'p',
          { class: 'muted' },
          peers.length === 0
            ? 'Nobody’s here yet. Join and others will see you in the channel list.'
            : `${peers.length} ${peers.length === 1 ? 'person is' : 'people are'} here: ${peers.map((p) => p.displayName).join(', ')}.`,
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn btn-primary btn-lg', onclick: () => joinCall(ch.id) }, state.call ? 'Switch to this call' : 'Join call'),
        ),
        h('p', { class: 'muted small' }, 'Your mic turns on when you join. Camera and screen sharing stay off until you choose them.'),
      ),
    );
    return;
  }

  const session = state.call.session;
  const self = {
    peerId: state.selfPeerId,
    displayName: `${state.user.displayName} (you)`,
    muted: session.muted,
    deafened: session.deafened,
    video: Boolean(session.camera),
    screen: Boolean(session.screen),
    self: true,
  };
  const others = peers.filter((p) => p.peerId !== state.selfPeerId);
  const everyone = [self, ...others];

  const tiles = [];
  for (const p of everyone) {
    const remote = p.self ? null : session.peers.get(p.peerId);
    if (p.screen) {
      const el = p.self ? session.localScreen : remote?.screenEl;
      tiles.push({ key: `${p.peerId}:screen`, peer: p, el, label: `${p.displayName} · screen`, screen: true });
    }
    const cam = p.video ? (p.self ? session.localVideo : remote?.cameraEl) : null;
    const status = !p.self && remote && remote.state !== 'connected' ? remote.state : null;
    tiles.push({ key: p.peerId, peer: p, el: cam, label: p.displayName, status, mirror: p.self });
  }

  const focused = tiles.find((t) => t.key === state.focusPeer) || null;
  const makeTile = (t, big = false) => {
    const tile = h(
      'figure',
      {
        class: `tile ${t.screen ? 'tile-screen' : ''} ${big ? 'tile-big' : ''} ${state.speaking.has(t.peer.peerId) && !t.screen ? 'speaking' : ''}`,
        dataset: t.screen ? {} : { peer: t.peer.peerId },
      },
      t.el ? t.el : h('div', { class: 'tile-avatar' }, avatar(t.peer.displayName.replace(' (you)', ''), 'avatar-lg')),
      h(
        'figcaption',
        {},
        h('span', {}, t.label),
        !t.screen && (t.peer.deafened ? icon('headphonesOff', 'Deafened') : t.peer.muted ? icon('micOff', 'Muted') : null),
        t.status && h('span', { class: 'tag' }, t.status === 'new' ? 'connecting' : t.status),
      ),
      h(
        'button',
        {
          class: 'icon-btn tile-focus',
          'aria-label': focused?.key === t.key ? 'Back to grid' : `Focus ${t.label}`,
          title: focused?.key === t.key ? 'Back to grid' : 'Focus',
          onclick: () => {
            state.focusPeer = focused?.key === t.key ? null : t.key;
            renderMain();
          },
        },
        icon(focused?.key === t.key ? 'x' : 'expand'),
      ),
    );
    if (t.el) {
      t.el.classList.toggle('mirror', Boolean(t.mirror));
      queueMicrotask(() => t.el.paused && t.el.play().catch(() => {}));
    }
    return tile;
  };

  const count = focused ? 1 : tiles.length;
  const cols = Math.min(Math.ceil(Math.sqrt(count)), matchMedia('(max-width: 760px)').matches ? 2 : 8);
  const stage = focused
    ? h(
        'div',
        { class: 'stage stage-focus' },
        makeTile(focused, true),
        h('div', { class: 'filmstrip' }, tiles.filter((t) => t !== focused).map((t) => makeTile(t))),
      )
    : h('div', { class: 'stage' }, tiles.map((t) => makeTile(t)));
  // CSSOM writes are allowed under the strict CSP; inline style attributes are not.
  if (!focused) stage.style.setProperty('--cols', String(cols));

  const btn = (label, iconName, pressed, onclick, extra = '') =>
    h('button', { class: `ctrl ${pressed ? 'on' : ''} ${extra}`, 'aria-pressed': pressed === null ? null : String(Boolean(pressed)), onclick }, icon(iconName), h('span', {}, label));

  main.replaceChildren(
    topbar(ch.name, 'speaker', [h('span', { class: 'muted small' }, `${everyone.length} in call · no time limit`)]),
    stage,
    h(
      'div',
      { class: 'controls', role: 'toolbar', 'aria-label': 'Call controls' },
      btn(session.muted ? 'Unmute' : 'Mute', session.muted ? 'micOff' : 'mic', session.muted, () => session.setMuted(!session.muted)),
      btn(session.deafened ? 'Undeafen' : 'Deafen', session.deafened ? 'headphonesOff' : 'headphones', session.deafened, () => session.setDeafened(!session.deafened)),
      btn(session.camera ? 'Stop video' : 'Start video', session.camera ? 'camera' : 'cameraOff', session.camera ? false : true, () => session.toggleCamera()),
      navigator.mediaDevices?.getDisplayMedia &&
        btn(session.screen ? 'Stop sharing' : 'Share screen', 'screen', null, () => session.toggleScreen(), session.screen ? 'sharing' : ''),
      btn('Invite', 'link', null, () => showCreateInvite(currentSpace())),
      btn('Leave', 'leave', null, () => leaveCall(), 'ctrl-leave'),
    ),
  );
}

function renderMembers() {
  const panel = document.querySelector('.members');
  if (!panel) return;
  const space = currentSpace();
  if (!space) return panel.replaceChildren();
  const order = { owner: 0, admin: 1, member: 2 };
  const sorted = [...space.members].sort((a, b) => order[a.role] - order[b.role] || a.displayName.localeCompare(b.displayName));
  const online = sorted.filter((m) => state.online.has(m.id));
  const offline = sorted.filter((m) => !state.online.has(m.id));
  const group = (label, list, isOnline) =>
    list.length > 0 &&
    h(
      'section',
      {},
      h('h3', {}, label, h('span', { class: 'count' }, list.length)),
      h(
        'ul',
        {},
        list.map((m) =>
          h(
            'li',
            { class: `member ${isOnline ? '' : 'offline'}` },
            h('span', { class: 'avatar-wrap' }, avatar(m.displayName), isOnline && h('span', { class: 'presence', title: 'Online' })),
            h('span', { class: 'member-name' }, m.displayName),
            m.role !== 'member' && h('span', { class: 'role' }, m.role),
          ),
        ),
      ),
    );
  panel.replaceChildren(
    h('header', { class: 'members-head only-narrow' }, h('h2', {}, 'Members'), h('button', { class: 'icon-btn', 'aria-label': 'Close members', onclick: () => setPanel(null) }, icon('x'))),
    ...[group('Online', online, true), group('Offline', offline, false)].filter(Boolean),
  );
}

function showCreateInvite(space) {
  if (!space) return;
  formDialog(
    `Invite people to ${space.name}`,
    [
      { name: 'expiresInHours', label: 'Link expires after', type: 'select', value: '168', options: [['1', '1 hour'], ['24', '1 day'], ['168', '7 days'], ['720', '30 days'], ['', 'Never']] },
      { name: 'maxUses', label: 'Max number of uses', type: 'select', value: '', options: [['', 'No limit'], ['1', '1 use'], ['5', '5 uses'], ['25', '25 uses'], ['100', '100 uses']] },
    ],
    'Create link',
    async (values) => {
      const { invite } = await api.post(`/spaces/${space.id}/invites`, {
        expiresInHours: values.expiresInHours ? Number(values.expiresInHours) : null,
        maxUses: values.maxUses ? Number(values.maxUses) : null,
      });
      setTimeout(() => showInviteLink(invite));
    },
  );
}

function showInviteLink(invite) {
  const link = `${location.origin}/i/${invite.code}`;
  const input = h('input', { type: 'text', readOnly: true, value: link, 'aria-label': 'Invite link' });
  const copy = h(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(link);
          copy.textContent = 'Copied';
        } catch {
          input.select();
          copy.textContent = 'Press Ctrl+C';
        }
      },
    },
    'Copy link',
  );
  const details = [
    invite.expiresAt ? `Expires ${formatTime(invite.expiresAt)}` : 'Never expires',
    invite.maxUses ? `${invite.maxUses} use${invite.maxUses === 1 ? '' : 's'}` : 'unlimited uses',
  ].join(' · ');
  openDialog(
    'Share this invite link',
    h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Anyone with the link can create an account and join. Only share it with people you trust.'), h('div', { class: 'row' }, input, copy), h('p', { class: 'muted small' }, details)),
  );
  input.select();
}

async function showInvite(code) {
  let preview;
  try {
    ({ invite: preview } = await api.get(`/invites/${encodeURIComponent(code)}`));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      state.pendingInvite = code;
      return renderAuth('register');
    }
    toast(err.message, 'error');
    return route();
  }
  if (preview.alreadyMember) {
    toast(`You’re already in ${preview.spaceName}.`);
    return selectSpace(preview.spaceId);
  }
  const { close } = openDialog(
    'You’ve been invited',
    h(
      'div',
      { class: 'stack center' },
      avatar(preview.spaceName, 'avatar-lg'),
      h('h3', {}, preview.spaceName),
      h('p', { class: 'muted' }, `${preview.memberCount} member${preview.memberCount === 1 ? '' : 's'}`),
      h(
        'div',
        { class: 'row-end' },
        h('button', { class: 'btn', onclick: () => close() }, 'Not now'),
        h(
          'button',
          {
            class: 'btn btn-primary',
            onclick: async () => {
              try {
                const { spaceId } = await api.post(`/invites/${encodeURIComponent(code)}/accept`);
                close();
                await loadSpaces();
                await selectSpace(spaceId);
              } catch (err) {
                fail(err);
              }
            },
          },
          `Join ${preview.spaceName}`,
        ),
      ),
    ),
    { onClose: () => !state.spaceId && route() },
  );
}

function showSpaceSettings(space) {
  const isOwner = space.role === 'owner';
  const admin = canManage(space);
  const rank = { member: 1, admin: 2, owner: 3 };
  const sections = [];

  if (admin) {
    const name = h('input', { value: space.name, maxLength: 64, required: true, 'aria-label': 'Space name' });
    sections.push(
      h(
        'form',
        {
          class: 'row',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api.patch(`/spaces/${space.id}`, { name: name.value });
              toast('Space renamed.');
            } catch (err) {
              fail(err);
            }
          },
        },
        name,
        h('button', { class: 'btn', type: 'submit' }, 'Rename'),
      ),
    );

    const chanList = h(
      'ul',
      { class: 'settings-list' },
      space.channels.map((c) =>
        h(
          'li',
          {},
          icon(c.kind === 'text' ? 'hash' : 'speaker'),
          h('span', { class: 'grow' }, c.name),
          h(
            'button',
            {
              class: 'btn btn-small',
              onclick: () =>
                formDialog('Rename channel', [{ name: 'name', label: 'Channel name', value: c.name, maxLength: 48 }], 'Save', async ({ name: n }) => {
                  await api.patch(`/channels/${c.id}`, { name: n });
                }),
            },
            'Rename',
          ),
          h(
            'button',
            {
              class: 'btn btn-small btn-danger-ghost',
              onclick: async () => {
                if (!(await confirmDialog(`Delete ${c.kind} channel “${c.name}”? ${c.kind === 'text' ? 'All its messages will be deleted.' : 'Anyone in the call will be disconnected.'}`, 'Delete channel'))) return;
                try {
                  await api.del(`/channels/${c.id}`);
                  close();
                } catch (err) {
                  fail(err);
                }
              },
            },
            'Delete',
          ),
        ),
      ),
    );
    sections.push(h('h3', {}, 'Channels'), chanList);
  }

  const memberList = h(
    'ul',
    { class: 'settings-list' },
    space.members.map((m) => {
      const isSelf = m.id === state.user.id;
      const canRemove = admin && !isSelf && rank[m.role] < rank[space.role];
      let roleControl = h('span', { class: 'role' }, m.role);
      if (isOwner && !isSelf) {
        roleControl = h(
          'select',
          {
            'aria-label': `Role for ${m.displayName}`,
            onchange: async (e) => {
              const role = e.target.value;
              if (role === 'owner' && !(await confirmDialog(`Make ${m.displayName} the owner? You’ll become an admin.`, 'Transfer ownership'))) {
                e.target.value = m.role;
                return;
              }
              try {
                await api.patch(`/spaces/${space.id}/members/${m.id}`, { role });
                if (role === 'owner') close();
              } catch (err) {
                e.target.value = m.role;
                fail(err);
              }
            },
          },
          ['member', 'admin', 'owner'].map((r) => h('option', { value: r, selected: r === m.role }, r)),
        );
      }
      return h(
        'li',
        {},
        avatar(m.displayName, 'avatar-xs'),
        h('span', { class: 'grow' }, m.displayName, h('span', { class: 'muted small' }, ` @${m.username}`)),
        roleControl,
        canRemove &&
          h(
            'button',
            {
              class: 'btn btn-small',
              onclick: async () => {
                if (!(await confirmDialog(`Remove ${m.displayName} from ${space.name}? They can rejoin with an invite.`, 'Remove'))) return;
                try {
                  await api.del(`/spaces/${space.id}/members/${m.id}`);
                  close();
                } catch (err) {
                  fail(err);
                }
              },
            },
            'Remove',
          ),
        canRemove &&
          h(
            'button',
            {
              class: 'btn btn-small btn-danger-ghost',
              onclick: async () => {
                if (!(await confirmDialog(`Ban ${m.displayName}? They’ll be removed and can’t rejoin with any invite.`, 'Ban'))) return;
                try {
                  await api.del(`/spaces/${space.id}/members/${m.id}?ban=1`);
                  close();
                } catch (err) {
                  fail(err);
                }
              },
            },
            'Ban',
          ),
      );
    }),
  );
  sections.push(h('h3', {}, 'Members ', h('span', { class: 'count' }, space.members.length)), memberList);

  if (admin) {
    const invitesList = h('ul', { class: 'settings-list' }, h('li', { class: 'muted' }, 'Loading invites…'));
    api
      .get(`/spaces/${space.id}/invites`)
      .then(({ invites }) => {
        invitesList.replaceChildren(
          ...(invites.length === 0
            ? [h('li', { class: 'muted' }, 'No invite links yet.')]
            : invites.map((inv) => {
                const expired = (inv.expiresAt && inv.expiresAt < Date.now()) || (inv.maxUses && inv.uses >= inv.maxUses);
                return h(
                  'li',
                  {},
                  h('code', { class: 'grow' }, `…${inv.code.slice(-6)}`),
                  h('span', { class: 'muted small' }, `${inv.uses}${inv.maxUses ? `/${inv.maxUses}` : ''} ${(inv.maxUses ?? inv.uses) === 1 ? 'use' : 'uses'} · ${expired ? 'expired' : inv.expiresAt ? `until ${formatTime(inv.expiresAt)}` : 'no expiry'} · by ${inv.createdBy}`),
                  h(
                    'button',
                    {
                      class: 'btn btn-small btn-danger-ghost',
                      onclick: async (e) => {
                        try {
                          await api.del(`/invites/${inv.code}`);
                          e.target.closest('li').remove();
                        } catch (err) {
                          fail(err);
                        }
                      },
                    },
                    'Revoke',
                  ),
                );
              })),
        );
      })
      .catch(fail);
    sections.push(h('h3', {}, 'Invite links'), invitesList);
  }

  sections.push(
    h(
      'div',
      { class: 'danger-zone' },
      isOwner
        ? h(
            'button',
            {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!(await confirmDialog(`Delete ${space.name} for everyone? All channels and messages will be gone.`, 'Delete space', { requireText: space.name }))) return;
                try {
                  await api.del(`/spaces/${space.id}`);
                  close();
                } catch (err) {
                  fail(err);
                }
              },
            },
            'Delete space',
          )
        : h(
            'button',
            {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!(await confirmDialog(`Leave ${space.name}? You’ll need a new invite to come back.`, 'Leave space'))) return;
                try {
                  await api.post(`/spaces/${space.id}/leave`);
                  close();
                } catch (err) {
                  fail(err);
                }
              },
            },
            'Leave space',
          ),
    ),
  );

  const { close } = openDialog(admin ? `${space.name} settings` : space.name, h('div', { class: 'stack' }, sections), { wide: true });
}

function showUserSettings() {
  const name = h('input', { value: state.user.displayName, maxLength: 48, required: true, 'aria-label': 'Display name' });
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxLength: 200 });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10, maxLength: 200 });
  const theme = h(
    'select',
    {
      'aria-label': 'Theme',
      onchange: (e) => {
        applyTheme(e.target.value, true);
        renderSidebar();
      },
    },
    [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: v === currentTheme() }, l)),
  );
  const { close } = openDialog(
    'Your settings',
    h(
      'div',
      { class: 'stack' },
      h('h3', {}, 'Display name'),
      h(
        'form',
        {
          class: 'row',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const { user } = await api.patch('/me', { displayName: name.value });
              state.user = user;
              renderShell();
              toast('Display name updated.');
            } catch (err) {
              fail(err);
            }
          },
        },
        name,
        h('button', { class: 'btn', type: 'submit' }, 'Save'),
      ),
      h('h3', {}, 'Appearance'),
      theme,
      h('h3', {}, 'Change password'),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api.post('/me/password', { currentPassword: current.value, newPassword: next.value });
              current.value = next.value = '';
              toast('Password changed. Other devices were signed out.');
            } catch (err) {
              fail(err);
            }
          },
        },
        h('label', { class: 'field' }, h('span', {}, 'Current password'), current),
        h('label', { class: 'field' }, h('span', {}, 'New password'), next, h('small', {}, 'At least 10 characters. Changing it signs out your other devices.')),
        h('div', { class: 'row-end' }, h('button', { class: 'btn', type: 'submit' }, 'Change password')),
      ),
      h(
        'div',
        { class: 'danger-zone' },
        h(
          'button',
          {
            class: 'btn btn-danger',
            onclick: async () => {
              close();
              try {
                await api.post('/auth/logout');
              } catch {
                // Signing out locally is still correct if the server is unreachable.
              }
              signedOut();
            },
          },
          'Sign out',
        ),
      ),
    ),
  );
}

// Current theme -> [next theme, label, icon]
const THEMES = {
  system: ['light', 'Theme: match system', 'auto'],
  light: ['dark', 'Theme: light', 'sun'],
  dark: ['system', 'Theme: dark', 'moon'],
};

function themeButton() {
  const theme = currentTheme();
  const [, label, iconName] = THEMES[theme];
  return h(
    'button',
    {
      class: 'icon-btn',
      'aria-label': `${label}. Switch theme`,
      title: `${label}. Click to switch.`,
      onclick: () => {
        applyTheme(THEMES[theme][0], true);
        renderSidebar();
        document.querySelector('.me [aria-label$="Switch theme"]')?.focus();
      },
    },
    icon(iconName),
  );
}

function currentTheme() {
  try {
    return localStorage.getItem('callme-theme') || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme, save = false) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  if (save) {
    try {
      localStorage.setItem('callme-theme', theme);
    } catch {
      // Theme just won't persist.
    }
  }
}

async function boot() {
  applyTheme(currentTheme());
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'i' && parts[1]) state.pendingInvite = parts[1];
  try {
    const { user } = await api.get('/session');
    if (user) return await signedIn(user);
    renderAuth(state.pendingInvite ? 'register' : 'login');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      app.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Can’t reach Call-me'), h('p', { class: 'muted' }, err.message), h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Try again')));
      return;
    }
    renderAuth(state.pendingInvite ? 'register' : 'login');
  }
}

boot();
