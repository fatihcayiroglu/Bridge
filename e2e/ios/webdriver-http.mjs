// Native session creation can take longer than fetch's independent headers
// timeout. Use one explicit deadline for the whole request, with no automatic
// retry or hidden socket/header deadline. Never expose command arguments or
// driver response messages in retained errors.
import http from 'node:http';
import https from 'node:https';

const W3C_ERRORS = new Set([
  'unknown error', 'invalid argument', 'invalid session id', 'session not created',
  'timeout', 'script timeout', 'no such context', 'no such window',
  'no such element', 'javascript error', 'unsupported operation', 'unknown command',
]);

export function webdriverRequest(base, method, route, body, timeout = 90_000) {
  const url = new URL(base.replace(/\/$/, '') + route);
  const transport = url.protocol === 'http:' ? http : url.protocol === 'https:' ? https : null;
  if (!transport) return Promise.reject(new Error('Unsupported WebDriver transport'));
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return Promise.reject(new Error('Invalid WebDriver deadline'));
  const endpoint = route.split('/').at(-1);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method, agent: false, signal: AbortSignal.timeout(timeout),
      headers: {
        'Content-Type': 'application/json',
        ...(payload === null ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
      },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1_048_576) {
          response.destroy();
          request.destroy();
          reject(new Error(`WebDriver ${endpoint} response exceeds limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => reject(new Error(`WebDriver ${endpoint} response interrupted`)));
      response.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error(`WebDriver ${endpoint} returned invalid JSON`)); return; }
        if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'value')) {
          reject(new Error(`WebDriver ${endpoint} returned an invalid W3C response`)); return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || data.value?.error) {
          const reason = W3C_ERRORS.has(data.value?.error) ? data.value.error : 'HTTP error';
          reject(new Error(`WebDriver ${endpoint} failed (${response.statusCode}; ${reason})`));
          return;
        }
        resolve(data.value);
      });
    });
    request.on('error', error => {
      const code = typeof error.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : 'TRANSPORT_ERROR';
      reject(new Error(`WebDriver ${endpoint} transport failed (${code})`));
    });
    request.end(payload);
  });
}
