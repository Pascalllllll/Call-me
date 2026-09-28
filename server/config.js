import path from 'node:path';

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIceServers(raw) {
  if (!raw) return [{ urls: ['stun:stun.l.google.com:19302'] }];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('ICE_SERVERS must be a JSON array');
  return parsed;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const port = Number(overrides.port ?? env.PORT ?? 3000);
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  const production = overrides.production ?? env.NODE_ENV === 'production';

  const origins = overrides.allowedOrigins ?? list(env.ALLOWED_ORIGINS);
  if (origins.length === 0) {
    origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }

  return {
    port,
    host,
    production,
    // Only trust X-Forwarded-For when explicitly running behind a proxy.
    trustProxy: overrides.trustProxy ?? env.TRUST_PROXY === '1',
    allowedOrigins: new Set(origins),
    dbPath: overrides.dbPath ?? env.DB_PATH ?? path.resolve('data', 'callme.db'),
    iceServers: overrides.iceServers ?? parseIceServers(env.ICE_SERVERS),
    // Optional coturn "use-auth-secret" setup: each client gets short-lived TURN credentials.
    turn: overrides.turn ?? (env.TURN_URLS && env.TURN_SECRET
      ? { urls: list(env.TURN_URLS), secret: env.TURN_SECRET, ttlSec: Number(env.TURN_TTL_SEC || 12 * 3600) }
      : null),
    sessionTtlMs: 1000 * 60 * 60 * 24 * 30,
    // Secure cookies need HTTPS; localhost development runs over plain HTTP.
    secureCookies: overrides.secureCookies ?? production,
    rateLimits: {
      auth: { capacity: 10, refillPerSec: 10 / 60 },
      api: { capacity: 120, refillPerSec: 2 },
      // Signaling bursts when joining big calls (offers + ICE candidates per peer).
      ws: { capacity: 1000, refillPerSec: 100 },
      ...(overrides.rateLimits || {}),
    },
  };
}
