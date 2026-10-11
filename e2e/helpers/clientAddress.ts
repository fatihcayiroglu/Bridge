// e2e/helpers/clientAddress.ts — API requests that leave from their OWN client address.
//
// Some protections are budgets per client IP. `twoFactor` (middleware/rateLimit.ts)
// allows 5 requests per 5 minutes per IP across every /api/2fa route and
// /api/step-up/password, and the E2E server keeps that production value. The whole
// suite talks to the server from 127.0.0.1, so one IP budget is shared by the global
// setup's 2FA fixture and every 2FA test. Measured on a fresh server (chromium, one
// worker): the setup spends 2, the first test 2, the second test 1, and from there
// every /api/2fa call answers 429 — the invalid-OTP, disable-without-password and
// brute-force tests then "passed" on that 429 without the server ever evaluating
// their request.
//
// Isolation, not a bigger budget: Linux and Windows route all of 127.0.0.0/8 to the
// loopback interface, so a socket bound to 127.x.y.z reaches the server on 127.0.0.1
// and the server sees 127.x.y.z as the socket peer. That is a genuinely different
// client, not a spoofed header — TRUSTED_PROXY_COUNT stays 0 and X-Forwarded-For is
// still ignored. Each address gets the production budget and nothing more.
//
// macOS only routes 127.0.0.1 by default; there the request fails with an explicit
// error instead of silently falling back to the shared address.

import http from 'node:http';
import { randomInt } from 'node:crypto';

const BASE = () => process.env.BASE_URL || 'http://127.0.0.1:3000';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

type Headers = Record<string, string>;
type RequestOptions = { headers?: Headers; data?: unknown; method?: string; multipart?: unknown; form?: unknown };

/** The subset of Playwright's APIResponse the specs read. */
export interface AddressedResponse {
  status(): number;
  ok(): boolean;
  headers(): Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  url(): string;
}

/** The subset of Playwright's APIRequestContext the specs and helpers call. */
export interface AddressedRequest {
  get(url: string, options?: RequestOptions): Promise<AddressedResponse>;
  head(url: string, options?: RequestOptions): Promise<AddressedResponse>;
  post(url: string, options?: RequestOptions): Promise<AddressedResponse>;
  put(url: string, options?: RequestOptions): Promise<AddressedResponse>;
  patch(url: string, options?: RequestOptions): Promise<AddressedResponse>;
  delete(url: string, options?: RequestOptions): Promise<AddressedResponse>;
  fetch(url: string, options?: RequestOptions): Promise<AddressedResponse>;
}

/** A fresh loopback address other than 127.0.0.1 (random, so a reused server's budgets never carry over). */
function freshLoopbackAddress(): string {
  return `127.${randomInt(16, 251)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function body(options: RequestOptions, headers: Headers): Buffer | undefined {
  if (options.multipart !== undefined || options.form !== undefined) {
    throw new Error('clientAddress: multipart/form bodies are not supported; send JSON or a string');
  }
  const { data } = options;
  if (data === undefined) return undefined;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data);
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return Buffer.from(JSON.stringify(data));
}

function send(localAddress: string, method: string, url: string, options: RequestOptions): Promise<AddressedResponse> {
  const target = new URL(url, BASE());
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error(`clientAddress: a separate client address needs a loopback http server, got ${target.origin}`);
  }
  const headers: Headers = { Host: target.host, Accept: 'application/json', ...(options.headers ?? {}) };
  const payload = body(options, headers);
  if (payload) headers['Content-Length'] = String(payload.length);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: target.port || 80, path: `${target.pathname}${target.search}`,
      method, headers, localAddress, family: 4, agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const flat: Headers = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flat[k] = Array.isArray(v) ? v.join(', ') : String(v);
        const status = res.statusCode ?? 0;
        resolve({
          status: () => status,
          ok: () => status >= 200 && status < 300,
          headers: () => flat,
          text: async () => raw,
          json: async () => JSON.parse(raw) as unknown,
          url: () => target.href,
        });
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRNOTAVAIL') {
        reject(new Error(`clientAddress: this host cannot send from ${localAddress} (only 127.0.0.1 is routed, e.g. macOS). `
          + 'Run the spec on Linux/Windows or CI; it does not fall back to the shared 127.0.0.1 budget.'));
      } else reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A request client whose every connection originates from one fresh loopback
 * address — its own per-IP rate-limit budgets, at the production size.
 */
export function requestFromOwnAddress(): { address: string; request: AddressedRequest } {
  const address = freshLoopbackAddress();
  const verb = (method: string) => (url: string, options: RequestOptions = {}) => send(address, method, url, options);
  return {
    address,
    request: {
      get: verb('GET'), head: verb('HEAD'), post: verb('POST'), put: verb('PUT'), patch: verb('PATCH'), delete: verb('DELETE'),
      fetch: (url, options = {}) => send(address, String(options.method ?? 'GET').toUpperCase(), url, options),
    },
  };
}
