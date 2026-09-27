#!/usr/bin/env node
'use strict';

/**
 * scripts/deterministic-zip.js — YENIDEN URETILEBILIR ZIP YAZICISI
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NEDEN VAR
 * ════════════════════════════════════════════════════════════════════════════
 * Surum paketi `bsdtar`/`zip`e devrediliyordu. Ikisi de ZIP girdilerine
 * DOSYA DEGISTIRME ZAMANINI yazar ve girdileri dizin gezinme sirasina gore
 * dizer. `copyReleaseTree` her kosumda dosyalari yeniden kopyaladigi icin
 * mtime'lar degisir; sonuc:
 *
 *     AYNI KAYNAK  →  FARKLI ZIP BAYTLARI  →  FARKLI SHA-256
 *
 * Olculdu (Final19): ayni agactan iki paketleme
 *     df53bfebea697e090da6cf66ed77ab1a9052702dad59eaa31b9da011c64054c8
 *     c338156bf00f4dbe566fb15562aa76163756e8dc1bf55572e8d575ab16dc4c4d
 *
 * Bu, surum butunlugu icin gercek bir eksikti: iki taraf ayni kaynagi
 * paketleyip SHA karsilastiramiyordu.
 *
 * ── NORMALIZE EDILEN HER SEY ───────────────────────────────────────────────
 *   · GIRDI SIRASI      — POSIX yol adina gore kesin siralama (dizinler once)
 *   · ZAMAN DAMGASI     — TUM girdiler icin sabit (1980-01-01 00:00:00, ZIP
 *                         formatinin taban tarihi). Dosya mtime'i KULLANILMAZ.
 *   · SIKISTIRMA        — deflateRaw, sabit seviye
 *   · DIS OZNITELIKLER  — dosya 0644, dizin 0755 (calisma platformunun
 *                         izinleri SIZDIRILMAZ)
 *   · YOL KODLAMASI     — UTF-8, bayrak biti 11 her zaman set
 *   · EK ALANLAR        — YOK (arac/zaman damgasi meta verisi tasimazlar)
 *   · ZIP64             — kullanilmaz; agac sinirlarin cok altinda ve varligi
 *                         cikti bayrtlarini degistirirdi
 *
 * ── SOZLESMENIN SINIRI (DURUSTCE) ──────────────────────────────────────────
 * Deflate ciktisi zlib SURUMUNE baglidir. Bu yazici "ayni kaynak + ayni
 * Node/zlib surumu → ayni baytlar" garantisi verir. Farkli bir zlib surumu
 * farkli (ama gecerli) sikistirma uretebilir; bu, yeniden uretilebilir
 * derlemelerde bilinen ve kabul edilen sinirdir.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * ZIP taban tarihi: 1980-01-01 00:00:00.
 * DOS tarih/saat alanlari 1980 oncesini TEMSIL EDEMEZ; bu yuzden en dusuk
 * gecerli deger secilir ve her girdiye aynen yazilir.
 */
const DOS_TIME = 0;                 // 00:00:00
const DOS_DATE = (1 << 9) | (1 << 5) | 1; // 1980-01-01

const EXTERNAL_ATTR_FILE = (0o100644 << 16) >>> 0;
const EXTERNAL_ATTR_DIR  = ((0o040755 << 16) >>> 0) | 0x10; // 0x10 = MS-DOS dizin biti
const VERSION_MADE_BY = 0x031E;     // UNIX (3) + ZIP 3.0
const VERSION_NEEDED  = 20;         // 2.0 — deflate
const FLAG_UTF8       = 0x0800;     // bit 11
const METHOD_DEFLATE  = 8;
const METHOD_STORE    = 0;

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

/** Agaci POSIX yollariyla, dizinler ve dosyalar ayri olacak sekilde toplar. */
function collect(rootParent, rootName) {
  const dirs = [];
  const files = [];
  function walk(relative) {
    const absolute = path.join(rootParent, relative);
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`deterministic-zip: symbolic link is not packable: ${childRelative}`);
      }
      if (entry.isDirectory()) {
        dirs.push(childRelative);
        walk(childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      } else {
        throw new Error(`deterministic-zip: unsupported entry type: ${childRelative}`);
      }
    }
  }
  dirs.push(rootName);
  walk(rootName);
  // Kesin siralama: platformun readdir sirasi ciktiyi ETKILEMEMELI.
  dirs.sort();
  files.sort();
  return { dirs, files };
}

function localHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAG_UTF8, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.nameBuffer.length, 26);
  header.writeUInt16LE(0, 28); // ek alan yok
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(VERSION_MADE_BY, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(FLAG_UTF8, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.nameBuffer.length, 28);
  header.writeUInt16LE(0, 30); // ek alan
  header.writeUInt16LE(0, 32); // yorum
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // ic oznitelik
  header.writeUInt32LE(entry.externalAttr, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

/**
 * `rootParent/rootName` agacini `archivePath`e yeniden uretilebilir bicimde yazar.
 * Yazilan girdi sayisini dondurur.
 */
function writeDeterministicZip(rootParent, rootName, archivePath, options = {}) {
  const level = options.level === undefined ? 9 : options.level;
  const { dirs, files } = collect(rootParent, rootName);

  const chunks = [];
  const entries = [];
  let offset = 0;

  const push = (buffer) => { chunks.push(buffer); offset += buffer.length; };

  for (const dir of dirs) {
    const nameBuffer = Buffer.from(`${dir}/`, 'utf8');
    const entry = {
      nameBuffer, method: METHOD_STORE, crc: 0,
      compressedSize: 0, size: 0,
      externalAttr: EXTERNAL_ATTR_DIR, offset,
    };
    entries.push(entry);
    push(localHeader(entry));
    push(nameBuffer);
  }

  for (const file of files) {
    const nameBuffer = Buffer.from(file, 'utf8');
    const data = fs.readFileSync(path.join(rootParent, file));
    const deflated = data.length === 0 ? Buffer.alloc(0) : zlib.deflateRawSync(data, { level });
    // Sikistirma buyuttuyse DUZ SAKLA — hem kucuk hem de kararli bir karar.
    const useStore = data.length === 0 || deflated.length >= data.length;
    const payload = useStore ? data : deflated;
    const entry = {
      nameBuffer,
      method: useStore ? METHOD_STORE : METHOD_DEFLATE,
      crc: crc32(data),
      compressedSize: payload.length,
      size: data.length,
      externalAttr: EXTERNAL_ATTR_FILE,
      offset,
    };
    entries.push(entry);
    push(localHeader(entry));
    push(nameBuffer);
    push(payload);
  }

  const centralStart = offset;
  for (const entry of entries) {
    push(centralHeader(entry));
    push(entry.nameBuffer);
  }
  const centralSize = offset - centralStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // arsiv yorumu yok
  chunks.push(eocd);

  if (entries.length > 0xffff) {
    throw new Error('deterministic-zip: entry count needs ZIP64, which this writer does not emit');
  }
  fs.writeFileSync(archivePath, Buffer.concat(chunks));
  return entries.length;
}

module.exports = { writeDeterministicZip };
