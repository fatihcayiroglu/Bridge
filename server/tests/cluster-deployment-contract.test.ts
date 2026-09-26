'use strict';

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

describe('production cluster deployment contract', () => {
  const compose = read('docker-compose.cluster.yml');
  const proxy = read('haproxy', 'haproxy.cluster.cfg');
  const sfuClient = read('client', 'js', 'webrtc-sfu.ts');
  const sfuServer = read('server', 'socket', 'handlers', 'mediasoup', 'index.ts');
  const socketServer = read('server', 'socket', 'index.ts');

  test('Docker HAProxy targets container DNS, not its own loopback', () => {
    expect(compose).toContain('./haproxy/haproxy.cluster.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro');
    const serverLines = proxy.split(/\r?\n/).filter(line => /^\s*server\s+bridge\d+\s+/.test(line));
    expect(serverLines.length).toBeGreaterThanOrEqual(9); // rr + sticky + 3 targeted
    expect(serverLines.some(line => line.includes('127.0.0.1'))).toBe(false);
    expect(serverLines.some(line => /\bbridge4\b/.test(line))).toBe(false);
    expect(proxy).toContain('server bridge1 bridge1:3001');
    expect(proxy).toContain('server bridge2 bridge2:3001');
    expect(proxy).toContain('server bridge3 bridge3:3001');
  });

  test('mediasoup workers have non-overlapping host UDP defaults', () => {
    expect(compose).toContain('MEDIASOUP_RTC_MIN_PORT_BRIDGE1:-40000');
    expect(compose).toContain('MEDIASOUP_RTC_MAX_PORT_BRIDGE1:-40999');
    expect(compose).toContain('MEDIASOUP_RTC_MIN_PORT_BRIDGE2:-41000');
    expect(compose).toContain('MEDIASOUP_RTC_MAX_PORT_BRIDGE2:-41999');
    expect(compose).toContain('MEDIASOUP_RTC_MIN_PORT_BRIDGE3:-42000');
    expect(compose).toContain('MEDIASOUP_RTC_MAX_PORT_BRIDGE3:-42999');
  });

  test('cluster production secrets cannot silently use development defaults', () => {
    expect(compose).toContain('${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}');
    expect(compose).toContain('${JWT_SECRET:?JWT_SECRET is required}');
    expect(compose).toContain('${REFRESH_SECRET:?REFRESH_SECRET is required}');
    expect(compose).not.toContain('dev_jwt_secret_change_in_prod');
    expect(compose).not.toContain('dev_refresh_secret_change_in_prod');
    expect(compose).not.toContain('bridge_dev_password');
  });

  test('SFU room owner is a real load-balancer routing target', () => {
    for (const node of ['bridge-1', 'bridge-2', 'bridge-3']) {
      expect(proxy).toContain(`urlp(bridgeNode) -m str ${node}`);
    }
    expect(proxy).toContain('use_backend bridge_sfu1 if sfu_node1');
    expect(proxy).toContain('use_backend bridge_sfu2 if sfu_node2');
    expect(proxy).toContain('use_backend bridge_sfu3 if sfu_node3');
    expect(sfuClient).toContain('query: { bridgeNode: ownerNodeId }');
    expect(sfuClient).toContain('forceNew: true');
    expect(socketServer).toContain("event: 'socket.sfu_route_mismatch'");
  });

  test('capability preflight can redirect before transport creation and client waits for join', () => {
    expect(sfuServer).toMatch(/sfu:get-rtp-capabilities[\s\S]*RoomOwnedElsewhereError[\s\S]*sfu:redirect/);
    // `_waitForSfuJoin` owns both listeners and rejects with the redirect
    // signal after cleanup; the caller must still wait before transport setup.
    expect(sfuClient).toMatch(/_waitForSfuJoin[\s\S]*'sfu:joined'[\s\S]*'sfu:redirect'[\s\S]*SfuRedirectSignal/);
    expect(sfuClient).toMatch(/const joined = this\._waitForSfuJoin[\s\S]*emit\('sfu:join'[\s\S]*await joined[\s\S]*_createSendTransport/);
    expect(sfuClient).toContain("d => d.direction === 'send'");
    expect(sfuClient).toContain("d => d.direction === 'recv'");
    expect(sfuClient).toContain("d => d.producerId === producerId");
    // Regression for the old fake redirect: never retry sfu:join on the immutable app socket.
    expect(sfuClient).not.toMatch(/setTimeout\([\s\S]{0,350}this\.socket\.emit\('sfu:join'/);
  });

  test('node-targeted HTTP can reach process-owned operations such as podcast recording', () => {
    expect(proxy).toContain('use_backend bridge_sfu1 if sfu_node1');
    expect(proxy).not.toContain('use_backend bridge_sfu1 if is_socketio sfu_node1');
    const podcast = read('server', 'routes', 'podcast.ts');
    expect(podcast).toContain('RECORDING_STATE_PREFIX');
    expect(podcast).toContain('ownerNodeId');
    expect(podcast).toContain('cache.withKeyLock');
  });

  // ── HAProxy CONFIG MUST ACTUALLY PARSE ────────────────────────────────────
  // Measured with `haproxy -c` (3.4) against BOTH shipped configs: they were
  // rejected outright, so the documented production/cluster front-end could
  // not start at all.
  //   1. `acl is_cloudflare src ...` used backslash line-continuation; HAProxy
  //      reported "unknown keyword '2400:cb00::/32'" for the continued lines
  //      and then "no such ACL: is_cloudflare" for every rule using it.
  //   2. `nbthread auto` -> "passed a missing or unparsable integer value".
  // These checks are static so they run in the default suite; the executable
  // `haproxy -c` gate lives in the deployment verification run.
  test.each([
    ['haproxy.cfg', read('haproxy', 'haproxy.cfg')],
    ['haproxy.cluster.cfg', read('haproxy', 'haproxy.cluster.cfg')],
  ])('%s parses: no line-continuation, integer nbthread, no undeclared ACL', (_name, cfg) => {
    const lines = cfg.split(/\r?\n/);

    // 1. HAProxy rejected continued directives in these files.
    const continued = cfg.split(/\r?\n/).filter(line => line.trimEnd().endsWith('\\'));
    expect(continued).toEqual([]);

    // 2. `nbthread` only accepts an integer.
    for (const line of lines) {
      const m = /^\s*nbthread\s+(\S+)/.exec(line);
      if (m) expect(m[1]).toMatch(/^[0-9]+$/);
    }

    // 3. Every ACL used in an if/unless condition must be declared.
    const declared = new Set<string>();
    for (const line of lines) {
      const m = /^\s*acl\s+([A-Za-z0-9_.:-]+)\s/.exec(line);
      if (m) declared.add(m[1]);
    }
    const used = new Set<string>();
    for (const line of lines) {
      if (/^\s*#/.test(line)) continue;
      const m = /\s(?:if|unless)\s+(.+)$/.exec(line);
      if (!m) continue;
      for (const token of m[1].split(/\s+/)) {
        const name = token.replace(/^!/, '');
        if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name) && !/^(METH_|HTTP|TRUE|FALSE)/.test(name)) used.add(name);
      }
    }
    const undeclared = [...used].filter(name => !declared.has(name));
    expect(undeclared).toEqual([]);
  });

});
