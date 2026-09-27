'use strict';

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

describe('deployment storage and proxy safety contracts', () => {
  const compose = read('docker-compose.yml');
  const cluster = read('docker-compose.cluster.yml');
  const haproxy = read('haproxy', 'haproxy.cluster.cfg');

  test('single-node production compose supplies every fail-closed startup secret', () => {
    for (const secret of [
      'JWT_SECRET',
      'REFRESH_SECRET',
      'FEDERATION_SECRET',
      'AP_ENCRYPTION_KEY',
      'METRICS_SECRET',
    ]) expect(compose).toContain(`\${${secret}:?`);
    expect(compose).toContain('TRUSTED_PROXY_COUNT: "${TRUSTED_PROXY_COUNT:-0}"');
  });

  test('upload volume and runtime path agree in single-node and clustered deployments', () => {
    expect(compose).toContain('BRIDGE_UPLOAD_ROOT: /app/server/uploads');
    expect(compose).toContain('uploads_data:/app/server/uploads');
    expect(cluster).toContain('BRIDGE_UPLOAD_ROOT: /app/server/uploads');
    expect((cluster.match(/uploads_data:\/app\/server\/uploads/g) || [])).toHaveLength(3);
    expect(cluster).not.toContain('uploads_data:/app/uploads');
  });

  test('orchestrators gate traffic on readiness, not liveness', () => {
    expect((cluster.match(/http:\/\/localhost:3001\/api\/health\/ready/g) || [])).toHaveLength(3);
    expect(haproxy).not.toContain('option httpchk GET /api/health\n');
    expect((haproxy.match(/option\s+httpchk GET \/api\/health\/ready/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  test('management/object-storage ports are host-local by default', () => {
    expect(compose).toContain('127.0.0.1:9000:9000');
    expect(compose).toContain('127.0.0.1:9001:9001');
    expect(cluster).toContain('127.0.0.1:8404:8404');
  });

  test('HAProxy discards caller-controlled forwarding headers before every backend route', () => {
    const stripFor = haproxy.indexOf('http-request del-header X-Forwarded-For');
    const stripProto = haproxy.indexOf('http-request del-header X-Forwarded-Proto');
    const firstRoute = haproxy.indexOf('use_backend bridge_sfu1');
    expect(stripFor).toBeGreaterThan(0);
    expect(stripProto).toBeGreaterThan(stripFor);
    expect(stripProto).toBeLessThan(firstRoute);
    expect(haproxy).toContain('http-request set-header X-Forwarded-For %[src] unless is_cloudflare');
    expect(haproxy).not.toMatch(/^\s*option\s+forwardfor\s*$/m);
  });
});
