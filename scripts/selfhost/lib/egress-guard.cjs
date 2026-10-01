// scripts/selfhost/lib/egress-guard.cjs
//
// Preloaded into a Bridge process (`NODE_OPTIONS=--require …`) by the
// self-host and federation labs. It OBSERVES — never blocks — every outbound
// TCP/TLS connection the process opens and appends the ones that leave the
// machine to $BRIDGE_EGRESS_LOG (one JSON object per line).
//
// It answers one question with evidence instead of code reading: does a
// self-hosted Bridge need a third-party or Bridge-operated service to boot and
// serve its core features? An empty log after boot + a full functional smoke
// means it did not even try to reach one.
//
// Local destinations are not recorded: loopback addresses, `localhost`, Unix
// sockets, and any host named in $BRIDGE_EGRESS_LOCAL_HOSTS (the lab's own
// instance hostnames). Everything else is.
'use strict';

const fs = require('fs');
const net = require('net');

const LOG = process.env.BRIDGE_EGRESS_LOG;
if (LOG) {
  const extra = new Set((process.env.BRIDGE_EGRESS_LOCAL_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const isLocal = (host) => {
    if (!host) return true; // net default: localhost
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1'
      || /^127\./.test(h) || extra.has(h);
  };
  const record = (entry) => {
    try {
      fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), pid: process.pid, ...entry }) + '\n');
    } catch { /* observation must never break the process */ }
  };

  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    try {
      // Public forms: (options[, cb]), (port[, host][, cb]), (path[, cb]);
      // internal form: ([options, cb]) — a normalized array.
      let opts = args[0];
      if (Array.isArray(opts)) opts = opts[0];
      let host;
      let port;
      let unixPath;
      if (opts && typeof opts === 'object') {
        host = opts.host ?? opts.hostname;
        port = opts.port;
        unixPath = opts.path;
      } else if (typeof opts === 'number' || (typeof opts === 'string' && /^\d+$/.test(opts))) {
        port = Number(opts);
        host = typeof args[1] === 'string' ? args[1] : undefined;
      } else if (typeof opts === 'string') {
        unixPath = opts;
      }
      if (!unixPath && !isLocal(host)) {
        record({ host: String(host), port: port === undefined ? null : Number(port), stack: new Error().stack.split('\n').slice(2, 7).map((l) => l.trim()) });
      }
    } catch { /* never interfere */ }
    return original.apply(this, args);
  };
}
