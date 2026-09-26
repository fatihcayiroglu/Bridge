// electron/tests/desktopSettings.test.ts

import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeServerUrl, readDesktopSettings, writeDesktopSettings } from '../desktopSettings';

describe('normalizeServerUrl', () => {
  it.each([
    ['chat.example.com', 'https://chat.example.com'],
    ['  https://chat.example.com/some/path?x=1#y ', 'https://chat.example.com'],
    ['https://chat.example.com:8443', 'https://chat.example.com:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ])('accepts %s as %s', (input, origin) => {
    expect(normalizeServerUrl(input)).toEqual({ ok: true, origin });
  });

  it('refuses plain HTTP to another machine — tokens and messages would travel in clear', () => {
    expect(normalizeServerUrl('http://chat.example.com')).toEqual({ ok: false, reason: 'insecure' });
    expect(normalizeServerUrl('http://192.168.1.20:3000')).toEqual({ ok: false, reason: 'insecure' });
  });

  it('refuses credentials embedded in the URL instead of silently dropping them', () => {
    expect(normalizeServerUrl('https://user:pass@chat.example.com')).toEqual({ ok: false, reason: 'credentials' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    [undefined, 'empty'],
    [42, 'empty'],
    ['file:///C:/Windows', 'invalid'],
    ['javascript://alert(1)', 'invalid'],
    ['https://', 'invalid'],
    ['ht tp://bad host', 'invalid'],
  ])('rejects %p as %s', (input, reason) => {
    expect(normalizeServerUrl(input)).toEqual({ ok: false, reason });
  });
});

describe('desktop settings file', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-desktop-settings-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips the server origin and leaves no temp file behind', () => {
    const file = path.join(dir, 'nested', 'desktop-settings.json');
    writeDesktopSettings(file, { serverOrigin: 'https://chat.example.com' });
    expect(readDesktopSettings(file)).toEqual({ serverOrigin: 'https://chat.example.com' });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['desktop-settings.json']);
  });

  it('falls back to defaults for a missing, corrupt or tampered file', () => {
    const file = path.join(dir, 'desktop-settings.json');
    expect(readDesktopSettings(file)).toEqual({ serverOrigin: null });
    fs.writeFileSync(file, '{ not json');
    expect(readDesktopSettings(file)).toEqual({ serverOrigin: null });
    fs.writeFileSync(file, JSON.stringify({ serverOrigin: 'http://evil.example.com' }));
    expect(readDesktopSettings(file)).toEqual({ serverOrigin: null });
  });
});
