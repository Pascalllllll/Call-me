import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { server, close } = createApp(config);

server.listen(config.port, config.host, () => {
  console.log(`Call-me listening on http://${config.host}:${config.port}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.production) {
    console.warn('Warning: listening on a public interface without NODE_ENV=production (no Secure cookies, no HSTS).');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await close();
    process.exit(0);
  });
}
