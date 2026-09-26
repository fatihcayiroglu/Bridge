#!/usr/bin/env node
'use strict';

// Dependency-free contract for the Electron shell. The web client and native
// shell must advertise the same ten stable locales, every native string key
// must exist in every locale, privileged IPC must verify its sender, and the
// desktop fallback CSP must never re-introduce unsafe-inline/eval.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'electron');
const EXPECTED = ['tr','en','es','ru','ja','ko','zh','pt','de','fr'];
const nativeFile = path.join(ELECTRON, 'nativeLocale.ts');
const mainFile = path.join(ELECTRON, 'main.ts');
const updaterFile = path.join(ELECTRON, 'updater.ts');
const ipcFile = path.join(ELECTRON, 'ipcSecurity.ts');
const clientIndex = path.join(ROOT, 'client/js/core/i18n/index.ts');

const errors = [];
const read = (p) => fs.readFileSync(p, 'utf8');
const native = read(nativeFile);
const main = read(mainFile);
const updater = read(updaterFile);
const ipc = read(ipcFile);
const client = read(clientIndex);

function sortedUnique(items) { return [...new Set(items)].sort(); }
function same(a,b) { return a.length === b.length && a.every((v,i) => v === b[i]); }
function stripComments(src) {
  let out = '', i = 0, quote = null, esc = false;
  while (i < src.length) {
    const c = src[i], n = src[i+1];
    if (quote) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { out += '  '; i += 2; while (i < src.length && !(src[i] === '*' && src[i+1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } if (i < src.length) { out += '  '; i += 2; } continue; }
    out += c; i++;
  }
  return out;
}

const localeType = native.match(/export type NativeLocale\s*=([\s\S]*?);/);
const nativeLocales = localeType ? sortedUnique([...localeType[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
if (!same(nativeLocales, [...EXPECTED].sort())) errors.push(`NativeLocale mismatch: ${nativeLocales.join(',')}`);

const clientLocaleType = client.match(/export type Locale\s*=([\s\S]*?);/);
const clientLocales = clientLocaleType ? sortedUnique([...clientLocaleType[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
if (!same(clientLocales, [...EXPECTED].sort())) errors.push(`client Locale mismatch: ${clientLocales.join(',')}`);

const keyType = native.match(/export type NativeTextKey\s*=([\s\S]*?);/);
const requiredKeys = keyType ? sortedUnique([...keyType[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
if (!requiredKeys.length) errors.push('NativeTextKey union could not be parsed');

for (const locale of EXPECTED) {
  const marker = new RegExp(`\\n\\s{2}${locale}:\\s*\\{`);
  const found = marker.exec(native);
  if (!found) { errors.push(`missing native locale block: ${locale}`); continue; }
  const start = found.index + found[0].length;
  let depth = 1, i = start, quote = null, esc = false;
  for (; i < native.length && depth > 0; i++) {
    const c = native[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  const body = native.slice(start, i - 1);
  const keys = sortedUnique([...body.matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map(m => m[1]));
  const missing = requiredKeys.filter(k => !keys.includes(k));
  const extra = keys.filter(k => !requiredKeys.includes(k));
  if (missing.length || extra.length) errors.push(`${locale}: missing=[${missing}] extra=[${extra}]`);
}

const sourceNoComments = stripComments(main + '\n' + updater);
for (const bad of ['unsafe-inline','unsafe-eval']) {
  const literal = new RegExp(`(["'\\x60])(?:(?!\\1)[^\\n])*${bad}(?:(?!\\1)[^\\n])*\\1`);
  if (literal.test(sourceNoComments)) errors.push(`Electron CSP/string literal contains ${bad}`);
}

const requiredMainSnippets = [
  "shellText('openBridge')", "shellText('notifications')", "shellText('voiceDiagnostics')",
  "shellText('systemStatus')", "shellText('checkUpdates')", "shellText('installRestart')",
  "shellText('quit')", "shellText('about')", "shellText('view')", "shellText('reload')",
  "shellText('changeServer')", "shellText('startWithWindows')",
  "isTrustedIpcSender(event)", "isConnectPageSender(event)",
];
for (const snippet of requiredMainSnippets) if (!main.includes(snippet)) errors.push(`main.ts missing contract: ${snippet}`);

for (const channel of ['updater:getStatus','updater:check','updater:install']) {
  const rx = new RegExp(`ipcMain\\.handle\\('${channel.replace(':','\\:')}'[\\s\\S]{0,180}assertTrustedIpcSender\\(event\\)`);
  if (!rx.test(updater)) errors.push(`updater IPC lacks trusted-sender assertion: ${channel}`);
}
// Final21 Phase 12: the bundled-server IPC (server:start/stop/restart/getStatus) is
// gone. The privileged local channels are now the connect-page channels, which
// must verify that the sender is the local connect page in the connect window.
for (const channel of ['desktop:connect-context','desktop:connect']) {
  const pos = main.indexOf(`ipcMain.handle('${channel}'`);
  if (pos < 0 || !/isConnectPageSender\(event\)/.test(main.slice(pos, pos + 200))) errors.push(`connect IPC lacks connect-page sender check: ${channel}`);
}
for (const retired of ['server:start','server:stop','server:restart','server:getStatus']) {
  if (main.includes(`'${retired}'`)) errors.push(`retired bundled-server IPC channel is back: ${retired}`);
}
if (!/ipcMain\.on\('bridge:notify'[\s\S]{0,220}isTrustedIpcSender\(event\)/.test(main)) errors.push('bridge:notify lacks trusted-sender check');
if (!/isSameAppOrigin\(url\)/.test(ipc)) errors.push('ipcSecurity.ts does not bind trust to same-app origin');

const oldTurkishChrome = ['Bridge\'i Aç','Bildirimler','Ses Tanılaması','Sistem Durumu','Güncellemeleri Kontrol Et','Güncellemeyi Kur ve Yeniden Başlat','Çıkış','Bridge Hakkında','Görünüm','Yakınlaştır','Uzaklaştır','Sıfırla'];
for (const text of oldTurkishChrome) {
  if (main.includes(text) || updater.includes(text)) errors.push(`native chrome still hardcoded outside nativeLocale.ts: ${text}`);
}

if (errors.length) {
  console.error('❌ Electron native i18n/security contract failed:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`✅ Electron native shell: ${EXPECTED.length} locales × ${requiredKeys.length} keys; CSP + privileged IPC sender checks PASS.`);
