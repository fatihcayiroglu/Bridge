process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';

// P7 B2 contract rules, executable. The design (docs/P7_TRUST_SOCIAL_FOUNDATION.md,
// "B2 design") promises that a step-up decision depends only on documented,
// bounded inputs: the client's signed grant, a static action catalog, the
// account's own settings and two cluster-wide counters. "No score, no
// reputation, no IP/geo/device input, no inference about the person."
// Until now that was prose. These checks fail if a change adds a new signal
// source to the step-up owner without updating the contract.

const serverRoot = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(serverRoot, rel), 'utf8');
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keeps URLs like https://)

const OWNERS = ['lib/stepUp.ts', 'routes/stepUp.ts'];

describe('P7 B2: step-up signals are the documented ones', () => {
  it('reads no network, device, locale or location attribute of the request', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['client IP', /\breq\.ips?\b|remoteAddress|x-forwarded|x-real-ip|cf-connecting-ip/i],
      ['device / browser', /user-agent|userAgent|sec-ch-ua|fingerprint/i],
      ['locale', /accept-language/i],
      ['location', /\bgeo(ip|location)?\b|country|timezone/i],
      ['the suspicious-login fingerprint (B3 owns it)', /checkSuspiciousLogin|lib\/captcha|\.\/captcha/],
      ['a score or reputation', /\b(risk|trust|reputation)Score\b|\bscore\s*[:=]/i],
    ];
    for (const rel of OWNERS) {
      const src = code(rel);
      for (const [what, re] of forbidden) {
        expect({ file: rel, what, match: src.match(re)?.[0] ?? null }).toEqual({ file: rel, what, match: null });
      }
    }
  });

  it('reads exactly one request header: the step-up grant', () => {
    for (const rel of OWNERS) {
      const src = code(rel);
      const headerReads = src.match(/req\.(headers\s*\[[^\]]*\]|headers\.[A-Za-z_-]+|get\([^)]*\)|header\([^)]*\))/g) ?? [];
      for (const read of headerReads) expect(read).toMatch(/STEP_UP_HEADER/);
    }
    expect(code('lib/stepUp.ts')).toMatch(/export const STEP_UP_HEADER = 'x-bridge-step-up';/);
  });

  it('draws inputs only from the reviewed owners', () => {
    // Adding an import here is how a new signal would arrive: review it against
    // the B2 rules (documented, bounded, not inferred) and update this list.
    const imports = (rel: string) => [...code(rel).matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).sort();
    expect(imports('lib/stepUp.ts')).toEqual([
      '../db/repositories',        // Users.findById: the account's own password / 2FA / tokenVersion
      '../socket/socketRateLimit', // countInWindow: the moderation-burst counter
      './envNumbers',
      './logger',
      './redisAdapter',            // the failed-proof counter (TTL = its window)
      './tokenVersion',
      'crypto',
      'express',
      'jsonwebtoken',
    ].sort());
  });

  it('reads only the account fields the design names', () => {
    const src = code('lib/stepUp.ts');
    const reads = [...src.matchAll(/Users\.([A-Za-z]+)\(/g)].map(m => m[1]);
    expect([...new Set(reads)]).toEqual(['findById']);
    // The fields taken from that row.
    expect(src).toMatch(/as \{ password\?: unknown; twoFactorEnabled\?: unknown; tokenVersion\?: unknown \} \| null/);
  });

  it('stores nothing durable: counters only, each with its window as TTL', () => {
    const src = code('lib/stepUp.ts');
    expect(src).not.toMatch(/\bUsers\.(update|insert|create|upsert|set)/);
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?[a-z_"]/);
    const increments = [...src.matchAll(/cache\.increment\(([^;]*)\);/g)].map(m => m[1]);
    expect(increments.length).toBeGreaterThan(0);
    for (const args of increments) expect(args).toMatch(/failedProof\.windowMs/);
    const windows = [...src.matchAll(/countInWindow\(([^;]*)\)/g)].map(m => m[1]);
    expect(windows.length).toBeGreaterThan(0);
    for (const args of windows) expect(args).toMatch(/windowMs/);
  });
});

describe('P7 B2: retention bounds hold even against configuration', () => {
  const ENV = ['STEP_UP_TTL_MS', 'STEP_UP_MODERATION_BURST_WINDOW_MS', 'STEP_UP_FAILED_PROOF_WINDOW_MS'];
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const load = () => {
    let policy: unknown;
    jest.isolateModules(() => { policy = require('../lib/stepUp').STEP_UP_POLICY; });
    return policy as { ttlMs: number; moderationBurst: { windowMs: number }; failedProof: { windowMs: number } };
  };

  it('defaults are the documented 10 min grant, 60 s burst and 15 min failed-proof windows', () => {
    for (const k of ENV) delete process.env[k];
    const p = load();
    expect([p.ttlMs, p.moderationBurst.windowMs, p.failedProof.windowMs]).toEqual([10 * 60_000, 60_000, 15 * 60_000]);
  });

  it.each([
    ['STEP_UP_TTL_MS', 60 * 60_000],
    ['STEP_UP_MODERATION_BURST_WINDOW_MS', 60 * 60_000],
    ['STEP_UP_FAILED_PROOF_WINDOW_MS', 24 * 60 * 60_000],
  ])('%s cannot be configured past %d ms: the server refuses to start', (name, max) => {
    process.env[name] = String(max);
    expect(() => load()).not.toThrow();
    process.env[name] = String(max + 1);
    expect(() => load()).toThrow(new RegExp(`${name} must be a safe integer between`));
  });
});
