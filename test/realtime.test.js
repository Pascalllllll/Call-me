import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, openSocket, spaceWithMembers, startServer } from './helpers.js';

let srv;
const sockets = [];
before(async () => {
  srv = await startServer();
});
after(async () => {
  for (const ws of sockets) ws.terminate();
  await srv.close();
});

async function connect(client) {
  const ws = await client.socket();
  sockets.push(ws);
  const hello = await ws.next('hello');
  return { ws, hello };
}

const fakeOffer = { description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' } };

describe('WebSocket handshake', () => {
  test('rejects missing session, bad origin and wrong path', async () => {
    const c = await new Client(srv).register('wsgate');
    await assert.rejects(openSocket(srv.wsUrl, { origin: 'http://callme.test', cookie: null }), { status: 401 });
    await assert.rejects(openSocket(srv.wsUrl, { origin: 'https://evil.example', cookie: c.cookie }), { status: 403 });
    await assert.rejects(openSocket(srv.wsUrl, { origin: undefined, cookie: c.cookie }), { status: 403 });
    await assert.rejects(openSocket(srv.wsUrl.replace('/ws', '/other'), { origin: 'http://callme.test', cookie: c.cookie }), { status: 404 });
    await assert.rejects(openSocket(srv.wsUrl, { origin: 'http://callme.test', cookie: 'callme_session=forged-token-value-123456' }), { status: 401 });
  });

  test('hello carries ICE servers and peer id', async () => {
    const c = await new Client(srv).register('wshello');
    const { hello } = await connect(c);
    assert.match(hello.peerId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(hello.iceServers, [{ urls: ['stun:stun.example.test:3478'] }]);
  });

  test('logging out closes the socket', async () => {
    const c = await new Client(srv).register('wslogout');
    const { ws } = await connect(c);
    await c.post('/api/auth/logout');
    assert.equal(await ws.closed, 4001);
  });

  test('binary frames and oversized messages close the connection', async () => {
    const c = await new Client(srv).register('wsbinary');
    const { ws } = await connect(c);
    ws.send(Buffer.from([1, 2, 3]));
    assert.equal(await ws.closed, 1003);

    const { ws: ws2 } = await connect(c);
    ws2.send('x'.repeat(200 * 1024));
    assert.equal(await ws2.closed, 1009);

    const { hello } = await connect(c);
    assert.ok(hello.peerId, 'server survived the bad frames');
    assert.equal((await c.get('/api/me')).status, 200);
  });
});

describe('calls', () => {
  test('join, see each other, relay signals, leave', async () => {
    const a = await new Client(srv).register('calla', undefined, 'Caller A');
    const b = await new Client(srv).register('callb', undefined, 'Caller B');
    const { voiceId, spaceId } = await spaceWithMembers(a, b);
    const A = await connect(a);
    const B = await connect(b);

    A.ws.sendJson({ type: 'voice.join', channelId: voiceId });
    const aJoined = await A.ws.next('voice.joined');
    assert.equal(aJoined.peers.length, 0);
    assert.equal(aJoined.spaceId, spaceId);
    const stateForB = await B.ws.next((m) => m.type === 'voice.state' && m.peers.length === 1);
    assert.equal(stateForB.peers[0].displayName, 'Caller A');

    B.ws.sendJson({ type: 'voice.join', channelId: voiceId });
    const bJoined = await B.ws.next('voice.joined');
    assert.deepEqual(bJoined.peers.map((p) => p.peerId), [A.hello.peerId]);
    const pj = await A.ws.next('voice.peer-joined');
    assert.equal(pj.peer.peerId, B.hello.peerId);

    // Newcomer B offers to A; server relays with a trusted "from".
    B.ws.sendJson({ type: 'signal', to: A.hello.peerId, data: { ...fakeOffer, from: 'spoofed' } });
    const sig = await A.ws.next('signal');
    assert.equal(sig.from, B.hello.peerId);
    assert.deepEqual(sig.data, fakeOffer);

    B.ws.sendJson({ type: 'voice.update', muted: true, video: true, screen: 'yes' });
    const upd = await A.ws.next((m) => m.type === 'voice.state' && m.peers.some((p) => p.muted));
    const bState = upd.peers.find((p) => p.peerId === B.hello.peerId);
    assert.equal(bState.video, true);
    assert.equal(bState.screen, false, 'non-boolean values ignored');

    B.ws.sendJson({ type: 'voice.leave' });
    const left = await A.ws.next('voice.peer-left');
    assert.equal(left.peerId, B.hello.peerId);
  });

  test('signals cannot reach peers outside your call', async () => {
    const a = await new Client(srv).register('siga');
    const b = await new Client(srv).register('sigb');
    const eve = await new Client(srv).register('sigeve');
    const s = await spaceWithMembers(a, b);
    const evesSpace = await spaceWithMembers(eve);
    const A = await connect(a);
    const B = await connect(b);
    const E = await connect(eve);

    A.ws.sendJson({ type: 'voice.join', channelId: s.voiceId });
    await A.ws.next('voice.joined');

    // Eve is in her own call and guesses A's peer id; B is online but not in any call.
    E.ws.sendJson({ type: 'voice.join', channelId: evesSpace.voiceId });
    await E.ws.next('voice.joined');
    E.ws.sendJson({ type: 'signal', to: A.hello.peerId, data: fakeOffer });
    B.ws.sendJson({ type: 'signal', to: A.hello.peerId, data: fakeOffer });
    assert.ok(await A.ws.none('signal'), 'no signal delivered');
  });

  test('non-members cannot join a voice channel or see its state', async () => {
    const owner = await new Client(srv).register('vcowner');
    const eve = await new Client(srv).register('vceve');
    const { voiceId, textId } = await spaceWithMembers(owner);
    const O = await connect(owner);
    const E = await connect(eve);

    E.ws.sendJson({ type: 'voice.join', channelId: voiceId });
    assert.equal((await E.ws.next('error')).error, 'Channel not found');
    E.ws.sendJson({ type: 'voice.join', channelId: textId });
    assert.equal((await E.ws.next('error')).error, 'Channel not found');

    O.ws.sendJson({ type: 'voice.join', channelId: voiceId });
    await O.ws.next('voice.joined');
    assert.ok(await E.ws.none('voice.state'), 'outsider sees nothing');

    O.ws.sendJson({ type: 'voice.join', channelId: textId });
    assert.equal((await O.ws.next('error')).error, 'Not a voice channel');
  });

  test('malformed signals are dropped', async () => {
    const a = await new Client(srv).register('mala');
    const b = await new Client(srv).register('malb');
    const { voiceId } = await spaceWithMembers(a, b);
    const A = await connect(a);
    const B = await connect(b);
    A.ws.sendJson({ type: 'voice.join', channelId: voiceId });
    await A.ws.next('voice.joined');
    B.ws.sendJson({ type: 'voice.join', channelId: voiceId });
    await B.ws.next('voice.joined');

    const bad = [
      { description: { type: 'rollback', sdp: '' } },
      { description: { type: 'offer', sdp: 42 } },
      { candidate: { candidate: {} } },
      { nothing: true },
      'string',
      { description: { type: 'offer', sdp: 'a'.repeat(70 * 1024) } },
    ];
    for (const data of bad) B.ws.sendJson({ type: 'signal', to: A.hello.peerId, data });
    B.ws.send('not json');
    B.ws.sendJson(null);
    B.ws.sendJson({ type: 'unknown' });
    assert.ok(await A.ws.none('signal'));
    B.ws.sendJson({ type: 'ping' });
    await B.ws.next('pong');
  });

  test('joining a second call moves you out of the first', async () => {
    const a = await new Client(srv).register('movea');
    const s = await spaceWithMembers(a);
    const other = (await a.post(`/api/spaces/${s.spaceId}/channels`, { name: 'Second', kind: 'voice' })).data.channel;
    const tab1 = await connect(a);
    const tab2 = await connect(a);
    tab1.ws.sendJson({ type: 'voice.join', channelId: s.voiceId });
    await tab1.ws.next('voice.joined');
    tab2.ws.sendJson({ type: 'voice.join', channelId: other.id });
    await tab2.ws.next('voice.joined');
    const left = await tab1.ws.next('voice.left');
    assert.equal(left.reason, 'joined-elsewhere');
  });

  test('kicked members are removed from the call immediately', async () => {
    const owner = await new Client(srv).register('kickowner');
    const guest = await new Client(srv).register('kickguest');
    const s = await spaceWithMembers(owner, guest);
    const O = await connect(owner);
    const G = await connect(guest);
    O.ws.sendJson({ type: 'voice.join', channelId: s.voiceId });
    await O.ws.next('voice.joined');
    G.ws.sendJson({ type: 'voice.join', channelId: s.voiceId });
    await G.ws.next('voice.joined');

    await owner.del(`/api/spaces/${s.spaceId}/members/${guest.user.id}`);
    assert.equal((await G.ws.next('voice.left')).reason, 'removed');
    assert.equal((await G.ws.next('space.removed')).reason, 'kicked');
    await O.ws.next('voice.peer-left');
    G.ws.sendJson({ type: 'voice.join', channelId: s.voiceId });
    assert.equal((await G.ws.next('error')).error, 'Channel not found');
  });

  test('deleting a voice channel ends its call', async () => {
    const owner = await new Client(srv).register('delvc');
    const s = await spaceWithMembers(owner);
    const O = await connect(owner);
    O.ws.sendJson({ type: 'voice.join', channelId: s.voiceId });
    await O.ws.next('voice.joined');
    await owner.del(`/api/channels/${s.voiceId}`);
    assert.equal((await O.ws.next('voice.left')).reason, 'channel-deleted');
  });

  test('no participant cap: 40 people in one call', async () => {
    const owner = await new Client(srv).register('bigowner');
    const others = [];
    for (let i = 0; i < 39; i++) others.push(await new Client(srv).register(`big${i}`));
    const s = await spaceWithMembers(owner, ...others);
    const conns = [];
    for (const c of [owner, ...others]) {
      const conn = await connect(c);
      conn.ws.sendJson({ type: 'voice.join', channelId: s.voiceId });
      const joined = await conn.ws.next('voice.joined');
      assert.equal(joined.peers.length, conns.length);
      conns.push(conn);
    }
    const last = conns.at(-1);
    // The last joiner can signal the first, and vice versa is just an answer.
    last.ws.sendJson({ type: 'signal', to: conns[0].hello.peerId, data: fakeOffer });
    assert.equal((await conns[0].ws.next('signal')).from, last.hello.peerId);
    for (const c of conns) c.ws.close();
  });
});

describe('live chat events', () => {
  test('messages and typing reach members only', async () => {
    const a = await new Client(srv).register('livea');
    const b = await new Client(srv).register('liveb');
    const eve = await new Client(srv).register('liveeve');
    const { textId } = await spaceWithMembers(a, b);
    const B = await connect(b);
    const E = await connect(eve);
    const A = await connect(a);

    await a.post(`/api/channels/${textId}/messages`, { body: 'hello team' });
    const got = await B.ws.next('message.created');
    assert.equal(got.message.body, 'hello team');

    A.ws.sendJson({ type: 'typing', channelId: textId });
    assert.equal((await B.ws.next('typing')).userId, a.user.id);
    E.ws.sendJson({ type: 'typing', channelId: textId });
    assert.ok(await B.ws.none('typing'), 'outsider cannot inject typing events');
    assert.ok(await E.ws.none((m) => m.type === 'message.created' || m.type === 'typing'), 'outsider sees nothing');
  });

  test('presence goes online and offline', async () => {
    const a = await new Client(srv).register('presa');
    const b = await new Client(srv).register('presb');
    await spaceWithMembers(a, b);
    const A = await connect(a);
    const B = await connect(b);
    assert.deepEqual(await A.ws.next((m) => m.type === 'presence' && m.userId === b.user.id), { type: 'presence', userId: b.user.id, online: true });
    assert.ok(B.hello.online.includes(a.user.id));
    B.ws.close();
    assert.equal((await A.ws.next((m) => m.type === 'presence' && m.userId === b.user.id)).online, false);
  });

  test('socket messages are rate limited', async () => {
    const limited = await startServer({ rateLimits: { ws: { capacity: 20, refillPerSec: 1 } } });
    try {
      const c = await new Client(limited).register('flooder');
      const ws = await c.socket();
      await ws.next('hello');
      for (let i = 0; i < 30; i++) ws.sendJson({ type: 'ping' });
      const err = await ws.next('error');
      assert.equal(err.error, 'Slow down');
      ws.terminate();
    } finally {
      await limited.close();
    }
  });
});

describe('TURN credentials', () => {
  test('are short-lived HMAC credentials, never the shared secret', async () => {
    const crypto = await import('node:crypto');
    const secret = 'turn-shared-secret-value';
    const turnSrv = await startServer({ turn: { urls: ['turn:turn.example.test:3478'], secret, ttlSec: 3600 } });
    try {
      const c = await new Client(turnSrv).register('turnuser');
      const ws = await c.socket();
      const hello = await ws.next('hello');
      const turn = hello.iceServers.find((s) => s.username);
      const [expiry, userId] = turn.username.split(':');
      assert.equal(userId, c.user.id);
      const ttl = Number(expiry) - Date.now() / 1000;
      assert.ok(ttl > 3500 && ttl <= 3600, `ttl ${ttl}`);
      assert.equal(turn.credential, crypto.createHmac('sha1', secret).update(turn.username).digest('base64'));
      assert.doesNotMatch(JSON.stringify(hello), new RegExp(secret));
      ws.terminate();
    } finally {
      await turnSrv.close();
    }
  });
});

describe('broadcast flooding', () => {
  test('typing spam is throttled harder than signaling', async () => {
    const limited = await startServer({ rateLimits: { ws: { capacity: 100, refillPerSec: 1 } } });
    try {
      const a = await new Client(limited).register('spammer');
      const b = await new Client(limited).register('spamvictim');
      const { textId } = await spaceWithMembers(a, b);
      const A = await a.socket();
      await A.next('hello');
      const B = await b.socket();
      await B.next('hello');
      for (let i = 0; i < 20; i++) A.sendJson({ type: 'typing', channelId: textId });
      await A.next('error');
      let received = 0;
      while (!(await B.none('typing', 200))) received++;
      assert.ok(received <= 5, `victim got ${received} typing events`);
      A.terminate();
      B.terminate();
    } finally {
      await limited.close();
    }
  });
});

describe('joining a space mid-session', () => {
  test('syncs presence and the live call to the new member', async () => {
    const host = await new Client(srv).register('synchost');
    const late = await new Client(srv).register('synclate');
    const H = await connect(host);
    const L = await connect(late);
    const { data } = await host.post('/api/meetings', {});
    const voiceId = (await host.get(`/api/spaces/${data.space.id}`)).data.space.channels.find((c) => c.kind === 'voice').id;
    H.ws.sendJson({ type: 'voice.join', channelId: voiceId });
    await H.ws.next('voice.joined');

    await late.post(`/api/invites/${data.invite.code}/accept`);
    const sync = await L.ws.next('space.sync');
    assert.ok(sync.online.includes(host.user.id));
    assert.equal(sync.voice[0].peers[0].userId, host.user.id);
    assert.equal((await H.ws.next((m) => m.type === 'presence' && m.userId === late.user.id)).online, true);
  });
});
