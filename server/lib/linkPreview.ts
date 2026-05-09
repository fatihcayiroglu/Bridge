// @ts-nocheck
// server/lib/linkPreview.js
// Link önizleme — TTL-bazlı PostgreSQL cache
// Process-restart'a dayanıklı, multi-instance uyumlu.
//
// Cache katmanı önceliği:
//   1. In-process LRU (Map, 200 entry, 5dk)  — aynı process içinde sıfır gecikme
//   2. PostgreSQL link_preview_cache tablosu  — instance'lar arası paylaşımlı
//   3. Dış HTTP isteği                        — fallback, sonuç her iki katmana yazılır
'use strict';

const logger = require('./logger');

const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

// ── In-process LRU cache (hız için) ──────────────────────────
const MEMORY_TTL_MS  = 5  * 60 * 1000;   // 5 dakika
const DB_TTL_MS      = 24 * 60 * 60 * 1000; // 24 saat
const MAX_MEMORY     = 200;              // maksimum giriş sayısı

const memCache = new Map();

function memGet(url) {
  const hit = memCache.get(url);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { memCache.delete(url); return null; }
  return hit.value;
}

function memSet(url, value) {
  if (memCache.size >= MAX_MEMORY) {
    // LRU eviction — en eski girişi at
    memCache.delete(memCache.keys().next().value);
  }
  memCache.set(url, { value, expiresAt: Date.now() + MEMORY_TTL_MS });
}

// ── PostgreSQL cache yardımcıları ────────────────────────────
let _db = null;
function getDb() {
  if (_db) return _db;
  try { _db = require('../db/loader'); } catch { _db = null; }
  return _db;
}

async function dbGet(url) {
  const db = getDb();
  if (!db) return null;
  try {
    // Direkt pool sorgusu — Collection API bu tabloyu wrap etmiyor
    if (db._pool || db.pool) {
      const pool = db._pool || db.pool;
      const { rows } = await pool.query(
        'SELECT data FROM link_preview_cache WHERE url = $1 AND "expiresAt" > $2',
        [url, Date.now()]
      );
      if (rows.length > 0) return rows[0].data;
    }
  } catch (err) {
    logger.debug({ err: err.message }, '[linkPreview] dbGet error (non-fatal)');
  }
  return null;
}

async function dbSet(url, value) {
  const db = getDb();
  if (!db) return;
  try {
    if (db._pool || db.pool) {
      const pool = db._pool || db.pool;
      const now = Date.now();
      await pool.query(
        `INSERT INTO link_preview_cache (url, data, "fetchedAt", "expiresAt")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (url) DO UPDATE
           SET data = EXCLUDED.data, "fetchedAt" = EXCLUDED."fetchedAt", "expiresAt" = EXCLUDED."expiresAt"`,
        [url, JSON.stringify(value), now, now + DB_TTL_MS]
      );
    }
  } catch (err) {
    logger.debug({ err: err.message }, '[linkPreview] dbSet error (non-fatal)');
  }
}

// ── Periyodik temizlik (process başına tek seferlik) ──────────
// Süresi dolmuş kayıtları her saatte bir temizler — büyüyen tablo sorununu önler.
let _cleanupStarted = false;
function startCleanupJob() {
  if (_cleanupStarted) return;
  _cleanupStarted = true;
  setInterval(async () => {
    const db = getDb();
    if (!db) return;
    try {
      const pool = db._pool || db.pool;
      if (pool) {
        const { rowCount } = await pool.query(
          'DELETE FROM link_preview_cache WHERE "expiresAt" < $1', [Date.now()]
        );
        if (rowCount > 0) logger.debug({ rowCount }, '[linkPreview] Expired cache entries removed');
      }
    } catch { /* non-fatal */ }
  }, 60 * 60 * 1000).unref(); // .unref() — process'i bloklamasın
}

// ── Güvenlik: private IP kontrolü ────────────────────────────
function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

// ── URL yardımcısı ────────────────────────────────────────────
function extractUrls(text, limit = 3) {
  if (!text) return [];
  return [...new Set((String(text).match(URL_REGEX) || []).slice(0, limit))];
}

// ── Ana fetch fonksiyonu ──────────────────────────────────────
async function fetchLinkPreview(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (isPrivateHostname(parsed.hostname)) return null;

    const cacheKey = parsed.toString();

    // 1. In-process cache
    const memHit = memGet(cacheKey);
    if (memHit) return memHit;

    // 2. PostgreSQL cache
    const dbHit = await dbGet(cacheKey);
    if (dbHit) {
      memSet(cacheKey, dbHit); // L1'e de yaz
      return dbHit;
    }

    // 3. Dış HTTP isteği
    const fetchFn = globalThis.fetch;
    if (!fetchFn) return null;

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 4000);
    const res  = await fetchFn(url, {
      signal:  ctrl.signal,
      headers: { 'User-Agent': 'BridgeBot/1.0 (link preview)' },
    });
    clearTimeout(tid);

    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;

    const html = await res.text();

    const getMeta = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return m ? m[1].trim() : null;
    };

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = getMeta('og:title') || (titleMatch ? titleMatch[1].trim() : null);
    if (!title) return null;

    const value = {
      type:        'link',
      url,
      title:       title.slice(0, 200),
      description: (getMeta('og:description') || getMeta('description') || '').slice(0, 300) || null,
      image:       getMeta('og:image') || null,
      siteName:    getMeta('og:site_name') || parsed.hostname,
    };

    // Her iki katmana yaz
    memSet(cacheKey, value);
    dbSet(cacheKey, value).catch(() => {}); // async, non-blocking

    startCleanupJob(); // ilk başarılı fetch'te cleanup job'ı başlat

    return value;
  } catch {
    return null;
  }
}

// Test ortamında cache'i resetlemek için kullanılır
function _resetCache() {
  memCache.clear();
}

module.exports = { extractUrls, fetchLinkPreview, _resetCache };
export {};
