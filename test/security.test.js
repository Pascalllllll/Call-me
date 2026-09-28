import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { Client, ORIGIN, spaceWithMembers, startServer } from './helpers.js';

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

function rawHttp(path) {
  const { port } = new URL(srv.base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
  });
}

describe('HTTP hardening', () => {
  test('security headers on pages and API', async () => {
    for (const url of ['/', '/api/me', '/i/abc']) {
      const res = await fetch(srv.base + url);
      const hdr = res.headers;
      assert.match(hdr.get('content-security-policy'), /default-src 'none'/);
      assert.match(hdr.get('content-security-policy'), /script-src 'self'(;|$)/);
      assert.match(hdr.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.doesNotMatch(hdr.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
      assert.equal(hdr.get('x-frame-options'), 'DENY');
      assert.equal(hdr.get('x-content-type-options'), 'nosniff');
      assert.equal(hdr.get('referrer-policy'), 'no-referrer');
      assert.equal(hdr.get('x-powered-by'), null);
    }
  });

  test('HSTS only in production', async () => {
    assert.equal((await fetch(srv.base + '/')).headers.get('strict-transport-security'), null);
    const prod = await startServer({ production: true });
    try {
      assert.match((await fetch(prod.base + '/')).headers.get('strict-transport-security'), /max-age=\d+/);
    } finally {
      await prod.close();
    }
  });

  test('index.html has no inline scripts or styles', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<style|\sstyle=|\son\w+=/i);
  });

  test('static files cannot escape the public directory', async () => {
    for (const p of [
      '/../server/app.js',
      '/%2e%2e/server/app.js',
      '/..%2fserver%2fapp.js',
      '/js/..%2f..%2fserver%2fapp.js',
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/.git/config',
      '/.env',
      '/node_modules/ws/package.json',
    ]) {
      const raw = await rawHttp(p);
      const status = Number(raw.split(' ')[1]);
      assert.ok(status === 404 || status === 400 || status === 403, `${p} -> ${status}`);
      assert.doesNotMatch(raw, /createApp|"dependencies"|\[core\]/, `${p} leaked content`);
    }
  });

  test('no debug or admin endpoints exist', async () => {
    for (const p of ['/api', '/api/users', '/api/admin', '/api/debug', '/api/sessions', '/admin', '/debug', '/server/app.js', '/data/callme.db']) {
      const r = await fetch(srv.base + p);
      assert.equal(r.status, 404, p);
    }
  });

  test('errors never leak stack traces', async () => {
    const c = await new Client(srv).register('leaky');
    const bad = await c.req('POST', '/api/spaces', '{"name": ', { headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.data, { error: 'Invalid JSON' });
    const big = await c.post('/api/spaces', { name: 'x'.repeat(40_000) });
    assert.equal(big.status, 413);
    assert.doesNotMatch(JSON.stringify([bad.data, big.data]), /at |node_modules|\.js:\d+/);
  });

  test('non-object JSON bodies are handled safely', async () => {
    const c = await new Client(srv).register('arrays');
    for (const body of ['[]', '"str"', 'null', '{"__proto__":{"admin":true}}']) {
      const r = await c.req('POST', '/api/spaces', body, { headers: { 'Content-Type': 'application/json' } });
      assert.ok([400].includes(r.status), `${body} -> ${r.status}`);
    }
    assert.equal({}.admin, undefined, 'no prototype pollution');
  });
});

describe('CSRF protection', () => {
  test('state-changing requests need an allowed Origin', async () => {
    const c = await new Client(srv).register('csrfuser');
    for (const origin of [null, 'https://evil.example', 'null', `${ORIGIN}.evil.example`]) {
      const r = await c.post('/api/spaces', { name: 'pwned' }, { origin });
      assert.equal(r.status, 403, `origin ${origin}`);
    }
    assert.equal((await c.get('/api/spaces')).data.spaces.length, 0);
  });

  test('form-encoded and text bodies are refused', async () => {
    const c = await new Client(srv).register('csrfform');
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
      const r = await c.req('POST', '/api/spaces', 'name=pwned', { headers: { 'Content-Type': type } });
      assert.equal(r.status, 415, type);
    }
  });

  test('session cookie is HttpOnly and SameSite=Strict, Secure in production', async () => {
    const c = await new Client(srv).register('cookieuser');
    assert.match(c.lastSetCookie, /HttpOnly/i);
    assert.match(c.lastSetCookie, /SameSite=Strict/i);
    assert.match(c.lastSetCookie, /Path=\//);

    const prod = await startServer({ production: true });
    try {
      const p = await new Client(prod).register('prodcookie');
      assert.match(p.lastSetCookie, /;\s*Secure/i);
    } finally {
      await prod.close();
    }
  });
});

describe('authentication', () => {
  test('every API route requires a session', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const routes = [
      ['GET', '/api/me'],
      ['PATCH', '/api/me'],
      ['POST', '/api/me/password'],
      ['POST', '/api/auth/logout'],
      ['GET', '/api/spaces'],
      ['POST', '/api/spaces'],
      ['POST', '/api/meetings'],
      ['GET', `/api/spaces/${id}`],
      ['PATCH', `/api/spaces/${id}`],
      ['DELETE', `/api/spaces/${id}`],
      ['POST', `/api/spaces/${id}/leave`],
      ['PATCH', `/api/spaces/${id}/members/${id}`],
      ['DELETE', `/api/spaces/${id}/members/${id}`],
      ['POST', `/api/spaces/${id}/channels`],
      ['PATCH', `/api/channels/${id}`],
      ['DELETE', `/api/channels/${id}`],
      ['GET', `/api/channels/${id}/messages`],
      ['POST', `/api/channels/${id}/messages`],
      ['DELETE', `/api/messages/${id}`],
      ['POST', `/api/spaces/${id}/invites`],
      ['GET', `/api/spaces/${id}/invites`],
      ['DELETE', '/api/invites/aaaaaaaaaaaaaaaaaaaa'],
      ['GET', '/api/invites/aaaaaaaaaaaaaaaaaaaa'],
      ['POST', '/api/invites/aaaaaaaaaaaaaaaaaaaa/accept'],
    ];
    const anon = new Client(srv);
    for (const [method, url] of routes) {
      const r = await anon.req(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
      assert.equal(r.status, 401, `${method} ${url}`);
    }
  });

  test('forged, malformed and logged-out tokens are rejected', async () => {
    const c = await new Client(srv).register('tokens');
    const saved = c.cookie;
    for (const cookie of ['callme_session=forged', 'callme_session=' + 'A'.repeat(43), 'callme_session=%E0%A4%A', 'callme_session=' + 'x'.repeat(5000)]) {
      c.cookie = cookie;
      assert.equal((await c.get('/api/me')).status, 401, cookie.slice(0, 40));
    }
    c.cookie = saved;
    await c.post('/api/auth/logout');
    c.cookie = saved;
    assert.equal((await c.get('/api/me')).status, 401, 'token dead after logout');
  });

  test('login does not reveal whether a username exists', async () => {
    await new Client(srv).register('exists');
    const a = await new Client(srv).post('/api/auth/login', { username: 'exists', password: 'wrong-password-1' });
    const b = await new Client(srv).post('/api/auth/login', { username: 'doesnotexist', password: 'wrong-password-1' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(a.data, b.data);
  });

  test('passwords and session tokens are only stored hashed', async () => {
    const c = await new Client(srv).register('hashcheck', 'super-secret-password');
    const token = decodeURIComponent(c.cookie.split('=')[1]);
    const db = new DatabaseSync(srv.dbPath, { readOnly: true });
    try {
      const user = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('hashcheck');
      assert.match(user.password_hash, /^scrypt\$/);
      assert.doesNotMatch(user.password_hash, /super-secret-password/);
      const sessions = db.prepare('SELECT token_hash FROM sessions').all();
      assert.ok(sessions.length > 0);
      assert.ok(sessions.every((s) => s.token_hash !== token && /^[0-9a-f]{64}$/.test(s.token_hash)));
    } finally {
      db.close();
    }
  });

  test('brute force login is rate limited', async () => {
    const limited = await startServer({ rateLimits: { auth: { capacity: 5, refillPerSec: 0.01 } } });
    try {
      const c = new Client(limited);
      const statuses = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await c.post('/api/auth/login', { username: 'x', password: `guess-${i}` })).status);
      }
      assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.deepEqual(statuses.slice(5), [429, 429, 429]);
    } finally {
      await limited.close();
    }
  });

  test('X-Forwarded-For is ignored unless TRUST_PROXY is set', async () => {
    const limited = await startServer({ rateLimits: { auth: { capacity: 2, refillPerSec: 0.01 } } });
    try {
      const c = new Client(limited);
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const r = await c.post('/api/auth/login', { username: 'x', password: 'y' }, { headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
        statuses.push(r.status);
      }
      assert.deepEqual(statuses, [401, 401, 429, 429], 'spoofed IPs must not reset the limit');
    } finally {
      await limited.close();
    }
  });

  test('behind a proxy, only the hop the proxy appended counts', async () => {
    const proxied = await startServer({ trustProxy: true, rateLimits: { auth: { capacity: 2, refillPerSec: 0.01 } } });
    try {
      const c = new Client(proxied);
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const headers = { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` };
        statuses.push((await c.post('/api/auth/login', { username: 'x', password: 'y' }, { headers })).status);
      }
      assert.deepEqual(statuses, [401, 401, 429, 429], 'client-written entries must not reset the limit');
      const other = await c.post('/api/auth/login', { username: 'x', password: 'y' }, { headers: { 'X-Forwarded-For': '198.51.100.9' } });
      assert.equal(other.status, 401, 'a different real client has its own bucket');
    } finally {
      await proxied.close();
    }
  });
});

describe('authorization (no access across spaces)', () => {
  let owner, member, outsider, ids, ownerMsg;
  before(async () => {
    owner = await new Client(srv).register('authzowner');
    member = await new Client(srv).register('authzmember');
    outsider = await new Client(srv).register('authzoutsider');
    ids = await spaceWithMembers(owner, member);
    ownerMsg = (await owner.post(`/api/channels/${ids.textId}/messages`, { body: 'secret plans' })).data.message;
  });

  test('outsiders get 404 for everything in the space', async () => {
    const { spaceId, textId, voiceId } = ids;
    const checks = [
      outsider.get(`/api/spaces/${spaceId}`),
      outsider.patch(`/api/spaces/${spaceId}`, { name: 'x' }),
      outsider.del(`/api/spaces/${spaceId}`),
      outsider.post(`/api/spaces/${spaceId}/leave`),
      outsider.get(`/api/channels/${textId}/messages`),
      outsider.post(`/api/channels/${textId}/messages`, { body: 'x' }),
      outsider.patch(`/api/channels/${voiceId}`, { name: 'x' }),
      outsider.del(`/api/channels/${voiceId}`),
      outsider.del(`/api/messages/${ownerMsg.id}`),
      outsider.post(`/api/spaces/${spaceId}/invites`, {}),
      outsider.get(`/api/spaces/${spaceId}/invites`),
      outsider.post(`/api/spaces/${spaceId}/channels`, { name: 'x', kind: 'text' }),
      outsider.del(`/api/spaces/${spaceId}/members/${member.user.id}`),
      outsider.patch(`/api/spaces/${spaceId}/members/${member.user.id}`, { role: 'admin' }),
    ];
    for (const [i, r] of (await Promise.all(checks)).entries()) {
      assert.equal(r.status, 404, `check #${i}`);
      assert.doesNotMatch(JSON.stringify(r.data), /secret plans|authzowner/);
    }
    assert.equal((await outsider.get('/api/spaces')).data.spaces.length, 0);
  });

  test('members cannot perform admin or owner actions', async () => {
    const { spaceId } = ids;
    assert.equal((await member.patch(`/api/spaces/${spaceId}`, { name: 'hijack' })).status, 403);
    assert.equal((await member.del(`/api/spaces/${spaceId}`)).status, 403);
    assert.equal((await member.get(`/api/spaces/${spaceId}/invites`)).status, 403);
    assert.equal((await member.del(`/api/messages/${ownerMsg.id}`)).status, 403);
    assert.equal((await member.del(`/api/spaces/${spaceId}/members/${owner.user.id}`)).status, 403);
    assert.equal((await member.patch(`/api/spaces/${spaceId}/members/${member.user.id}`, { role: 'owner' })).status, 403);
  });

  test('admins cannot remove the owner or other admins, or change roles', async () => {
    const admin = await new Client(srv).register('authzadmin');
    const admin2 = await new Client(srv).register('authzadmin2');
    const s = await spaceWithMembers(owner, admin, admin2);
    await owner.patch(`/api/spaces/${s.spaceId}/members/${admin.user.id}`, { role: 'admin' });
    await owner.patch(`/api/spaces/${s.spaceId}/members/${admin2.user.id}`, { role: 'admin' });
    assert.equal((await admin.del(`/api/spaces/${s.spaceId}/members/${owner.user.id}`)).status, 403);
    assert.equal((await admin.del(`/api/spaces/${s.spaceId}/members/${admin2.user.id}`)).status, 403);
    assert.equal((await admin.patch(`/api/spaces/${s.spaceId}/members/${admin2.user.id}`, { role: 'member' })).status, 403);
    assert.equal((await admin.del(`/api/spaces/${s.spaceId}`)).status, 403);
  });

  test('banned users cannot rejoin with any invite', async () => {
    const troll = await new Client(srv).register('authztroll');
    const s = await spaceWithMembers(owner, troll);
    assert.equal((await owner.del(`/api/spaces/${s.spaceId}/members/${troll.user.id}?ban=1`)).status, 200);
    assert.equal((await troll.get(`/api/spaces/${s.spaceId}`)).status, 404);
    const fresh = (await owner.post(`/api/spaces/${s.spaceId}/invites`, {})).data.invite;
    assert.equal((await troll.post(`/api/invites/${fresh.code}/accept`)).status, 403);
  });

  test('kicked users can rejoin; malformed IDs are 404 not 500', async () => {
    const kicked = await new Client(srv).register('authzkicked');
    const s = await spaceWithMembers(owner, kicked);
    await owner.del(`/api/spaces/${s.spaceId}/members/${kicked.user.id}`);
    assert.equal((await kicked.post(`/api/invites/${s.invite.code}/accept`)).status, 200);
    for (const bad of ["1' OR '1'='1", '../../etc/passwd', '%00', 'x'.repeat(500)]) {
      assert.equal((await owner.get(`/api/spaces/${encodeURIComponent(bad)}`)).status, 404, bad);
      assert.equal((await owner.get(`/api/invites/${encodeURIComponent(bad)}`)).status, 404, bad);
    }
  });

  test('stored HTML is returned as inert JSON text', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const r = await owner.post(`/api/channels/${ids.textId}/messages`, { body: payload });
    assert.equal(r.data.message.body, payload);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});
