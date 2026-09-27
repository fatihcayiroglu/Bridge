// scripts/medialab/lib/browser.mjs
//
// One lab client = one real Chromium process running INSIDE the client's
// network namespace (Playwright talks to it over a pipe, which crosses the
// namespace boundary), loading the real Bridge web app and joining voice
// through the real UI. Media comes from Chromium's fake capture devices fed
// with per-client fixtures (fixtures.py), so every RTP packet is produced by
// the browser's real WebRTC stack: Opus/VP8 encoders, ICE, DTLS, SRTP.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const require = createRequire(path.join(REPO, 'e2e', 'package.json'));
const { chromium } = require('@playwright/test');
const INSTRUMENT = fs.readFileSync(path.join(HERE, 'page.js'), 'utf8');

export function chromiumBinary() {
  if (process.env.MEDIALAB_CHROME) return process.env.MEDIALAB_CHROME;
  // Playwright's own revision first (CI installs exactly that one), then any
  // Chromium build already present under PLAYWRIGHT_BROWSERS_PATH.
  const own = chromium.executablePath();
  if (own && fs.existsSync(own)) return own;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const bin = path.join(root, d, sub, 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  }
  throw new Error(`no Chromium found (Playwright expects ${own}); set MEDIALAB_CHROME`);
}

export function chromiumVersion() {
  return path.basename(path.dirname(path.dirname(chromiumBinary())));
}

function nsWrapper(workDir) {
  const file = path.join(workDir, 'chrome-in-netns.sh');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `#!/bin/sh\nexec ip netns exec "$MEDIALAB_NS" "${chromiumBinary()}" "$@"\n`, { mode: 0o755 });
  }
  return file;
}

function userIdFromToken(token) {
  try {
    return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).id ?? '');
  } catch { return ''; }
}

export class Client {
  constructor(lab, index, user) {
    this.lab = lab;
    this.index = index;
    this.user = user;
    this.name = `c${index}`;
    this.console = [];
  }

  get ns() { return `ml${this.index}`; }

  async launch() {
    const fx = this.lab.fixtures(this.index);
    this.browser = await chromium.launch({
      executablePath: nsWrapper(this.lab.workDir),
      env: { ...process.env, MEDIALAB_NS: this.ns },
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${fx.wav}`,
        `--use-file-for-fake-video-capture=${fx.y4m}`,
        '--autoplay-policy=no-user-gesture-required',
        `--unsafely-treat-insecure-origin-as-secure=${this.lab.baseUrl}`,
        '--auto-select-desktop-capture-source=Entire screen',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'tr-TR' });
    await this.context.addInitScript(INSTRUMENT);
    await this.setToken(this.user.token);
    const uid = userIdFromToken(this.user.token);
    await this.context.addInitScript((id) => {
      if (id) localStorage.setItem(`bridge_onboarding_v3:${id}`, 'done');
      localStorage.setItem('bridge_onboarding_v3:anon', 'done');
    }, uid);
    this.page = await this.context.newPage();
    this.page.on('console', (m) => {
      const text = m.text();
      if (/SFU|RTC|ICE|voice|error/i.test(text)) this.console.push({ t: Date.now(), type: m.type(), text: text.slice(0, 400) });
      if (this.console.length > 2000) this.console.splice(0, 500);
    });
    this.page.on('pageerror', (e) => this.console.push({ t: Date.now(), type: 'pageerror', text: String(e).slice(0, 400) }));
    return this;
  }

  async setToken(token) {
    this.user.token = token;
    await this.context.addInitScript((t) => {
      localStorage.setItem('token', t);
      localStorage.setItem('bridge_token', t);
    }, token);
  }

  async open() {
    await this.page.goto(this.lab.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.page.locator('#app').waitFor({ state: 'visible', timeout: 60_000 });
  }

  async selectServer(serverId) {
    const btn = this.page.locator(`.server-icon[data-id="${serverId}"]`).first();
    await btn.waitFor({ state: 'visible', timeout: 30_000 });
    await btn.click();
  }

  /** Canonical UI join. Returns the wall-clock time the click happened. */
  async joinVoice(room) {
    await this.selectServer(room.serverId);
    const btn = this.page.locator(`[aria-label="Ses kanalı: ${room.voiceName}"]`).first();
    await btn.waitFor({ state: 'visible', timeout: 30_000 });
    await this.page.evaluate(() => window.__mlStartWatch());
    const t0 = Date.now();
    await btn.click();
    await this.page.locator('#vc-mute:not([disabled])').waitFor({ state: 'visible', timeout: 30_000 });
    this.joinedAt = t0;
    this.room = room;
    return t0;
  }

  async leaveVoice() {
    const t = Date.now();
    await this.page.locator('button.vc-btn-danger:not([disabled])').first().click();
    return t;
  }

  async click(id) {
    const t = Date.now();
    await this.page.locator(`#${id}:not([disabled])`).click();
    return t;
  }

  async toggleMute() { return this.click('vc-mute'); }
  async toggleDeafen() { return this.click('vc-deafen'); }
  async toggleVideo() { return this.click('vc-video'); }

  async startScreenShare() {
    const t = await this.click('vc-screen');
    const quality = this.page.locator('#ss-quality-modal .ss-quality-btn').first();
    if (await quality.isVisible().catch(() => false)) await quality.click();
    else await quality.waitFor({ state: 'visible', timeout: 3_000 }).then(() => quality.click()).catch(() => {});
    return t;
  }

  /** The share view's own stop button (the dock is covered by that view). */
  async stopScreenShare() {
    const t = Date.now();
    const stop = this.page.locator('#ss-stop-btn');
    if (await stop.isVisible().catch(() => false)) await stop.click();
    else await this.page.locator('#vc-screen').click({ force: true });
    return t;
  }

  async sample() { return this.page.evaluate(() => window.__mlSample()); }
  async timeline(since = 0) { return this.page.evaluate((s) => window.__mlTimeline(s), since); }
  async events(since = 0) { return this.page.evaluate((s) => window.__mlEvents(s), since); }
  async liveCaptures() { return this.page.evaluate(() => window.__mlLiveCaptures()); }
  async uiState() {
    return this.page.evaluate(() => ({
      inVoice: !document.querySelector('#vc-mute')?.hasAttribute('disabled'),
      muted: document.querySelector('#vc-mute')?.getAttribute('aria-pressed') === 'true',
      deafened: document.querySelector('#vc-deafen')?.getAttribute('aria-pressed') === 'true',
      video: document.querySelector('#vc-video')?.getAttribute('aria-pressed') === 'true',
      screen: document.querySelector('#vc-screen')?.getAttribute('aria-pressed') === 'true',
      peers: document.querySelectorAll('#voice-peers [data-socket-id], #voice-peers .voice-peer').length,
    }));
  }

  async close() {
    try { await this.browser?.close(); } catch { /* already gone */ }
  }

  /** Browser process id (the real chrome, inside the namespace) for CPU/RSS. */
  browserPid() { return this.browser?.process?.()?.pid ?? null; }
}
