// scripts/multinode/lib/faultProxy.mjs
//
// TCP proxy between the Bridge nodes and PostgreSQL that can inject faults:
//
//   · cutAll()            — sever every established connection (network loss)
//   · refuse(true|false)  — refuse new connections (database unreachable)
//   · armCommitAmbiguity(n) — for the next n COMMITs: forward the COMMIT to the
//                          server, then drop the connection BEFORE the reply
//                          reaches the client. The transaction is durable but
//                          the application sees an error: the classic
//                          "did it commit?" ambiguity.
//
// The client->server direction is parsed at the PostgreSQL wire-protocol
// framing level (1-byte type + int32 length); nothing is rewritten.

import net from 'node:net';

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;

export class PgFaultProxy {
  constructor({ listenPort, targetPort, targetHost = '127.0.0.1' }) {
    this.listenPort = listenPort;
    this.targetPort = targetPort;
    this.targetHost = targetHost;
    this.conns = new Set();
    this.refusing = false;
    this.commitAmbiguity = 0;
    this.stats = { accepted: 0, refused: 0, cut: 0, ambiguousCommits: 0, commitsSeen: 0 };
  }

  start() {
    this.server = net.createServer((client) => this.#accept(client));
    return new Promise((resolve) => this.server.listen(this.listenPort, '127.0.0.1', resolve));
  }

  stop() {
    this.cutAll();
    return new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  refuse(on) { this.refusing = on; if (on) this.cutAll(); }

  cutAll() {
    for (const c of this.conns) { c.client.destroy(); c.upstream.destroy(); this.stats.cut += 1; }
    this.conns.clear();
  }

  armCommitAmbiguity(n = 1) { this.commitAmbiguity = n; }

  /**
   * Targeted fault on the next statement whose SQL text matches `match`
   * (simple 'Q' or extended-protocol 'P' messages):
   *   mode 'reply-lost'  — forward it (and, with `onCommit`, the enclosing
   *                        transaction's COMMIT), then drop every reply and
   *                        sever the client: the effect is durable, the
   *                        caller sees an error.
   *   mode 'fail'        — sever BEFORE forwarding: the statement never runs.
   * `onTrigger` runs synchronously when the fault fires (compound chaos).
   */
  armTargeted({ match, mode = 'reply-lost', onCommit = false, onTrigger } = {}) {
    this.targeted = { match, mode, onCommit, onTrigger, fired: 0 };
    return this.targeted;
  }

  #accept(client) {
    if (this.refusing) { this.stats.refused += 1; client.destroy(); return; }
    this.stats.accepted += 1;
    const upstream = net.connect({ port: this.targetPort, host: this.targetHost });
    const conn = { client, upstream, buf: Buffer.alloc(0), startupDone: false, swallowReplies: false };
    this.conns.add(conn);
    const close = () => { client.destroy(); upstream.destroy(); this.conns.delete(conn); };
    client.on('error', close); upstream.on('error', close);
    client.on('close', close); upstream.on('close', close);

    upstream.on('data', (chunk) => {
      if (conn.swallowReplies) return; // the COMMIT reply never reaches Bridge
      client.write(chunk);
    });
    client.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      this.#drain(conn);
    });
  }

  #drain(conn) {
    for (;;) {
      if (!conn.startupDone) {
        if (conn.buf.length < 8) return;
        const len = conn.buf.readInt32BE(0);
        if (conn.buf.length < len) return;
        const code = conn.buf.readInt32BE(4);
        const msg = conn.buf.subarray(0, len);
        conn.buf = conn.buf.subarray(len);
        conn.upstream.write(msg);
        if (code !== SSL_REQUEST && code !== GSS_REQUEST) conn.startupDone = true;
        continue;
      }
      if (conn.buf.length < 5) return;
      const type = String.fromCharCode(conn.buf[0]);
      const len = conn.buf.readInt32BE(1);
      if (conn.buf.length < len + 1) return;
      const msg = conn.buf.subarray(0, len + 1);
      conn.buf = conn.buf.subarray(len + 1);
      const text = (type === 'Q' || type === 'P') ? msg.subarray(5, len + 1).toString('utf8') : '';
      const isCommit = type === 'Q' && /^\s*COMMIT\b/i.test(text);
      if (isCommit) this.stats.commitsSeen += 1;
      const t = this.targeted;
      if (t && !t.fired && text) {
        if (type === 'Q' && /^\s*(BEGIN|START TRANSACTION)\b/i.test(text)) conn.txnMatched = false;
        const hit = t.match.test(text);
        if (hit && t.onCommit) conn.txnMatched = true;
        const fireNow = t.onCommit ? (isCommit && conn.txnMatched) : hit;
        if (fireNow) {
          t.fired = Date.now();
          this.stats.targetedFaults = (this.stats.targetedFaults || 0) + 1;
          try { t.onTrigger?.(); } catch { /* chaos hook */ }
          if (t.mode === 'fail') {
            conn.client.destroy();
            conn.upstream.destroy();
            return;
          }
          // reply-lost: forward this message and whatever the client already
          // pipelined (Bind/Execute/Sync), then swallow all replies.
          conn.upstream.write(msg);
          if (conn.buf.length) { conn.upstream.write(conn.buf); conn.buf = Buffer.alloc(0); }
          conn.swallowReplies = true;
          setTimeout(() => { conn.client.destroy(); }, 250);
          return;
        }
      }
      conn.upstream.write(msg);
      if (isCommit && this.commitAmbiguity > 0) {
        this.commitAmbiguity -= 1;
        this.stats.ambiguousCommits += 1;
        conn.swallowReplies = true;
        // Give the server time to durably commit, then sever the client side.
        setTimeout(() => { conn.client.destroy(); }, 150);
        return;
      }
    }
  }
}

/**
 * HTTP proxy between the Bridge nodes and object storage (S3 API). Faults are
 * per HTTP method so a scenario can break exactly one storage operation:
 *   failMethods(['PUT'])     — uploads fail (503 SlowDown), reads/deletes work
 *   failMethods(['DELETE'])  — rollbacks/cleanup fail, uploads work
 *   failMethods([])          — pass-through
 * The harness itself talks to storage directly, never through this proxy.
 */
export class HttpFaultProxy {
  constructor({ listenPort, targetPort, targetHost = '127.0.0.1' }) {
    this.listenPort = listenPort;
    this.targetPort = targetPort;
    this.targetHost = targetHost;
    this.failing = new Set();
    this.stats = { forwarded: 0, failed: 0, byMethod: {} };
  }

  failMethods(methods = []) { this.failing = new Set(methods.map((m) => m.toUpperCase())); }

  async start() {
    const http = await import('node:http');
    this.server = http.createServer((req, res) => {
      this.stats.byMethod[req.method] = (this.stats.byMethod[req.method] || 0) + 1;
      if (this.failing.has(req.method)) {
        this.stats.failed += 1;
        req.resume();
        res.writeHead(503, { 'Content-Type': 'application/xml' })
          .end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>injected by multinode harness</Message></Error>');
        return;
      }
      this.stats.forwarded += 1;
      const up = http.request({ host: this.targetHost, port: this.targetPort, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); });
      req.pipe(up);
    });
    return new Promise((resolve) => this.server.listen(this.listenPort, '127.0.0.1', resolve));
  }

  stop() { return new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve()); }
}
