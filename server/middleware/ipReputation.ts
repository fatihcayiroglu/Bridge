// server/middleware/ipReputation.ts
// IP Reputation Kontrolü — üç katmanlı kontrol:
//   1. Statik yerel blocklist (IP_BLOCKLIST_PATH)
//   2. AbuseIPDB API (ABUSEIPDB_KEY tanımlıysa)
//   3. Tor çıkış düğümleri (BLOCK_TOR=true)

import logger from '../lib/logger';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { getClientIp } from './ipBan';

// ── Yapılandırma ────────────────────────────────────────────
interface Config {
  enabled: boolean;
  abuseIpDbKey: string | null;
  abuseThreshold: number;
  cacheTtlMs: number;
  blocklistPath: string | null;
  blockTor: boolean;
  torListUrl: string;
  torRefreshMs: number;
}

const CONFIG: Config = {
  enabled:        (process.env.IP_REPUTATION_ENABLED ?? 'true') !== 'false',
  abuseIpDbKey:   process.env.ABUSEIPDB_KEY || null,
  abuseThreshold: parseInt(process.env.ABUSEIPDB_THRESHOLD ?? '80', 10),
  cacheTtlMs:     parseInt(process.env.ABUSEIPDB_CACHE_TTL ?? '3600', 10) * 1000,
  blocklistPath:  process.env.IP_BLOCKLIST_PATH || null,
  blockTor:       process.env.BLOCK_TOR === 'true',
  torListUrl:     'https://check.torproject.org/torbulkexitlist',
  torRefreshMs:   6 * 60 * 60 * 1000,
};

