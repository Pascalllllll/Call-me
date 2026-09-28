import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { SESSION_COOKIE, parseCookies } from './auth.js';
import { createRateLimiter, isAllowedOrigin } from './security.js';

const MAX_WS_MESSAGE = 128 * 1024;
const MAX_SIGNAL_BYTES = 64 * 1024;
const HEARTBEAT_MS = 30_000;
const SESSION_RECHECK_MS = 60_000;
// Messages that fan out to a whole space cost more than 1:1 signaling.
const MESSAGE_COST = { 'voice.join': 20, 'voice.update': 10, typing: 20 };

function iceServersFor(config, userId) {
  if (!config.turn) return config.iceServers;
  const { urls, secret, ttlSec } = config.turn;
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return [...config.iceServers, { urls, username, credential }];
}

export function createRealtime({ server, config, sessions, store }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE, perMessageDeflate: false });
  const limiter = createRateLimiter(config.rateLimits.ws);

  /** userId -> Set<Client> */
  const clientsByUser = new Map();
  /** peerId -> Client */
  const clientsByPeer = new Map();
  /** channelId -> { spaceId, peers: Set<peerId> } */
  const rooms = new Map();
  let shuttingDown = false;

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      return reject(400, 'Bad Request');
    }
    if (pathname !== '/ws') return reject(404, 'Not Found');
    // Browsers always send Origin on WebSocket handshakes; this blocks cross-site WebSocket hijacking.
    if (!isAllowedOrigin(config, req.headers.origin)) return reject(403, 'Forbidden');
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = sessions.resolve(token);
    if (!user) return reject(401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
  });

  function send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  function sendToUser(userId, msg) {
    for (const c of clientsByUser.get(userId) || []) send(c, msg);
  }

  function sendToUsers(userIds, msg) {
    const data = JSON.stringify(msg);
    for (const id of userIds) {
      for (const c of clientsByUser.get(id) || []) if (c.ws.readyState === 1) c.ws.send(data);
    }
  }

  function toSpace(spaceId, msg) {
    sendToUsers(store.memberIds(spaceId), msg);
  }

  function publicPeer(c) {
    return {
      peerId: c.peerId,
      userId: c.user.id,
      displayName: c.user.displayName,
      muted: c.voice.muted,
      deafened: c.voice.deafened,
      video: c.voice.video,
      screen: c.voice.screen,
    };
  }

  function roomState(channelId) {
    const room = rooms.get(channelId);
    if (!room) return [];
    return [...room.peers].map((p) => publicPeer(clientsByPeer.get(p)));
  }

  function broadcastRoom(channelId, spaceId) {
    toSpace(spaceId, { type: 'voice.state', channelId, spaceId, peers: roomState(channelId) });
  }

  function leaveVoice(client, reason) {
    const channelId = client.voice.channelId;
    if (!channelId) return;
    const room = rooms.get(channelId);
    client.voice = { channelId: null, muted: false, deafened: false, video: false, screen: false };
    if (!room) return;
    room.peers.delete(client.peerId);
    for (const p of room.peers) send(clientsByPeer.get(p), { type: 'voice.peer-left', peerId: client.peerId });
    if (reason) send(client, { type: 'voice.left', channelId, reason });
    if (room.peers.size === 0) rooms.delete(channelId);
    broadcastRoom(channelId, room.spaceId);
  }

  function joinVoice(client, channelId) {
    let ch;
    try {
      ch = store.channelFor(channelId, client.user.id);
    } catch {
      return send(client, { type: 'error', error: 'Channel not found' });
    }
    if (ch.kind !== 'voice') return send(client, { type: 'error', error: 'Not a voice channel' });
    if (client.voice.channelId === channelId) return;

    // One active call per user, like Discord: joining here moves the user out of any other call.
    for (const other of clientsByUser.get(client.user.id) || []) {
      if (other.voice.channelId) leaveVoice(other, other === client ? null : 'joined-elsewhere');
    }

    let room = rooms.get(channelId);
    if (!room) {
      room = { spaceId: ch.spaceId, peers: new Set() };
      rooms.set(channelId, room);
    }
    const existing = roomState(channelId);
    room.peers.add(client.peerId);
    client.voice.channelId = channelId;

    // The newcomer creates the offers; existing peers just wait for them.
    send(client, { type: 'voice.joined', channelId, spaceId: ch.spaceId, selfPeerId: client.peerId, peers: existing });
    for (const p of existing) send(clientsByPeer.get(p.peerId), { type: 'voice.peer-joined', peer: publicPeer(client) });
    broadcastRoom(channelId, ch.spaceId);
  }

  function relaySignal(client, msg) {
    const target = typeof msg.to === 'string' ? clientsByPeer.get(msg.to) : null;
    // Signals only flow between peers that are in the same call right now.
    if (!target || !client.voice.channelId || target.voice.channelId !== client.voice.channelId) return;
    if (!msg.data || typeof msg.data !== 'object') return;
    const data = {};
    if (msg.data.description && typeof msg.data.description === 'object') {
      const { type, sdp } = msg.data.description;
      if (!['offer', 'answer'].includes(type) || typeof sdp !== 'string') return;
      data.description = { type, sdp };
    }
    if (msg.data.candidate && typeof msg.data.candidate === 'object') {
      const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = msg.data.candidate;
      if (typeof candidate !== 'string') return;
      data.candidate = { candidate, sdpMid, sdpMLineIndex, usernameFragment };
    }
    if (!data.description && !data.candidate) return;
    if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) return;
    send(target, { type: 'signal', from: client.peerId, data });
  }

  function updateVoice(client, msg) {
    if (!client.voice.channelId) return;
    for (const key of ['muted', 'deafened', 'video', 'screen']) {
      if (typeof msg[key] === 'boolean') client.voice[key] = msg[key];
    }
    broadcastRoom(client.voice.channelId, rooms.get(client.voice.channelId).spaceId);
  }

  function onlineAmong(userIds) {
    return userIds.filter((id) => clientsByUser.has(id));
  }

  function onConnection(ws, user) {
    const client = {
      ws,
      user,
      peerId: crypto.randomUUID(),
      alive: true,
      voice: { channelId: null, muted: false, deafened: false, video: false, screen: false },
    };
    clientsByPeer.set(client.peerId, client);
    const firstConnection = !clientsByUser.has(user.id);
    if (firstConnection) clientsByUser.set(user.id, new Set());
    clientsByUser.get(user.id).add(client);

    const coMembers = store.coMemberIds(user.id);
    if (firstConnection) sendToUsers(coMembers, { type: 'presence', userId: user.id, online: true });

    const voice = [];
    for (const s of store.spacesForUser(user.id)) {
      for (const [channelId, room] of rooms) {
        if (room.spaceId === s.id) voice.push({ channelId, spaceId: s.id, peers: roomState(channelId) });
      }
    }
    send(client, {
      type: 'hello',
      peerId: client.peerId,
      online: onlineAmong(coMembers),
      voice,
      iceServers: iceServersFor(config, user.id),
    });

    // Without a listener, protocol errors (e.g. oversized frames) would crash the process.
    ws.on('error', () => ws.terminate());

    ws.on('pong', () => {
      client.alive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(1003, 'Binary not supported');
      if (!limiter.take(client.peerId, 1)) return send(client, { type: 'error', error: 'Slow down' });
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const cost = MESSAGE_COST[msg.type];
      if (cost && !limiter.take(client.peerId, cost)) return send(client, { type: 'error', error: 'Slow down' });
      switch (msg.type) {
        case 'voice.join':
          if (typeof msg.channelId === 'string') joinVoice(client, msg.channelId);
          break;
        case 'voice.leave':
          leaveVoice(client, null);
          break;
        case 'voice.update':
          updateVoice(client, msg);
          break;
        case 'signal':
          relaySignal(client, msg);
          break;
        case 'typing':
          if (typeof msg.channelId === 'string') {
            try {
              const ch = store.channelFor(msg.channelId, user.id);
              toSpace(ch.spaceId, { type: 'typing', channelId: ch.id, userId: user.id, displayName: user.displayName });
            } catch {
              // Ignore typing events for channels the user cannot see.
            }
          }
          break;
        case 'ping':
          send(client, { type: 'pong' });
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (shuttingDown) return;
      leaveVoice(client, null);
      clientsByPeer.delete(client.peerId);
      const set = clientsByUser.get(user.id);
      set?.delete(client);
      if (set && set.size === 0) {
        clientsByUser.delete(user.id);
        sendToUsers(store.coMemberIds(user.id), { type: 'presence', userId: user.id, online: false });
      }
    });
  }

  const heartbeat = setInterval(() => {
    for (const c of clientsByPeer.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Sockets outlive the HTTP request that opened them, so re-validate sessions periodically.
  const recheck = setInterval(() => {
    for (const c of clientsByPeer.values()) {
      if (!sessions.resolveHash(c.user.tokenHash)) c.ws.close(4001, 'Session ended');
    }
  }, SESSION_RECHECK_MS);
  recheck.unref();

  return {
    toSpace,
    sendToUser,
    /** Syncs presence and live call state when a user joins a space mid-session. */
    memberJoined(userId, spaceId) {
      const memberIds = store.memberIds(spaceId);
      if (clientsByUser.has(userId)) toSpace(spaceId, { type: 'presence', userId, online: true });
      const voice = [];
      for (const [channelId, room] of rooms) {
        if (room.spaceId === spaceId) voice.push({ channelId, spaceId, peers: roomState(channelId) });
      }
      sendToUser(userId, { type: 'space.sync', spaceId, online: onlineAmong(memberIds), voice });
    },
    /** Called after a user loses access to a space (left, kicked, banned, or space deleted). */
    revokeSpace(userId, spaceId) {
      for (const c of clientsByUser.get(userId) || []) {
        const room = c.voice.channelId && rooms.get(c.voice.channelId);
        if (room && room.spaceId === spaceId) leaveVoice(c, 'removed');
      }
    },
    closeChannel(channelId) {
      const room = rooms.get(channelId);
      if (!room) return;
      for (const p of [...room.peers]) leaveVoice(clientsByPeer.get(p), 'channel-deleted');
    },
    renameUser(userId, displayName) {
      for (const c of clientsByUser.get(userId) || []) {
        c.user = { ...c.user, displayName };
        if (c.voice.channelId) broadcastRoom(c.voice.channelId, rooms.get(c.voice.channelId).spaceId);
      }
    },
    disconnectSession(tokenHash) {
      for (const c of clientsByPeer.values()) if (c.user.tokenHash === tokenHash) c.ws.close(4001, 'Session ended');
    },
    disconnectUser(userId, exceptTokenHash) {
      for (const c of clientsByUser.get(userId) || []) {
        if (c.user.tokenHash !== exceptTokenHash) c.ws.close(4001, 'Session ended');
      }
    },
    close() {
      shuttingDown = true;
      clearInterval(heartbeat);
      clearInterval(recheck);
      limiter.stop();
      for (const c of clientsByPeer.values()) c.ws.terminate();
      wss.close();
    },
  };
}
