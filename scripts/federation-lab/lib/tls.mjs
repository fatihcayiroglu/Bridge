// scripts/federation-lab/lib/tls.mjs
//
// The lab's public face for each installation: a TLS-terminating front on
// https://<name>.bridge.test:<port>, signed by a lab CA the installations
// trust (NODE_EXTRA_CA_CERTS). ActivityPub key fetches are HTTPS-only in
// Bridge, so federation cannot be tested honestly over plain HTTP.
//
// The front forwards the original Host header untouched (HTTP Signatures sign
// it) and can simulate the network failing between the two installations:
//   open      normal proxying
//   refuse    every new connection is reset (remote down / connection refused)
//   blackhole connections are accepted and never answered (partition / hang)

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

function openssl(args, cwd) {
  const r = spawnSync('openssl', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args.join(' ')}: ${r.stderr}`);
}

/** A CA and one leaf certificate valid for every lab hostname. */
export function makeLabPki(dir, hostnames) {
  fs.mkdirSync(dir, { recursive: true });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Bridge federation lab CA'], dir);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${hostnames[0]}`], dir);
  fs.writeFileSync(path.join(dir, 'leaf.ext'), `subjectAltName=${hostnames.map((h) => `DNS:${h}`).join(',')}\nextendedKeyUsage=serverAuth\n`);
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', 'leaf.ext'], dir);
  return {
    caFile: path.join(dir, 'ca.crt'),
    key: fs.readFileSync(path.join(dir, 'leaf.key')),
    cert: fs.readFileSync(path.join(dir, 'leaf.crt')),
    ca: fs.readFileSync(path.join(dir, 'ca.crt')),
  };
}

export class TlsFront {
  constructor({ hostname, port, upstreamPort, pki, handler }) {
    Object.assign(this, { hostname, port, upstreamPort, pki });
    this.mode = 'open';
    this.handler = handler; // optional (req, res) => boolean — lab endpoints (evil server)
    this.sockets = new Set();
    this.seen = []; // { method, path, status } of every proxied request
  }

  get origin() { return `https://${this.hostname}:${this.port}`; }

  async start() {
    this.server = https.createServer({ key: this.pki.key, cert: this.pki.cert }, (req, res) => this.#handle(req, res));
    this.server.on('connection', (sock) => {
      if (this.mode === 'refuse') { sock.destroy(); return; }
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
    });
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
  }

  #handle(req, res) {
    if (this.mode === 'blackhole') return; // never answer
    if (this.handler && this.handler(req, res)) return;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const up = http.request({
        host: '127.0.0.1', port: this.upstreamPort, method: req.method, path: req.url,
        headers: { ...req.headers, 'content-length': String(body.length) },
      }, (upRes) => {
        this.seen.push({ method: req.method, path: req.url, status: upRes.statusCode, at: Date.now() });
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
      up.end(body);
    });
  }

  /** open | refuse | blackhole. Switching drops connections in flight. */
  setMode(mode) {
    this.mode = mode;
    if (mode !== 'open') for (const s of this.sockets) s.destroy();
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}
