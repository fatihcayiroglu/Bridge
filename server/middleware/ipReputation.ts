// server/middleware/ipReputation.ts
// IP Reputation Kontrolü — üç katmanlı kontrol:
//   1. Statik yerel blocklist (IP_BLOCKLIST_PATH)
//   2. AbuseIPDB API (ABUSEIPDB_KEY tanımlıysa)
//   3. Tor çıkış düğümleri (BLOCK_TOR=true)

import logger from '../lib/logger';
import https from 'https';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { Request, Response, NextFunction } from 'express';
import { getClientIp } from './ipBan';
import { envSafeInt } from '../lib/envNumbers';

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
  abuseThreshold: envSafeInt('ABUSEIPDB_THRESHOLD', 80, { min: 0, max: 100 }),
  cacheTtlMs:     envSafeInt('ABUSEIPDB_CACHE_TTL', 3_600, { min: 1, max: 7 * 24 * 60 * 60 }) * 1000,
  blocklistPath:  process.env.IP_BLOCKLIST_PATH || null,
  blockTor:       process.env.BLOCK_TOR === 'true',
  torListUrl:     'https://check.torproject.org/torbulkexitlist',
  torRefreshMs:   6 * 60 * 60 * 1000,
};

// Reputation providers are external trust boundaries. Never send non-public
// addresses (including IPv6 ULA/link-local or IPv4-mapped IPv6) to them.
// Node's BlockList gives us one canonical range matcher instead of hand-rolled
// octet logic that only covered part of IPv4.
const _nonPublicIps = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
] as const) _nonPublicIps.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
] as const) _nonPublicIps.addSubnet(address, prefix, 'ipv6');

// ── In-memory cache ─────────────────────────────────────────
interface CacheEntry {
  blocked: boolean;
  reason?: string;
  score?: number;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();
const IP_REPUTATION_CACHE_MAX = 100_000;

function _pruneCache(now = Date.now()): void {
  for (const [ip, entry] of _cache) {
    if (entry.expiresAt <= now) _cache.delete(ip);
  }
  while (_cache.size >= IP_REPUTATION_CACHE_MAX) {
    const oldest = _cache.keys().next().value as string | undefined;
    if (!oldest) break;
    _cache.delete(oldest);
  }
}

setInterval(_pruneCache, 5 * 60_000).unref();

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
  if (net.isIP(ip) !== 4) throw new TypeError('IPv4 address required');
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

export function _ipInCidr(ip: string, cidr: string): boolean {
  try {
    const pieces = cidr.split('/');
    if (pieces.length === 1) return net.isIP(ip) === 4 && net.isIP(cidr) === 4 && ip === cidr;
    if (pieces.length !== 2) return false;
    const [network, bitsRaw] = pieces;
    if (network === undefined || bitsRaw === undefined) return false;
    if (!/^\d{1,2}$/.test(bitsRaw) || net.isIP(network) !== 4 || net.isIP(ip) !== 4) return false;
    const bits = Number(bitsRaw);
    if (!Number.isSafeInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
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
  const normalized = String(ip).trim().replace(/^::ffff:/i, '');
  const family = net.isIP(normalized);
  if (family === 4) return _nonPublicIps.check(normalized, 'ipv4');
  if (family === 6) return _nonPublicIps.check(normalized, 'ipv6');
  // Invalid input is not a legitimate public address. Treat it as non-public
  // so malformed proxy/header state is never exfiltrated to reputation APIs.
  return true;
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
  if (_cache.size >= IP_REPUTATION_CACHE_MAX) _pruneCache();
  _cache.delete(ip); // refresh insertion order for oldest-entry eviction
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
    // Provider/network failures are already converted to a clean allow result
    // inside checkIpReputation(). Reaching this boundary therefore means the
    // middleware itself could not establish the client's reputation state
    // (for example canonical IP resolution or an unexpected internal error).
    // Do not silently bypass the security layer in that case.
    logger.error('[ipReputation] middleware error:', (err as Error).message);
    res.status(503).json({ error: 'IP reputation service unavailable' });
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
