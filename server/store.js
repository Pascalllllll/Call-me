import crypto from 'node:crypto';
import { transaction } from './db.js';
import { HttpError } from './validate.js';

const RANK = { member: 1, admin: 2, owner: 3 };

export function createStore(db) {
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, display_name AS displayName FROM users WHERE id = ?'),
    passwordHash: db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),

    insertSpace: db.prepare('INSERT INTO spaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)'),
    space: db.prepare('SELECT id, name, owner_id AS ownerId, created_at AS createdAt FROM spaces WHERE id = ?'),
    renameSpace: db.prepare('UPDATE spaces SET name = ? WHERE id = ?'),
    deleteSpace: db.prepare('DELETE FROM spaces WHERE id = ?'),
    spacesForUser: db.prepare(`
      SELECT s.id, s.name, m.role FROM members m JOIN spaces s ON s.id = m.space_id
      WHERE m.user_id = ? ORDER BY m.joined_at`),

    insertMember: db.prepare('INSERT INTO members (space_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'),
    membership: db.prepare('SELECT role FROM members WHERE space_id = ? AND user_id = ?'),
    members: db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, m.role
      FROM members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.joined_at`),
    memberIds: db.prepare('SELECT user_id AS id FROM members WHERE space_id = ?'),
    coMemberIds: db.prepare(`
      SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m1.space_id = m2.space_id
      WHERE m1.user_id = ?`),
    setRole: db.prepare('UPDATE members SET role = ? WHERE space_id = ? AND user_id = ?'),
    setOwner: db.prepare('UPDATE spaces SET owner_id = ? WHERE id = ?'),
    removeMember: db.prepare('DELETE FROM members WHERE space_id = ? AND user_id = ?'),
    ban: db.prepare('INSERT OR IGNORE INTO bans (space_id, user_id) VALUES (?, ?)'),
    isBanned: db.prepare('SELECT 1 AS x FROM bans WHERE space_id = ? AND user_id = ?'),

    insertChannel: db.prepare('INSERT INTO channels (id, space_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)'),
    channel: db.prepare('SELECT id, space_id AS spaceId, name, kind FROM channels WHERE id = ?'),
    channels: db.prepare(
      'SELECT id, space_id AS spaceId, name, kind FROM channels WHERE space_id = ? ORDER BY kind, created_at',
    ),
    renameChannel: db.prepare('UPDATE channels SET name = ? WHERE id = ?'),
    deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),

    insertMessage: db.prepare(
      'INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    message: db.prepare(`
      SELECT m.id, m.channel_id AS channelId, m.author_id AS authorId, c.space_id AS spaceId
      FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?`),
    messagesBefore: db.prepare(`
      SELECT m.id, m.channel_id AS channelId, m.body, m.created_at AS createdAt,
             u.id AS authorId, u.display_name AS authorName, u.username AS authorUsername
      FROM messages m JOIN users u ON u.id = m.author_id
      WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),

    insertInvite: db.prepare(
      'INSERT INTO invites (code, space_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    invite: db.prepare(`
      SELECT i.code, i.space_id AS spaceId, i.expires_at AS expiresAt, i.max_uses AS maxUses, i.uses,
             s.name AS spaceName
      FROM invites i JOIN spaces s ON s.id = i.space_id WHERE i.code = ?`),
    invites: db.prepare(`
      SELECT i.code, i.created_at AS createdAt, i.expires_at AS expiresAt, i.max_uses AS maxUses, i.uses,
             u.display_name AS createdBy
      FROM invites i JOIN users u ON u.id = i.created_by WHERE i.space_id = ? ORDER BY i.created_at DESC`),
    useInvite: db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?'),
    deleteInvite: db.prepare('DELETE FROM invites WHERE code = ?'),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE space_id = ?'),
  };

  const uuid = () => crypto.randomUUID();

  function requireRole(spaceId, userId, minRole) {
    const row = q.membership.get(spaceId, userId);
    // Non-members get 404 rather than 403 so space IDs cannot be probed.
    if (!row) throw new HttpError(404, 'Space not found');
    if (RANK[row.role] < RANK[minRole]) throw new HttpError(403, 'You do not have permission to do that');
    return row.role;
  }

  function channelFor(channelId, userId, minRole = 'member') {
    const ch = q.channel.get(channelId);
    if (!ch) throw new HttpError(404, 'Channel not found');
    try {
      requireRole(ch.spaceId, userId, minRole);
    } catch (err) {
      if (err.status === 404) throw new HttpError(404, 'Channel not found');
      throw err;
    }
    return ch;
  }

  function createInvite(spaceId, userId, { expiresInHours = null, maxUses = null } = {}) {
    const code = crypto.randomBytes(15).toString('base64url');
    const now = Date.now();
    const expiresAt = expiresInHours ? now + expiresInHours * 3600_000 : null;
    q.insertInvite.run(code, spaceId, userId, now, expiresAt, maxUses);
    return { code, expiresAt, maxUses, uses: 0 };
  }

  function liveInvite(code) {
    const inv = q.invite.get(code);
    const expired =
      !inv || (inv.expiresAt !== null && inv.expiresAt < Date.now()) || (inv.maxUses !== null && inv.uses >= inv.maxUses);
    if (expired) throw new HttpError(404, 'Invite not found or expired');
    return inv;
  }

  return {
    RANK,
    requireRole,
    channelFor,

    userByName: (name) => q.userByName.get(name),
    userById: (id) => q.userById.get(id),
    passwordHash: (id) => q.passwordHash.get(id)?.hash,
    createUser(username, displayName, passwordHash) {
      const id = uuid();
      try {
        q.insertUser.run(id, username, displayName, passwordHash, Date.now());
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That username is taken');
        throw err;
      }
      return { id, username, displayName };
    },
    setDisplayName: (id, name) => q.setDisplayName.run(name, id),
    setPassword: (id, hash) => q.setPassword.run(hash, id),

    spacesForUser: (userId) => q.spacesForUser.all(userId),
    memberIds: (spaceId) => q.memberIds.all(spaceId).map((r) => r.id),
    coMemberIds: (userId) => q.coMemberIds.all(userId).map((r) => r.id),

    createSpace(ownerId, name, { voiceName = 'Lounge', textChannel = true } = {}) {
      return transaction(db, () => {
        const id = uuid();
        const now = Date.now();
        q.insertSpace.run(id, name, ownerId, now);
        q.insertMember.run(id, ownerId, 'owner', now);
        if (textChannel) q.insertChannel.run(uuid(), id, 'general', 'text', now);
        q.insertChannel.run(uuid(), id, voiceName, 'voice', now + 1);
        return { id, name, role: 'owner' };
      });
    },
    spaceDetail(spaceId, userId) {
      const role = requireRole(spaceId, userId, 'member');
      const space = q.space.get(spaceId);
      return { ...space, role, channels: q.channels.all(spaceId), members: q.members.all(spaceId) };
    },
    renameSpace(spaceId, userId, name) {
      requireRole(spaceId, userId, 'admin');
      q.renameSpace.run(name, spaceId);
    },
    deleteSpace(spaceId, userId) {
      requireRole(spaceId, userId, 'owner');
      const ids = q.memberIds.all(spaceId).map((r) => r.id);
      q.deleteSpace.run(spaceId);
      return ids;
    },
    leaveSpace(spaceId, userId) {
      const role = requireRole(spaceId, userId, 'member');
      if (role === 'owner') throw new HttpError(400, 'Owners cannot leave. Delete the space or transfer ownership.');
      q.removeMember.run(spaceId, userId);
    },

    setRole(spaceId, actorId, targetId, role) {
      requireRole(spaceId, actorId, 'owner');
      if (actorId === targetId) throw new HttpError(400, 'You cannot change your own role');
      const target = q.membership.get(spaceId, targetId);
      if (!target) throw new HttpError(404, 'Member not found');
      if (role === 'owner') {
        transaction(db, () => {
          q.setRole.run('owner', spaceId, targetId);
          q.setRole.run('admin', spaceId, actorId);
          q.setOwner.run(targetId, spaceId);
        });
      } else {
        q.setRole.run(role, spaceId, targetId);
      }
    },
    removeMember(spaceId, actorId, targetId, ban) {
      const actorRole = requireRole(spaceId, actorId, 'admin');
      if (actorId === targetId) throw new HttpError(400, 'Use leave instead');
      const target = q.membership.get(spaceId, targetId);
      if (!target) throw new HttpError(404, 'Member not found');
      if (RANK[target.role] >= RANK[actorRole]) {
        throw new HttpError(403, 'You can only remove members ranked below you');
      }
      transaction(db, () => {
        q.removeMember.run(spaceId, targetId);
        if (ban) q.ban.run(spaceId, targetId);
      });
    },

    createChannel(spaceId, userId, name, kind) {
      requireRole(spaceId, userId, 'admin');
      const ch = { id: uuid(), spaceId, name, kind };
      q.insertChannel.run(ch.id, spaceId, name, kind, Date.now());
      return ch;
    },
    renameChannel(channelId, userId, name) {
      const ch = channelFor(channelId, userId, 'admin');
      q.renameChannel.run(name, channelId);
      return { ...ch, name };
    },
    deleteChannel(channelId, userId) {
      const ch = channelFor(channelId, userId, 'admin');
      q.deleteChannel.run(channelId);
      return ch;
    },

    listMessages(channelId, userId, before, limit) {
      const ch = channelFor(channelId, userId);
      if (ch.kind !== 'text') throw new HttpError(400, 'Not a text channel');
      return q.messagesBefore.all(channelId, before, limit).reverse();
    },
    postMessage(channelId, user, body) {
      const ch = channelFor(channelId, user.id);
      if (ch.kind !== 'text') throw new HttpError(400, 'Not a text channel');
      const msg = {
        id: uuid(),
        channelId,
        body,
        createdAt: Date.now(),
        authorId: user.id,
        authorName: user.displayName,
        authorUsername: user.username,
      };
      q.insertMessage.run(msg.id, channelId, user.id, body, msg.createdAt);
      return { spaceId: ch.spaceId, msg };
    },
    deleteMessage(messageId, userId) {
      const msg = q.message.get(messageId);
      if (!msg || !q.membership.get(msg.spaceId, userId)) throw new HttpError(404, 'Message not found');
      if (msg.authorId !== userId) requireRole(msg.spaceId, userId, 'admin');
      q.deleteMessage.run(messageId);
      return msg;
    },

    createInvite(spaceId, userId, opts) {
      requireRole(spaceId, userId, 'member');
      return createInvite(spaceId, userId, opts);
    },
    listInvites(spaceId, userId) {
      requireRole(spaceId, userId, 'admin');
      return q.invites.all(spaceId);
    },
    revokeInvite(code, userId) {
      const inv = q.invite.get(code);
      if (!inv) throw new HttpError(404, 'Invite not found or expired');
      requireRole(inv.spaceId, userId, 'admin');
      q.deleteInvite.run(code);
    },
    previewInvite(code, userId) {
      const inv = liveInvite(code);
      return {
        spaceId: inv.spaceId,
        spaceName: inv.spaceName,
        memberCount: q.memberCount.get(inv.spaceId).n,
        alreadyMember: Boolean(q.membership.get(inv.spaceId, userId)),
      };
    },
    acceptInvite(code, userId) {
      return transaction(db, () => {
        const inv = liveInvite(code);
        if (q.isBanned.get(inv.spaceId, userId)) throw new HttpError(403, 'You are banned from this space');
        if (q.membership.get(inv.spaceId, userId)) return { spaceId: inv.spaceId, joined: false };
        q.insertMember.run(inv.spaceId, userId, 'member', Date.now());
        q.useInvite.run(code);
        return { spaceId: inv.spaceId, joined: true };
      });
    },
    member(spaceId, userId) {
      const row = q.membership.get(spaceId, userId);
      if (!row) return null;
      return { ...q.userById.get(userId), role: row.role };
    },
    quickMeeting(userId, name) {
      const space = this.createSpace(userId, name, { voiceName: 'Meeting room' });
      const invite = createInvite(space.id, userId, { expiresInHours: 24 * 7 });
      return { space, invite };
    },
  };
}
