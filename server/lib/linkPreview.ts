// server/lib/linkPreview.ts — Oturum 15: memCache tipi, tüm yardımcı imzalar eklendi
// Link önizleme — TTL-bazlı PostgreSQL cache
// Process-restart'a dayanıklı, multi-instance uyumlu.

import logger from './logger';
import { fetchT } from './fetch';

const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

// ── Tipler ────────────────────────────────────────────────────
export interface LinkPreviewValue {
  type:        string;
  url:         string;
  title:       string;
  description: string | null;
  image:       string | null;
  siteName:    string;
}

interface MemCacheEntry {
  value:     LinkPreviewValue;
  expiresAt: number;
}

interface DbPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<{ data: LinkPreviewValue }>; rowCount: number }>;
}

interface DbLoader {
  _pool?: DbPool;
  pool?:  DbPool;
}

// ── In-process LRU cache ──────────────────────────────────────
const MEMORY_TTL_MS  = 5  * 60 * 1000;
const DB_TTL_MS      = 24 * 60 * 60 * 1000;
const MAX_MEMORY     = 200;

const memCache = new Map<string, MemCacheEntry>();

function memGet(url: string): LinkPreviewValue | null {
  const hit = memCache.get(url);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { memCache.delete(url); return null; }
  return hit.value;
}

function memSet(url: string, value: LinkPreviewValue): void {
  if (memCache.size >= MAX_MEMORY) {
    const firstKey = memCache.keys().next().value;
    if (firstKey !== undefined) memCache.delete(firstKey);
  }
  memCache.set(url, { value, expiresAt: Date.now() + MEMORY_TTL_MS });
}

// ── PostgreSQL cache yardımcıları ─────────────────────────────
let _db: DbLoader | null = null;
let _dbLoading = false;

async function getDb(): Promise<DbLoader | null> {
  if (_db) return _db;
  if (_dbLoading) return null;
  _dbLoading = true;
  try {
    _db = await import('../db/loader') as unknown as DbLoader;
  } catch { _db = null; }
  _dbLoading = false;
  return _db;
}

async function dbGet(url: string): Promise<LinkPreviewValue | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const pool = db._pool ?? db.pool;
    if (pool) {
      const { rows } = await pool.query(
        'SELECT data FROM link_preview_cache WHERE url = $1 AND "expiresAt" > $2',
        [url, Date.now()]
      );
      if (rows.length > 0) return rows[0].data;
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message }, '[linkPreview] dbGet error (non-fatal)');
  }
  return null;
}

async function dbSet(url: string, value: LinkPreviewValue): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    const pool = db._pool ?? db.pool;
    if (pool) {
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
    logger.debug({ err: (err as Error).message }, '[linkPreview] dbSet error (non-fatal)');
  }
}

// ── Periyodik temizlik ────────────────────────────────────────
let _cleanupStarted = false;

function startCleanupJob(): void {
  if (_cleanupStarted) return;
  _cleanupStarted = true;
  setInterval(async () => {
    const db = await getDb();
    if (!db) return;
    try {
      const pool = db._pool ?? db.pool;
      if (pool) {
        const { rowCount } = await pool.query(
          'DELETE FROM link_preview_cache WHERE "expiresAt" < $1', [Date.now()]
        );
        if (rowCount > 0) logger.debug({ rowCount }, '[linkPreview] Expired cache entries removed');
      }
    } catch { /* non-fatal */ }
  }, 60 * 60 * 1000).unref();
}

// ── URL yardımcısı ────────────────────────────────────────────
export function extractUrls(text: string, limit: number = 3): string[] {
  if (!text) return [];
  return [...new Set((String(text).match(URL_REGEX) || []).slice(0, limit))];
}

// ── Ana fetch fonksiyonu ──────────────────────────────────────
export async function fetchLinkPreview(url: string): Promise<LinkPreviewValue | null> {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    const cacheKey = parsed.toString();

    // 1. In-process cache
    const memHit = memGet(cacheKey);
    if (memHit) return memHit;

    // 2. PostgreSQL cache
    const dbHit = await dbGet(cacheKey);
    if (dbHit) {
      memSet(cacheKey, dbHit);
      return dbHit;
    }

    // ── Sprint 60: Spotify embed — OAuth gerektirmez, iframe yeterli ──
    // open.spotify.com/{track|album|playlist|episode|artist}/{id}
    if (parsed.hostname === 'open.spotify.com') {
      const parts = parsed.pathname.split('/').filter(Boolean); // ['track','3n3...']
      const validTypes = ['track', 'album', 'playlist', 'episode', 'artist'];
      if (parts.length >= 2 && validTypes.includes(parts[0])) {
        const embedType = parts[0];
        const embedId   = parts[1];
        const spotifyValue: LinkPreviewValue = {
          type:        'spotify',
          url,
          title:       `Spotify ${embedType.charAt(0).toUpperCase() + embedType.slice(1)}`,
          description: null,
          image:       null,
          siteName:    'Spotify',
          embedSrc:    `https://open.spotify.com/embed/${embedType}/${embedId}?utm_source=bridge&theme=0`,
          embedHeight: embedType === 'track' || embedType === 'episode' ? 80 : 352,
        } as LinkPreviewValue & { embedSrc: string; embedHeight: number };
        memSet(cacheKey, spotifyValue);
        dbSet(cacheKey, spotifyValue).catch(() => {});
        return spotifyValue;
      }
    }

    // 3. Dış HTTP isteği — fetchT ile SSRF koruması (DNS çözümlemeli)
    let res: Response;
    try {
      res = await fetchT(url, {
        timeoutMs: 4000,
        headers: { 'User-Agent': 'BridgeBot/1.0 (link preview)' },
      });
    } catch {
      // SSRFError dahil tüm ağ hataları → önizleme yok
      return null;
    }

    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;

    const html = await res.text();

    const getMeta = (prop: string): string | null => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return m ? m[1].trim() : null;
    };

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = getMeta('og:title') || (titleMatch ? titleMatch[1].trim() : null);
    if (!title) return null;

    const value: LinkPreviewValue = {
      type:        'link',
      url,
      title:       title.slice(0, 200),
      description: (getMeta('og:description') || getMeta('description') || '').slice(0, 300) || null,
      image:       getMeta('og:image') || null,
      siteName:    getMeta('og:site_name') || parsed.hostname,
    };

    memSet(cacheKey, value);
    dbSet(cacheKey, value).catch(() => {});

    startCleanupJob();

    return value;
  } catch {
    return null;
  }
}

/** Test ortamında cache'i resetlemek için kullanılır */
export function _resetCache(): void {
  memCache.clear();
}