// ── In-memory cache ─────────────────────────────────────────
interface CacheEntry {
  blocked: boolean;
  reason?: string;
  score?: number;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

// ── Statik blocklist ─────────────────────────────────────────
let _staticBlocklist = new Set<string>();

function _loadBlocklist(): void {
  if (!CONFIG.blocklistPath) return;
  try {
    const resolved = path.resolve(CONFIG.blocklistPath);
    const lines = fs.readFileSync(resolved, 'utf8').split('\n');
    _staticBlocklist = new Set(
      lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    );
    logger.info(`[ipReputation] Statik blocklist yüklendi: ${_staticBlocklist.size} kayıt`);
  } catch (err) {
    logger.warn(`[ipReputation] Blocklist okunamadı (${CONFIG.blocklistPath}): ${(err as Error).message}`);
  }
}

function _ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

export function _ipInCidr(ip: string, cidr: string): boolean {
  try {
    const [network, bits] = cidr.split('/');
    if (!bits) return ip === cidr;
    const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
    const ipInt = _ipToInt(ip);
    const netInt = _ipToInt(network);
    return (ipInt & mask) === (netInt & mask);
  } catch { return false; }
}

function _isInStaticBlocklist(ip: string): boolean {
  if (_staticBlocklist.has(ip)) return true;
  for (const entry of _staticBlocklist) {
    if (entry.includes('/') && _ipInCidr(ip, entry)) return true;
  }
  return false;
}

// ── Tor çıkış listesi ────────────────────────────────────────
let _torExitNodes = new Set<string>();
let _torLastFetch = 0;

async function _refreshTorList(): Promise<void> {
  if (!CONFIG.blockTor) return;
  const now = Date.now();
  if (now - _torLastFetch < CONFIG.torRefreshMs) return;
  _torLastFetch = now;
  try {
    const text = await _httpsGet(CONFIG.torListUrl, {}, 5000);
    _torExitNodes = new Set(
      text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    );
    logger.info(`[ipReputation] Tor exit listesi güncellendi: ${_torExitNodes.size} düğüm`);
  } catch (err) {
    logger.warn('[ipReputation] Tor listesi alınamadı:', (err as Error).message);
  }
}

// ── AbuseIPDB sorgusu ────────────────────────────────────────
function _httpsGet(url: string, headers: Record<string, string>, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

interface AbuseResult {
  score: number;
  blocked: boolean;
  isTor: boolean;
  country: string;
  domain: string;
  totalReports: number;
}

async function _queryAbuseIPDB(ip: string): Promise<AbuseResult | null> {
  if (!CONFIG.abuseIpDbKey) return null;
  if (_isPrivateIp(ip)) return null;
  try {
    const url = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose`;
    const raw = await _httpsGet(url, {
      'Key':    CONFIG.abuseIpDbKey,
      'Accept': 'application/json',
    });
    const json = JSON.parse(raw) as { data?: Record<string, unknown> };
    const data = json?.data;
    if (!data) return null;
    const score = (data.abuseConfidenceScore as number) ?? 0;
    return {
      score,
      blocked:      score >= CONFIG.abuseThreshold,
      isTor:        !!(data.isTor),
      country:      data.countryCode as string,
      domain:       data.domain as string,
      totalReports: (data.totalReports as number) ?? 0,
    };
  } catch (err) {
    logger.warn(`[ipReputation] AbuseIPDB sorgu hatası (${ip}):`, (err as Error).message);
    return null;
  }
}

export function _isPrivateIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

// ── Cache yardımcıları ───────────────────────────────────────
function _getCached(ip: string): CacheEntry | undefined {
  const entry = _cache.get(ip);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _cache.delete(ip); return undefined; }
  return entry;
}

function _setCached(ip: string, value: Omit<CacheEntry, 'expiresAt'>): void {
  const ttl = value.blocked ? CONFIG.cacheTtlMs : CONFIG.cacheTtlMs / 4;
  _cache.set(ip, { ...value, expiresAt: Date.now() + ttl });
}

// ── Ortak kontrol fonksiyonu ─────────────────────────────────
export async function checkIpReputation(ip: string): Promise<{ blocked: boolean; reason?: string; score?: number }> {
  if (!CONFIG.enabled) return { blocked: false };
  if (!ip || ip === 'unknown') return { blocked: false };
  if (_isPrivateIp(ip)) return { blocked: false };

  const cached = _getCached(ip);
  if (cached !== undefined) return cached;

  if (_isInStaticBlocklist(ip)) {
    const result = { blocked: true, reason: 'Statik IP engel listesinde' };
    _setCached(ip, result);
    return result;
  }

  await _refreshTorList();
  if (CONFIG.blockTor && _torExitNodes.has(ip)) {
    const result = { blocked: true, reason: 'Tor çıkış düğümü' };
    _setCached(ip, result);
    return result;
  }

  const abuse = await _queryAbuseIPDB(ip);
  if (abuse?.blocked) {
    const result = {
      blocked: true,
      reason: `AbuseIPDB güvenilirlik puanı çok yüksek (${abuse.score}/100)`,
      score: abuse.score,
    };
    _setCached(ip, result);
    return result;
  }

  const result = { blocked: false };
  _setCached(ip, result);
  return result;
}

// ── Express middleware ───────────────────────────────────────
export async function ipReputationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!CONFIG.enabled) { next(); return; }

  if (
    req.path.startsWith('/api/admin') ||
    req.path.startsWith('/api/health') ||
    req.path.startsWith('/api/docs')
  ) { next(); return; }

  try {
    const ip = getClientIp(req);
    const result = await checkIpReputation(ip);
    if (result.blocked) {
      res.status(403).json({
        error: 'Erişim reddedildi: IP adresiniz engel listesinde.',
        reason: result.reason,
      });
      return;
    }
    next();
  } catch (err) {
    logger.error('[ipReputation] middleware error:', (err as Error).message);
    next();
  }
}

// ── Cache yönetim yardımcıları (test + admin) ────────────────
export function _clearCache(): void { _cache.clear(); }
export function _setCacheEntry(ip: string, val: Omit<CacheEntry, 'expiresAt'>): void { _setCached(ip, val); }
export function _setStaticBlocklist(set: Set<string>): void { _staticBlocklist = set; }
export function _setTorExitNodes(set: Set<string>): void { _torExitNodes = set; _torLastFetch = Date.now(); }
export function _setConfig(overrides: Partial<Config>): void { Object.assign(CONFIG, overrides); }
export function _getConfig(): Config { return { ...CONFIG }; }

_loadBlocklist();
