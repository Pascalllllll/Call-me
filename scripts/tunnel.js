// Starts a Cloudflare quick tunnel, then starts Call-me with the tunnel's random address allowed.
import { spawn } from 'node:child_process';

const bin = process.env.CLOUDFLARED || 'cloudflared';
const port = process.env.PORT || '3000';
let started = false;
let stopping = false;
let log = '';

const tunnel = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
  stdio: ['ignore', 'ignore', 'pipe'],
});

tunnel.on('error', (err) => {
  console.error(`Could not run ${bin} (${err.code || err.message}). Install cloudflared or set CLOUDFLARED to its path.`);
  process.exit(1);
});

tunnel.on('exit', (code) => {
  if (stopping) return;
  console.error(`cloudflared stopped (exit code ${code}).${started ? '' : `\n${log.trim()}`}`);
  process.exit(1);
});

tunnel.stderr.setEncoding('utf8');
tunnel.stderr.on('data', async (chunk) => {
  if (started) return;
  log += chunk;
  const url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url) return;
  started = true;
  Object.assign(process.env, { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: port, ALLOWED_ORIGINS: url, TRUST_PROXY: '1' });
  await import('../server/index.js');
  console.log(`\nCall-me is online at ${url}\nA new address can take a minute to start answering. Press Ctrl+C to stop.\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    tunnel.kill();
  });
}
process.on('exit', () => tunnel.kill());
