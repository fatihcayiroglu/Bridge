#!/usr/bin/env node
/* eslint-disable no-console */
//
// ════════════════════════════════════════════════════════════════════════════
// HER TEST DOSYASININ BİR SAHİBİ OLMALI — KOŞUCUYA SORARAK
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR: `plugins/tests/plugin-system.test.ts` (32 test) HİÇBİR koşucu
// tarafından çalıştırılmıyordu:
//
//   · sunucu Jest projesi `rootDir: server/` — `plugins/tests/`e ULAŞAMAZ
//   · kök `package.json` `test` betiği yalnızca `cd server && npm test`
//   · hiçbir CI işi `plugins/` klasörüne değinmiyor
//   · `plugins` bir npm workspace olarak ilan edilmiş ama `package.json`ı yok
//
// Hiç çalışmadığı için test ettiği kodun yanında sessizce çürüdü: sunucu Jest
// yapılandırmasıyla koşturulduğunda 32 testin 15'i BAŞARISIZ oldu —
// `validateManifest` artık `{ok, reasons}` döndürüyor, test hâlâ `true`
// bekliyordu.
//
// ── NEDEN DESEN EŞLEŞTİRME DEĞİL, KOŞUCUYA SORMA ───────────────────────────
// Bu kapının ilk sürümü sahipliği elle yazılmış yol desenleriyle çıkarıyordu
// ve İKİ KEZ yanlış çıktı — `client/vitest.config.mts` `js/**/__tests__/**`
// desenini de topluyordu, benim listem toplamıyordu. Yapılandırmayı ikinci kez
// tahmin eden bir kapı, koruduğunu sandığı şeyi kaçırır.
//
// Bu yüzden her koşucuya KENDİ listesi sorulur (`jest --listTests`,
// `vitest list`, `playwright test --list`). Tek doğruluk kaynağı koşucunun
// kendi yapılandırmasıdır; bu betik yalnızca birleşimi diskle karşılaştırır.
//
// Kullanım:
//   node scripts/verify-test-ownership.js [--json]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JEST_BIN = require.resolve('jest/bin/jest');
const VITEST_BIN = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

// ── Koşucular ───────────────────────────────────────────────────────────────
// `required: true` olan bir koşucu listelenemezse kapı KIRMIZI olur; sessizce
// atlanması, o koşucunun tüm dosyalarını "sahipsiz" gösterirdi.
const RUNNERS = [
  {
    name: 'server (jest)', cwd: 'server', required: true,
    cmd: [process.execPath, JEST_BIN, '--listTests'],
    parse: (out) => out.split('\n').map(l => l.trim()).filter(l => l && path.isAbsolute(l)),
  },
  {
    name: 'server (jest:pg)', cwd: 'server', required: true,
    cmd: [process.execPath, JEST_BIN, '-c', 'jest.pg.config.js', '--listTests'],
    parse: (out) => out.split('\n').map(l => l.trim()).filter(l => l && path.isAbsolute(l)),
  },
  {
    name: 'client (vitest)', cwd: 'client', required: true,
    cmd: [process.execPath, VITEST_BIN, 'list', '--config', 'vitest.config.mts', '--filesOnly'],
    parse: (out) => out.split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('>') && /\.(test|spec)\.[cm]?[jt]sx?$/.test(l))
      .map(l => path.resolve(ROOT, 'client', l)),
  },
  {
    // Bu kapı tarafından bulundu: `bot-sdk` bir jest yapılandırması ve `test`
    // betiği taşıyor ama HİÇBİR CI işi onu koşmuyordu. Süit derlenmiyordu bile
    // (`tsconfig.json` yalnızca `src/**` içeriyordu → `Cannot find name 'jest'`).
    name: 'bot-sdk (jest)', cwd: 'bot-sdk', required: true,
    cmd: [process.execPath, JEST_BIN, '--listTests'],
    parse: (out) => out.split('\n').map(l => l.trim()).filter(l => l && path.isAbsolute(l)),
  },
];

// ── Yapılandırmadan TÜRETİLEN sahiplikler ───────────────────────────────────
// Playwright `--list` bu depoda ASILI KALIYOR (config bir `webServer` ayağa
// kaldırıyor); Electron ve mobil koşucular da ağırdır. Node'un yerleşik test
// koşucusunda da Jest/Vitest benzeri bir salt-listeleme kipi yoktur. Bunları
// çalıştırmak yerine KENDİ yapılandırma/komut kaynakları okunur ve belirtilir.
// Yapılandırma değişirse bu liste de değişmelidir — o yüzden kaynak yazılıdır.
const CONFIG_OWNERS = [
  // package.json:33 test:release-integrity; quality-gate.yml ve quality-gate.sh
  // bu komutu ayrıca doğrudan çağırır.
  { owner: 'release integrity (node:test)', prefix: 'scripts/', suffixes: ['release-integrity.test.js', 'product-surface-contract.test.js', 'final23-adversarial-contract.test.js', 'backup-tools.test.js'] },
  // e2e/playwright.config.ts:18  testDir: './tests'
  // e2e/playwright.config.ts:23  testIgnore: ['**/tests-legacy/**']
  { owner: 'e2e (playwright)', prefix: 'e2e/tests/',      suffixes: ['.spec.ts', '.test.ts'] },
  // electron/jest.electron.config.ts:7  roots: ['<rootDir>/tests']
  // electron/jest.electron.config.ts:13 testMatch: ['**/*.test.ts']
  { owner: 'electron (jest)',  prefix: 'electron/tests/', suffixes: ['.test.ts'] },
  // jest.mobile.config.js:24  testMatch: ['<rootDir>/mobile/tests/**/*.test.{js,ts}']
  { owner: 'mobile (jest)',    prefix: 'mobile/tests/',   suffixes: ['.test.js', '.test.ts'] },
];

