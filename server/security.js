export function createRateLimiter({ capacity, refillPerSec }) {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (b.tokens + ((now - b.last) / 1000) * refillPerSec >= capacity) buckets.delete(key);
    }
  }, 60_000);
  sweep.unref();

  return {
    take(key, cost = 1) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, last: now };
        buckets.set(key, b);
      }
      b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
      b.last = now;
      if (b.tokens < cost) return false;
      b.tokens -= cost;
      return true;
    },
    stop() {
      clearInterval(sweep);
    },
  };
}

export function securityHeaders(config) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    // 'self' does not cover ws:// in every browser, so list the allowed origins explicitly.
    `connect-src 'self' ${[...config.allowedOrigins].map((o) => o.replace(/^http/, 'ws')).join(' ')}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()',
    );
    if (config.production) {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    next();
  };
}

export function isAllowedOrigin(config, origin) {
  return typeof origin === 'string' && config.allowedOrigins.has(origin);
}

// Blocks cross-site requests to state-changing endpoints (CSRF), on top of SameSite=Strict cookies.
export function requireSameOrigin(config) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (!isAllowedOrigin(config, req.get('origin'))) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    const hasBody = req.headers['transfer-encoding'] || (req.headers['content-length'] ?? '0') !== '0';
    if (hasBody && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    next();
  };
}

export function clientIp(req, config) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    // Use the last hop: it was added by our proxy, earlier entries come from the client and can be forged.
    if (typeof fwd === 'string' && fwd) return fwd.split(',').pop().trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
