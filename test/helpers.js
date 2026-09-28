import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

export const ORIGIN = 'http://callme.test';

export async function startServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callme-test-'));
  const config = loadConfig({
    port: 0,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'test.db'),
    allowedOrigins: [ORIGIN],
    iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
    ...overrides,
    rateLimits: {
      auth: { capacity: 1000, refillPerSec: 1000 },
      api: { capacity: 10000, refillPerSec: 10000 },
      ws: { capacity: 10000, refillPerSec: 10000 },
      ...(overrides.rateLimits || {}),
    },
  });
  const app = createApp(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    dbPath: config.dbPath,
    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export class Client {
  constructor(srv) {
    this.srv = srv;
    this.cookie = null;
    this.user = null;
  }

  async req(method, url, body, { origin = ORIGIN, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (origin) init.headers.Origin = origin;
    if (this.cookie) init.headers.Cookie = this.cookie;
    if (body !== undefined) {
      if (typeof body === 'string') init.body = body;
      else {
        init.headers['Content-Type'] ??= 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(this.srv.base + url, init);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      this.cookie = pair.endsWith('=') ? null : pair;
      this.lastSetCookie = setCookie;
    }
    if (raw) return res;
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  get(url, opts) {
    return this.req('GET', url, undefined, opts);
  }
  post(url, body = {}, opts) {
    return this.req('POST', url, body, opts);
  }
  patch(url, body = {}, opts) {
    return this.req('PATCH', url, body, opts);
  }
  del(url, opts) {
    return this.req('DELETE', url, undefined, opts);
  }

  async register(username, password = 'a-long-password-123', displayName) {
    const r = await this.post('/api/auth/register', { username, password, displayName });
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.data)}`);
    this.user = r.data.user;
    return this;
  }

  socket({ origin = ORIGIN, cookie = this.cookie } = {}) {
    return openSocket(this.srv.wsUrl, { origin, cookie });
  }
}

export function openSocket(url, { origin, cookie }) {
  return new Promise((resolve, reject) => {
    const headers = cookie ? { Cookie: cookie } : {};
    const ws = new WebSocket(url, { origin, headers });
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else inbox.push(msg);
    });
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    ws.once('error', reject);
    ws.once('open', () => {
      ws.sendJson = (m) => ws.send(JSON.stringify(m));
      ws.inbox = inbox;
      ws.next = (pred, ms = 2000) => {
        const match = typeof pred === 'string' ? (m) => m.type === pred : pred;
        const i = inbox.findIndex(match);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred: match, resolve: res };
          w.timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            rej(new Error(`timed out waiting for ${typeof pred === 'string' ? pred : 'message'}`));
          }, ms);
          waiters.push(w);
        });
      };
      // Resolves true if no matching message arrives within ms.
      ws.none = async (pred, ms = 300) => {
        try {
          await ws.next(pred, ms);
          return false;
        } catch {
          return true;
        }
      };
      ws.closed = new Promise((res) => ws.once('close', (code) => res(code)));
      resolve(ws);
    });
  });
}

export async function spaceWithMembers(owner, ...others) {
  const { data } = await owner.post('/api/spaces', { name: 'Test space' });
  const spaceId = data.space.id;
  const detail = (await owner.get(`/api/spaces/${spaceId}`)).data.space;
  const invite = (await owner.post(`/api/spaces/${spaceId}/invites`, {})).data.invite;
  for (const c of others) {
    const r = await c.post(`/api/invites/${invite.code}/accept`);
    if (r.status !== 200) throw new Error(`accept failed ${r.status}`);
  }
  return {
    spaceId,
    textId: detail.channels.find((c) => c.kind === 'text').id,
    voiceId: detail.channels.find((c) => c.kind === 'voice').id,
    invite,
  };
}
