import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, spaceWithMembers, startServer } from './helpers.js';

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

describe('accounts', () => {
  test('register, read profile, log out, log back in', async () => {
    const c = new Client(srv);
    await c.register('alice', 'a-long-password-123', 'Alice');
    assert.equal(c.user.displayName, 'Alice');
    assert.deepEqual((await c.get('/api/me')).data.user.username, 'alice');

    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal((await c.get('/api/me')).status, 401);
    assert.deepEqual((await c.get('/api/session')).data, { user: null });

    const login = await c.post('/api/auth/login', { username: 'ALICE', password: 'a-long-password-123' });
    assert.equal(login.status, 200, 'usernames are case-insensitive');
    assert.equal(login.data.user.id, c.user.id);
  });

  test('rejects duplicate usernames regardless of case', async () => {
    await new Client(srv).register('dupe');
    const r = await new Client(srv).post('/api/auth/register', { username: 'DUPE', password: 'a-long-password-123' });
    assert.equal(r.status, 409);
  });

  test('validates username and password', async () => {
    const c = new Client(srv);
    for (const username of ['ab', 'has space', 'x'.repeat(33), '<script>', 12345]) {
      assert.equal((await c.post('/api/auth/register', { username, password: 'a-long-password-123' })).status, 400);
    }
    assert.equal((await c.post('/api/auth/register', { username: 'shortpw', password: 'short' })).status, 400);
  });

  test('update display name strips control and bidi characters', async () => {
    const c = await new Client(srv).register('renamer');
    const r = await c.patch('/api/me', { displayName: ' New‮Name\u0000 ' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.displayName, 'NewName');
  });

  test('changing password signs out other sessions', async () => {
    const a = await new Client(srv).register('pwchange', 'first-password-123');
    const other = new Client(srv);
    await other.post('/api/auth/login', { username: 'pwchange', password: 'first-password-123' });
    assert.equal((await other.get('/api/me')).status, 200);

    const wrong = await a.post('/api/me/password', { currentPassword: 'nope-nope-nope', newPassword: 'second-password-123' });
    assert.equal(wrong.status, 403);

    const ok = await a.post('/api/me/password', { currentPassword: 'first-password-123', newPassword: 'second-password-123' });
    assert.equal(ok.status, 200);
    assert.equal((await other.get('/api/me')).status, 401, 'other device signed out');
    assert.equal((await a.get('/api/me')).status, 200, 'current device gets a fresh session');
    const relog = await new Client(srv).post('/api/auth/login', { username: 'pwchange', password: 'second-password-123' });
    assert.equal(relog.status, 200);
  });
});

describe('spaces, channels and messages', () => {
  test('creating a space gives a text and a voice channel', async () => {
    const c = await new Client(srv).register('creator');
    const r = await c.post('/api/spaces', { name: 'Friends' });
    assert.equal(r.status, 201);
    const detail = (await c.get(`/api/spaces/${r.data.space.id}`)).data.space;
    assert.equal(detail.role, 'owner');
    assert.deepEqual(detail.channels.map((ch) => ch.kind).sort(), ['text', 'voice']);
    assert.equal(detail.members.length, 1);
  });

  test('quick meeting returns a space and a working invite', async () => {
    const host = await new Client(srv).register('host');
    const guest = await new Client(srv).register('guest');
    const r = await host.post('/api/meetings', {});
    assert.equal(r.status, 201);
    assert.match(r.data.invite.code, /^[A-Za-z0-9_-]{20}$/);
    const accept = await guest.post(`/api/invites/${r.data.invite.code}/accept`);
    assert.equal(accept.data.spaceId, r.data.space.id);
    assert.equal(accept.data.joined, true);
  });

  test('post, page and delete messages', async () => {
    const owner = await new Client(srv).register('chatowner');
    const member = await new Client(srv).register('chatmember');
    const { textId } = await spaceWithMembers(owner, member);

    for (let i = 0; i < 60; i++) {
      const r = await member.post(`/api/channels/${textId}/messages`, { body: `msg ${i}` });
      assert.equal(r.status, 201);
    }
    const page1 = (await owner.get(`/api/channels/${textId}/messages`)).data.messages;
    assert.equal(page1.length, 50);
    assert.equal(page1.at(-1).body, 'msg 59');
    const page2 = (await owner.get(`/api/channels/${textId}/messages?before=${page1[0].createdAt}`)).data.messages;
    assert.ok(page2.length >= 1);
    assert.ok(page2.every((m) => m.createdAt < page1[0].createdAt));

    const target = page1.at(-1);
    const other = await new Client(srv).register('chatother');
    assert.equal((await other.del(`/api/messages/${target.id}`)).status, 404, 'outsiders cannot see it');
    assert.equal((await owner.del(`/api/messages/${target.id}`)).status, 200, 'owner can moderate');
    const mine = (await member.post(`/api/channels/${textId}/messages`, { body: 'mine' })).data.message;
    assert.equal((await member.del(`/api/messages/${mine.id}`)).status, 200, 'authors can delete their own');
  });

  test('message bodies keep newlines, reject empty or huge ones', async () => {
    const c = await new Client(srv).register('bodies');
    const { textId } = await spaceWithMembers(c);
    const r = await c.post(`/api/channels/${textId}/messages`, { body: 'line1\nline2' });
    assert.equal(r.data.message.body, 'line1\nline2');
    assert.equal((await c.post(`/api/channels/${textId}/messages`, { body: '   ' })).status, 400);
    assert.equal((await c.post(`/api/channels/${textId}/messages`, { body: 'x'.repeat(4001) })).status, 400);
    assert.equal((await c.post(`/api/channels/${textId}/messages`, { body: { $gt: '' } })).status, 400);
  });

  test('cannot post text into a voice channel', async () => {
    const c = await new Client(srv).register('voicetext');
    const { voiceId } = await spaceWithMembers(c);
    assert.equal((await c.post(`/api/channels/${voiceId}/messages`, { body: 'hi' })).status, 400);
  });

  test('admins manage channels; members cannot', async () => {
    const owner = await new Client(srv).register('chanowner');
    const member = await new Client(srv).register('chanmember');
    const { spaceId, textId } = await spaceWithMembers(owner, member);

    assert.equal((await member.post(`/api/spaces/${spaceId}/channels`, { name: 'x', kind: 'text' })).status, 403);
    assert.equal((await member.patch(`/api/channels/${textId}`, { name: 'renamed' })).status, 403);
    assert.equal((await member.del(`/api/channels/${textId}`)).status, 403);

    await owner.patch(`/api/spaces/${spaceId}/members/${member.user.id}`, { role: 'admin' });
    const created = await member.post(`/api/spaces/${spaceId}/channels`, { name: 'Standup', kind: 'voice' });
    assert.equal(created.status, 201);
    assert.equal((await member.patch(`/api/channels/${created.data.channel.id}`, { name: 'Daily' })).data.channel.name, 'Daily');
    assert.equal((await member.del(`/api/channels/${created.data.channel.id}`)).status, 200);
    assert.equal((await owner.post(`/api/spaces/${spaceId}/channels`, { name: 'x', kind: 'video' })).status, 400);
  });

  test('ownership transfer, leave and delete', async () => {
    const owner = await new Client(srv).register('xferowner');
    const member = await new Client(srv).register('xfermember');
    const { spaceId } = await spaceWithMembers(owner, member);

    assert.equal((await owner.post(`/api/spaces/${spaceId}/leave`)).status, 400, 'owner must transfer first');
    assert.equal((await owner.patch(`/api/spaces/${spaceId}/members/${member.user.id}`, { role: 'owner' })).status, 200);
    assert.equal((await owner.get(`/api/spaces/${spaceId}`)).data.space.role, 'admin');
    assert.equal((await member.get(`/api/spaces/${spaceId}`)).data.space.role, 'owner');

    assert.equal((await owner.del(`/api/spaces/${spaceId}`)).status, 403, 'admins cannot delete');
    assert.equal((await owner.post(`/api/spaces/${spaceId}/leave`)).status, 200);
    assert.equal((await owner.get(`/api/spaces/${spaceId}`)).status, 404);
    assert.equal((await member.del(`/api/spaces/${spaceId}`)).status, 200);
    assert.equal((await member.get(`/api/spaces/${spaceId}`)).status, 404);
  });
});

describe('invites', () => {
  test('max uses and revocation', async () => {
    const owner = await new Client(srv).register('invowner');
    const { data } = await owner.post('/api/spaces', { name: 'Limited' });
    const spaceId = data.space.id;
    const inv = (await owner.post(`/api/spaces/${spaceId}/invites`, { maxUses: 1 })).data.invite;

    const first = await new Client(srv).register('invfirst');
    const second = await new Client(srv).register('invsecond');
    assert.equal((await first.get(`/api/invites/${inv.code}`)).data.invite.spaceName, 'Limited');
    assert.equal((await first.post(`/api/invites/${inv.code}/accept`)).status, 200);
    assert.equal((await second.post(`/api/invites/${inv.code}/accept`)).status, 404, 'used up');

    const inv2 = (await owner.post(`/api/spaces/${spaceId}/invites`, {})).data.invite;
    assert.equal((await first.del(`/api/invites/${inv2.code}`)).status, 403, 'members cannot revoke');
    assert.equal((await owner.del(`/api/invites/${inv2.code}`)).status, 200);
    assert.equal((await second.post(`/api/invites/${inv2.code}/accept`)).status, 404);
  });

  test('re-accepting as an existing member does not consume a use', async () => {
    const owner = await new Client(srv).register('reaccept');
    const { spaceId } = await spaceWithMembers(owner);
    const inv = (await owner.post(`/api/spaces/${spaceId}/invites`, { maxUses: 1 })).data.invite;
    const r = await owner.post(`/api/invites/${inv.code}/accept`);
    assert.equal(r.data.joined, false);
    const list = (await owner.get(`/api/spaces/${spaceId}/invites`)).data.invites;
    assert.equal(list.find((i) => i.code === inv.code).uses, 0);
  });

  test('invalid option values are rejected', async () => {
    const owner = await new Client(srv).register('invopts');
    const { spaceId } = await spaceWithMembers(owner);
    for (const body of [{ maxUses: 0 }, { maxUses: -1 }, { maxUses: 1.5 }, { expiresInHours: 99999 }, { maxUses: 'lots' }]) {
      assert.equal((await owner.post(`/api/spaces/${spaceId}/invites`, body)).status, 400, JSON.stringify(body));
    }
  });
});

describe('health check', () => {
  test('answers without a session and is never cached', async () => {
    const r = await new Client(srv).get('/healthz', { origin: null });
    assert.equal(r.status, 200);
    assert.equal(r.data, 'ok');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});
