import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

export const SESSION_COOKIE = 'callme_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

// Pre-computed so logins for unknown usernames cost the same as real ones.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        // Ignore malformed cookie values.
      }
    }
  }
  return out;
}

export function createSessionStore(db, ttlMs) {
  const insert = db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const lookup = db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  return {
    create(userId) {
      const token = newToken();
      const now = Date.now();
      insert.run(hashToken(token), userId, now, now + ttlMs);
      return token;
    },
    resolve(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      return this.resolveHash(hashToken(token));
    },
    resolveHash(hashed) {
      const row = lookup.get(hashed);
      if (!row) return null;
      if (row.expiresAt < Date.now()) {
        remove.run(hashed);
        return null;
      }
      return { id: row.id, username: row.username, displayName: row.displayName, tokenHash: hashed };
    },
    destroy(tokenHash) {
      remove.run(tokenHash);
    },
    destroyAllForUser(userId) {
      removeForUser.run(userId);
    },
    purgeExpired() {
      purge.run(Date.now());
    },
  };
}