// ── BİLİNEN SAHİPSİZLER — GEREKÇELİ, JOKER YOK ─────────────────────────────
// Her giriş TEK bir dosyayı adlandırır ve NEDEN koşulmadığını söyler. Kapının
// amacı YENİ sahipsizliği yakalamaktır; bilinen borç görünür kalır ama CI'yi
// kalıcı kırmızıya çevirmez. Girişler çürüyemez: aşağıda, artık var olmayan
// bir dosyayı adlandıran giriş kapıyı kırmızıya çevirir.
const KNOWN_UNOWNED = {};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', '_archived_legacy']);
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.test.js', '.spec.ts', '.spec.js', '.pgtest.ts'];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (TEST_SUFFIXES.some(s => e.name.endsWith(s))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const norm = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();

const claimed = new Map();   // normalised path -> runner name
const runnerCounts = {};
const unavailable = [];

for (const r of RUNNERS) {
  let out;
  try {
    out = execFileSync(r.cmd[0], r.cmd.slice(1), {
      cwd: path.join(ROOT, r.cwd),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });
  } catch (err) {
    // Bazı koşucular test bulamayınca sıfırdan farklı çıkar; yine de stdout'u kullan.
    out = err.stdout ? String(err.stdout) : '';
    if (!out.trim()) {
      unavailable.push({ name: r.name, required: r.required, why: (err.message || '').split('\n')[0] });
      runnerCounts[r.name] = 0;
      continue;
    }
  }
  const files = r.parse(out);
  runnerCounts[r.name] = files.length;
  for (const f of files) if (!claimed.has(norm(f))) claimed.set(norm(f), r.name);
}

const onDisk = walk(ROOT).map(p => path.relative(ROOT, p).replace(/\\/g, '/'));

// Koşucuya sorulamayan projeler için yapılandırmadan türetilmiş sahiplik.
for (const rel of onDisk) {
  if (claimed.has(norm(path.join(ROOT, rel)))) continue;
  const c = CONFIG_OWNERS.find(o => rel.startsWith(o.prefix) && o.suffixes.some(x => rel.endsWith(x)));
  if (c) {
    claimed.set(norm(path.join(ROOT, rel)), c.owner);
    runnerCounts[c.owner] = (runnerCounts[c.owner] || 0) + 1;
  }
}

const unclaimed = onDisk.filter(rel => !claimed.has(norm(path.join(ROOT, rel))));
const knownDebt = unclaimed.filter(rel => rel in KNOWN_UNOWNED);
const orphans   = unclaimed.filter(rel => !(rel in KNOWN_UNOWNED));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ onDisk: onDisk.length, claimed: claimed.size, runnerCounts, orphans, unavailable }, null, 2));
} else {
  console.log('── Test dosyası sahiplik denetimi ' + '─'.repeat(28));
  console.log(`diskteki test dosyası      : ${onDisk.length}`);
  for (const [n, c] of Object.entries(runnerCounts)) console.log(`  ${n.padEnd(24)} : ${c}`);
  console.log(`koşucularca TALEP EDİLEN   : ${claimed.size}`);
  console.log(`SAHİPSİZ                   : ${orphans.length}`);
  console.log('─'.repeat(62));
}

let failed = false;

for (const u of unavailable) {
  const level = u.required ? '❌' : 'ℹ ';
  console.error(`${level} koşucu listelenemedi: ${u.name} — ${u.why}`);
  if (u.required) failed = true;
}

// Kendi kendini doğrulama: tarayıcı ya da listeleme çökmüşse kapı anlamsızdır
// ve SONSUZA DEK yeşil kalırdı.
if (onDisk.length < 100) {
  console.error(`\n❌ Yalnızca ${onDisk.length} test dosyası bulundu — disk tarayıcısı bozuk olmalı.`);
  failed = true;
}
if (claimed.size < 100) {
  console.error(`\n❌ Koşucular yalnızca ${claimed.size} dosya bildirdi — listeleme bozuk olmalı.`);
  failed = true;
}

if (knownDebt.length) {
  console.log('\nℹ  Bilinen sahipsiz dosyalar (gerekçeli, engelleyici değil):');
  for (const k of knownDebt) console.log(`   ${k}\n     -> ${KNOWN_UNOWNED[k]}`);
}

// Allowlist ÇÜRÜYEMEZ: artık var olmayan bir dosya için giriş tutmak, ileride
// gerçek bir sahipsizliği örten bir jokere dönüşürdü.
const staleAllow = Object.keys(KNOWN_UNOWNED).filter(k => !onDisk.includes(k));
if (staleAllow.length) {
  console.error('\n❌ KNOWN_UNOWNED artık var olmayan dosyalar içeriyor:');
  for (const k of staleAllow) console.error(`   ${k}`);
  failed = true;
}

if (orphans.length) {
  console.error('\n❌ Hiçbir koşucunun TALEP ETMEDİĞİ test dosyaları:\n');
  for (const o of orphans) console.error(`   ${o}`);
  console.error(
    "\nBu dosyalar CI'da ÇALIŞMAZ. Ya bir koşucuya bağlayın, ya kanıtla arşivleyin\n" +
    'RUNNERS listesine ekleyin.');
  failed = true;
}

if (failed) process.exit(1);
console.log('\n✅ Her test dosyası bir koşucu tarafından talep ediliyor.');
