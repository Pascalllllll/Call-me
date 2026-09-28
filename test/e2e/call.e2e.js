// End-to-end: two isolated browser users hold a real WebRTC call through the UI.
// Requires a local Chrome (CHROME_PATH, default /usr/bin/google-chrome).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';

const SHOTS = process.env.E2E_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'callme-shots-'));
const PASSWORD = 'e2e-password-123';

let app, base, browser, dir;
const problems = [];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callme-e2e-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = createApp(loadConfig({ port, dbPath: path.join(dir, 'e2e.db'), allowedOrigins: [base], iceServers: [] }));
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
    ],
  });
});

after(async () => {
  await browser?.close();
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Screenshots: ${SHOTS}`);
});

async function newUser(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Expose peer connections so the test can read real connection state and stats.
  await page.evaluateOnNewDocument(() => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...args) {
      const pc = new Native(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Native.prototype;
  });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${name} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  return page;
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => {
  await settle(); // let panel slide transitions finish
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

// Finds and clicks in one page-side step so a re-render can't detach the element in between.
async function clickText(page, selector, text) {
  await page.waitForFunction(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t && e.offsetParent !== null);
      if (!el) return false;
      (el.closest('button') || el).click();
      return true;
    },
    { timeout: 10_000 },
    selector,
    text,
  );
}

async function register(page, username, displayName) {
  await clickText(page, 'button', 'Create an account').catch(() => {});
  await page.waitForSelector('input[name=displayName]');
  await page.type('input[name=username]', username);
  await page.type('input[name=displayName]', displayName);
  await page.type('input[name=password]', PASSWORD);
  await page.click('form button[type=submit]');
}

async function waitConnected(page) {
  await page.waitForFunction(
    () => window.__pcs.length > 0 && window.__pcs.every((pc) => pc.connectionState === 'connected' || pc.connectionState === 'closed') && window.__pcs.some((pc) => pc.connectionState === 'connected'),
    { timeout: 20_000 },
  );
}

async function audioBytesReceived(page) {
  return page.evaluate(async () => {
    let total = 0;
    for (const pc of window.__pcs) {
      if (pc.connectionState !== 'connected') continue;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') total += r.bytesReceived;
      });
    }
    return total;
  });
}

test('two users meet, talk, share video and chat', { timeout: 120_000 }, async () => {
  const a = await newUser('A');
  await a.goto(base);
  await a.waitForSelector('.auth-card');
  await shot(a, '01-sign-in');
  await register(a, 'host_user', 'Hana Host');
  await clickText(a, 'button', 'Start a meeting');
  const invite = await a.waitForSelector('dialog input[aria-label="Invite link"]');
  const link = await invite.evaluate((el) => el.value);
  assert.match(link, new RegExp(`^${base}/i/[A-Za-z0-9_-]{20}$`));
  await shot(a, '02-invite-dialog');
  await a.keyboard.press('Escape');
  await a.waitForFunction(() => document.querySelectorAll('.stage .tile').length === 1);

  const b = await newUser('B');
  await b.goto(link);
  await b.waitForSelector('input[name=displayName]');
  await register(b, 'guest_user', 'Gabe Guest');
  await clickText(b, 'dialog button', "Join Hana Host's meeting");
  await b.waitForSelector('#composer');

  // Chat: B writes, A (sitting in the call) sees #general marked unread, then reads it live.
  await b.type('#composer', 'hello from B <b>not bold</b>');
  await b.keyboard.press('Enter');
  await b.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((p) => p.textContent.includes('hello from B')));
  await a.waitForSelector('.chan.unread');
  // Presence and live call state reach someone who joined mid-session.
  await b.waitForFunction(() => document.querySelector('.voice-peers')?.textContent.includes('Hana Host'));
  await a.waitForFunction(() => [...document.querySelectorAll('.member:not(.offline)')].some((m) => m.textContent.includes('Gabe Guest')));
  await b.waitForFunction(() => [...document.querySelectorAll('.member:not(.offline)')].some((m) => m.textContent.includes('Hana Host')));
  assert.equal(await a.evaluate(() => document.querySelector('.members').textContent.includes('false')), false);
  await shot(b, '03-chat');

  await clickText(b, '.chan .chan-name', 'Meeting room');
  await shot(b, '04-voice-preview');
  await clickText(b, 'button', 'Join call');

  await waitConnected(a);
  await waitConnected(b);
  await a.waitForFunction(() => document.querySelectorAll('.stage .tile').length === 2);
  await b.waitForFunction(() => document.querySelectorAll('.stage .tile').length === 2);

  // Audio really flows both ways (fake mic produces a tone).
  const before1 = await audioBytesReceived(a);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok((await audioBytesReceived(a)) > before1, 'A receives audio from B');
  assert.ok((await audioBytesReceived(b)) > 0, 'B receives audio from A');

  // Camera: B turns it on and A sees moving video in B's tile.
  await clickText(b, '.ctrl span', 'Start video');
  await a.waitForFunction(
    () => [...document.querySelectorAll('.tile')].some((t) => t.textContent.includes('Gabe Guest') && t.querySelector('video')?.videoWidth > 0),
    { timeout: 15_000 },
  );

  // Screen share from A shows up as its own tile for B.
  await clickText(a, '.ctrl span', 'Share screen');
  let screenShared = true;
  try {
    await b.waitForFunction(() => document.querySelector('.tile-screen video')?.videoWidth > 0, { timeout: 10_000 });
  } catch {
    screenShared = false;
  }

  // Mute state propagates.
  await clickText(a, '.ctrl span', 'Mute');
  await b.waitForFunction(() =>
    [...document.querySelectorAll('.tile')].some((t) => t.textContent.includes('Hana Host') && t.querySelector('[aria-label="Muted"]')),
  );
  await shot(a, '05-call-host');
  await shot(b, '06-call-guest');

  // Focus mode and responsive layout.
  await b.click('.tile-focus');
  await b.waitForSelector('.stage-focus');
  await shot(b, '07-focus');
  await b.setViewport({ width: 390, height: 844 });
  await shot(b, '08-mobile-call');
  const mobileLayout = await b.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    sidebarRight: document.querySelector('.sidebar').getBoundingClientRect().right,
  }));
  assert.equal(mobileLayout.overflow, false, 'no horizontal scroll on phones');
  assert.ok(mobileLayout.sidebarRight <= 0, `hidden sidebar fully off-screen (right edge ${mobileLayout.sidebarRight})`);
  await b.click('button[aria-label="Open channels"]');
  await shot(b, '09-mobile-nav');
  await b.setViewport({ width: 1280, height: 800 });
  await b.keyboard.press('Escape');

  // Leaving updates the other side.
  await clickText(b, '.ctrl span', 'Leave');
  await a.waitForFunction(() => document.querySelectorAll('.stage .tile:not(.tile-screen)').length === 1);

  // Opening a text channel fresh (here after a reload) shows its saved history.
  await clickText(b, '.chan .chan-name', 'general');
  await b.reload();
  await b.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((p) => p.textContent.includes('hello from B')), {
    timeout: 5000,
  });

  // Light theme renders.
  await a.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await shot(a, '10-light-theme');

  // Owner settings: members with role controls, invite list loads.
  await a.click('button[aria-label="Space settings"]');
  await a.waitForFunction(() => document.querySelector('dialog select[aria-label="Role for Gabe Guest"]'));
  await a.waitForFunction(() => !document.querySelector('dialog')?.textContent.includes('Loading invites'));
  await shot(a, '11-space-settings');
  await a.keyboard.press('Escape');
  await a.click('button[aria-label="Your settings"]');
  await a.waitForSelector('dialog select[aria-label="Theme"]');
  await shot(a, '12-user-settings');
  await a.keyboard.press('Escape');

  const csp = problems.filter((p) => /Content Security Policy|Refused to/i.test(p));
  assert.deepEqual(csp, [], 'no CSP violations');
  assert.deepEqual(problems, [], 'no console errors');
  assert.ok(screenShared, 'screen share reached the other participant');
});
