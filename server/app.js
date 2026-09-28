import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  SESSION_COOKIE,
  burnPasswordCheck,
  createSessionStore,
  hashPassword,
  parseCookies,
  verifyPassword,
} from './auth.js';
import { openDatabase } from './db.js';
import { createRealtime } from './realtime.js';
import { clientIp, createRateLimiter, requireSameOrigin, securityHeaders } from './security.js';
import { createStore } from './store.js';
import * as v from './validate.js';
import { HttpError } from './validate.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(config) {
  const db = openDatabase(config.dbPath);
  const store = createStore(db);
  const sessions = createSessionStore(db, config.sessionTtlMs);
  const authLimiter = createRateLimiter(config.rateLimits.auth);
  const apiLimiter = createRateLimiter(config.rateLimits.api);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.set('etag', false);

  const server = http.createServer(app);
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  const rt = createRealtime({ server, config, sessions, store });

  app.use(securityHeaders(config));

  // Uptime probe for hosting platforms; touches the database so a broken volume shows up.
  const ping = db.prepare('SELECT 1');
  app.get('/healthz', (req, res) => {
    ping.get();
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send('ok');
  });

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      dotfiles: 'deny',
      redirect: false,
      setHeaders(res, file) {
        res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-store' : 'no-cache');
      },
    }),
  );

  const api = express.Router();
  app.use('/api', api);

  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!apiLimiter.take(clientIp(req, config))) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    next();
  });
  api.use(requireSameOrigin(config));
  api.use(express.json({ limit: '32kb', strict: true }));

  const setSessionCookie = (res, token) => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookies,
      path: '/',
      maxAge: config.sessionTtlMs,
    });
  };
  const clearSessionCookie = (res) =>
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/' });

  const auth = (req, res, next) => {
    const user = sessions.resolve(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    req.user = user;
    next();
  };

  const authRateLimit = (req, res, next) => {
    if (!authLimiter.take(clientIp(req, config))) {
      return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    next();
  };

  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });


  api.post('/auth/register', authRateLimit, async (req, res) => {
    const b = body(req);
    const username = v.username(b.username);
    const password = v.password(b.password);
    const displayName = v.text(b.displayName ?? username, 'Display name', { max: 48 });
    const user = store.createUser(username, displayName, await hashPassword(password));
    setSessionCookie(res, sessions.create(user.id));
    res.status(201).json({ user: publicUser(user) });
  });

  api.post('/auth/login', authRateLimit, async (req, res) => {
    const b = body(req);
    const failed = () => res.status(401).json({ error: 'Wrong username or password' });
    if (typeof b.username !== 'string' || typeof b.password !== 'string' || b.password.length > 200) return failed();
    const row = store.userByName(b.username);
    if (!row) {
      await burnPasswordCheck(b.password);
      return failed();
    }
    if (!(await verifyPassword(b.password, row.password_hash))) return failed();
    setSessionCookie(res, sessions.create(row.id));
    res.json({ user: publicUser({ id: row.id, username: row.username, displayName: row.display_name }) });
  });

  api.post('/auth/logout', auth, (req, res) => {
    sessions.destroy(req.user.tokenHash);
    rt.disconnectSession(req.user.tokenHash);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  api.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  // Lets the client check sign-in state on load without a 401 in the console.
  api.get('/session', (req, res) => {
    const user = sessions.resolve(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.json({ user: user ? publicUser(user) : null });
  });

  api.patch('/me', auth, (req, res) => {
    const displayName = v.text(body(req).displayName, 'Display name', { max: 48 });
    store.setDisplayName(req.user.id, displayName);
    rt.renameUser(req.user.id, displayName);
    res.json({ user: { ...publicUser(req.user), displayName } });
  });

  api.post('/me/password', auth, authRateLimit, async (req, res) => {
    const b = body(req);
    const next = v.password(b.newPassword, 'New password');
    if (typeof b.currentPassword !== 'string' || !(await verifyPassword(b.currentPassword, store.passwordHash(req.user.id)))) {
      throw new HttpError(403, 'Current password is wrong');
    }
    store.setPassword(req.user.id, await hashPassword(next));
    sessions.destroyAllForUser(req.user.id);
    rt.disconnectUser(req.user.id, null);
    setSessionCookie(res, sessions.create(req.user.id));
    res.json({ ok: true });
  });


  api.get('/spaces', auth, (req, res) => res.json({ spaces: store.spacesForUser(req.user.id) }));

  api.post('/spaces', auth, (req, res) => {
    const name = v.text(body(req).name, 'Space name', { max: 64 });
    res.status(201).json({ space: store.createSpace(req.user.id, name) });
  });

  api.post('/meetings', auth, (req, res) => {
    const raw = body(req).name;
    const name = raw ? v.text(raw, 'Meeting name', { max: 64 }) : `${req.user.displayName}'s meeting`;
    res.status(201).json(store.quickMeeting(req.user.id, name));
  });

  api.get('/spaces/:spaceId', auth, (req, res) => {
    res.json({ space: store.spaceDetail(v.id(req.params.spaceId, 'space'), req.user.id) });
  });

  api.patch('/spaces/:spaceId', auth, (req, res) => {
    const spaceId = v.id(req.params.spaceId, 'space');
    const name = v.text(body(req).name, 'Space name', { max: 64 });
    store.renameSpace(spaceId, req.user.id, name);
    rt.toSpace(spaceId, { type: 'space.updated', spaceId, name });
    res.json({ ok: true });
  });

  api.delete('/spaces/:spaceId', auth, (req, res) => {
    const spaceId = v.id(req.params.spaceId, 'space');
    store.requireRole(spaceId, req.user.id, 'owner');
    const memberIds = store.memberIds(spaceId);
    for (const uid of memberIds) rt.revokeSpace(uid, spaceId);
    store.deleteSpace(spaceId, req.user.id);
    for (const uid of memberIds) rt.sendToUser(uid, { type: 'space.removed', spaceId });
    res.json({ ok: true });
  });

  api.post('/spaces/:spaceId/leave', auth, (req, res) => {
    const spaceId = v.id(req.params.spaceId, 'space');
    store.leaveSpace(spaceId, req.user.id);
    rt.revokeSpace(req.user.id, spaceId);
    rt.sendToUser(req.user.id, { type: 'space.removed', spaceId });
    rt.toSpace(spaceId, { type: 'member.removed', spaceId, userId: req.user.id });
    res.json({ ok: true });
  });

  api.patch('/spaces/:spaceId/members/:userId', auth, (req, res) => {
    const spaceId = v.id(req.params.spaceId, 'space');
    const userId = v.id(req.params.userId, 'member');
    const role = v.oneOf(body(req).role, 'Role', ['member', 'admin', 'owner']);
    store.setRole(spaceId, req.user.id, userId, role);
    rt.toSpace(spaceId, { type: 'members.changed', spaceId });
    res.json({ ok: true });
  });

  api.delete('/spaces/:spaceId/members/:userId', auth, (req, res) => {
    const spaceId = v.id(req.params.spaceId, 'space');
    const userId = v.id(req.params.userId, 'member');
    const ban = req.query.ban === '1';
    store.removeMember(spaceId, req.user.id, userId, ban);
    rt.revokeSpace(userId, spaceId);
    rt.sendToUser(userId, { type: 'space.removed', spaceId, reason: ban ? 'banned' : 'kicked' });
    rt.toSpace(spaceId, { type: 'member.removed', spaceId, userId });
    res.json({ ok: true });
  });


  api.post('/spaces/:spaceId/channels', auth, (req, res) => {
    const spaceId = v.id(req.params.spaceId, 'space');
    const b = body(req);
    const kind = v.oneOf(b.kind, 'Channel type', ['text', 'voice']);
    const name = v.text(b.name, 'Channel name', { max: 48 });
    const channel = store.createChannel(spaceId, req.user.id, name, kind);
    rt.toSpace(spaceId, { type: 'channel.created', channel });
    res.status(201).json({ channel });
  });

  api.patch('/channels/:channelId', auth, (req, res) => {
    const name = v.text(body(req).name, 'Channel name', { max: 48 });
    const channel = store.renameChannel(v.id(req.params.channelId, 'channel'), req.user.id, name);
    rt.toSpace(channel.spaceId, { type: 'channel.updated', channel });
    res.json({ channel });
  });

  api.delete('/channels/:channelId', auth, (req, res) => {
    const channelId = v.id(req.params.channelId, 'channel');
    store.channelFor(channelId, req.user.id, 'admin');
    rt.closeChannel(channelId);
    const ch = store.deleteChannel(channelId, req.user.id);
    rt.toSpace(ch.spaceId, { type: 'channel.deleted', spaceId: ch.spaceId, channelId });
    res.json({ ok: true });
  });

  api.get('/channels/:channelId/messages', auth, (req, res) => {
    const before = v.optionalInt(req.query.before, 'before', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? Date.now() + 1;
    const limit = v.optionalInt(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 50;
    res.json({ messages: store.listMessages(v.id(req.params.channelId, 'channel'), req.user.id, before, limit) });
  });

  api.post('/channels/:channelId/messages', auth, (req, res) => {
    const text = v.text(body(req).body, 'Message', { max: 4000, multiline: true });
    const { spaceId, msg } = store.postMessage(v.id(req.params.channelId, 'channel'), req.user, text);
    rt.toSpace(spaceId, { type: 'message.created', spaceId, message: msg });
    res.status(201).json({ message: msg });
  });

  api.delete('/messages/:messageId', auth, (req, res) => {
    const msg = store.deleteMessage(v.id(req.params.messageId, 'message'), req.user.id);
    rt.toSpace(msg.spaceId, { type: 'message.deleted', channelId: msg.channelId, messageId: msg.id });
    res.json({ ok: true });
  });


  api.post('/spaces/:spaceId/invites', auth, (req, res) => {
    const spaceId = v.id(req.params.spaceId, 'space');
    const b = body(req);
    const invite = store.createInvite(spaceId, req.user.id, {
      expiresInHours: v.optionalInt(b.expiresInHours, 'Expiry (hours)', { min: 1, max: 24 * 365 }),
      maxUses: v.optionalInt(b.maxUses, 'Max uses', { min: 1, max: 100_000 }),
    });
    res.status(201).json({ invite });
  });

  api.get('/spaces/:spaceId/invites', auth, (req, res) => {
    res.json({ invites: store.listInvites(v.id(req.params.spaceId, 'space'), req.user.id) });
  });

  api.delete('/invites/:code', auth, (req, res) => {
    store.revokeInvite(v.inviteCode(req.params.code), req.user.id);
    res.json({ ok: true });
  });

  api.get('/invites/:code', auth, (req, res) => {
    res.json({ invite: store.previewInvite(v.inviteCode(req.params.code), req.user.id) });
  });

  api.post('/invites/:code/accept', auth, (req, res) => {
    const result = store.acceptInvite(v.inviteCode(req.params.code), req.user.id);
    if (result.joined) {
      rt.toSpace(result.spaceId, {
        type: 'member.added',
        spaceId: result.spaceId,
        member: store.member(result.spaceId, req.user.id),
      });
      rt.memberJoined(req.user.id, result.spaceId);
    }
    res.json(result);
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Invite links (/i/<code>) and other client routes are served by the single-page app.
  app.get(['/i/:code', '/app', '/app/*rest'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  // Never leak stack traces or internal messages to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.status && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'Bad request' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  const purge = setInterval(() => sessions.purgeExpired(), 3600_000);
  purge.unref();

  return {
    server,
    async close() {
      clearInterval(purge);
      authLimiter.stop();
      apiLimiter.stop();
      rt.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
