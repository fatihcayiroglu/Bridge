// scripts/multinode/lib/proxy.mjs
//
// HTTP + WebSocket load balancer in front of the Bridge nodes.
//
// Routing modes (per proxy, switchable at runtime):
//   · 'round-robin'  — every HTTP request / WS upgrade goes to the next live node
//   · 'cookie'       — affinity: first response sets `MNNODE=<name>`; requests
//                      that carry the cookie stick to that node (like HAProxy
//                      `cookie SERVERID insert` / ingress-nginx affinity)
//   · 'pin'          — every request to one named node
// Per request, `x-mn-node: <name>` forces a node (deterministic scenarios).
// `?bridgeNode=mn-<name>` forces a node exactly like the production HAProxy
// SFU ACLs (haproxy/haproxy.cluster.cfg): a closed set of INSTANCE_IDs, no
// failover — a dead owner is a failed connection, as in production.
// `remove(name)` / `restore(name)` model a node leaving the pool.
//
// If the chosen node refuses the connection the proxy retries the next live
// node (like a real LB with passive health checks) and counts the failover.

import http from 'node:http';
import net from 'node:net';

export class RoutingProxy {
  constructor({ port, nodes, mode = 'round-robin', host = '127.0.0.1' }) {
    this.port = port;
    this.host = host;
    this.nodes = nodes; // [{ name, host, port }]
    this.mode = mode;
    this.pinned = nodes[0]?.name;
    this.removed = new Set();
    this.rr = 0;
    this.stats = { requests: 0, upgrades: 0, failovers: 0, errors: 0, byNode: {} };
  }

  setMode(mode, pinned) { this.mode = mode; if (pinned) this.pinned = pinned; }
  remove(name) { this.removed.add(name); }
  restore(name) { this.removed.delete(name); }

  live() { return this.nodes.filter((n) => !this.removed.has(n.name)); }

  #cookieNode(req) {
    const m = /(?:^|;\s*)MNNODE=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || ''));
    return m ? m[1] : null;
  }

  #forced(req) {
    if (req.headers['x-mn-node']) return String(req.headers['x-mn-node']);
    const q = /[?&]bridgeNode=([^&]*)/.exec(String(req.url || ''));
    if (!q) return null;
    const hit = this.nodes.find((n) => `mn-${n.name}` === decodeURIComponent(q[1]));
    return hit ? hit.name : '__unrouteable__';
  }

  pick(req, exclude = new Set()) {
    const live = this.live().filter((n) => !exclude.has(n.name));
    if (!live.length) return null;
    const forced = this.#forced(req);
    if (forced) return live.find((n) => n.name === forced) || null;
    // Sticky preference that falls back to the pool when the node is gone,
    // like a real LB whose affinity target failed its health check.
    const prefer = req.headers['x-mn-prefer'];
    if (prefer) {
      const hit = live.find((n) => n.name === prefer);
      if (hit) return hit;
    }
    if (this.mode === 'pin') return live.find((n) => n.name === this.pinned) || null;
    if (this.mode === 'cookie') {
      const c = this.#cookieNode(req);
      const hit = c && live.find((n) => n.name === c);
      if (hit) return hit;
    }
    const n = live[this.rr % live.length];
    this.rr += 1;
    return n;
  }

  start() {
    this.server = http.createServer((req, res) => this.#http(req, res));
    this.server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    return new Promise((resolve) => this.server.listen(this.port, this.host, resolve));
  }

  stop() { return new Promise((resolve) => this.server.close(() => resolve())); }

  #count(name) { this.stats.byNode[name] = (this.stats.byNode[name] || 0) + 1; }

  #http(req, res, tried = new Set(), body = null) {
    const collect = body ? Promise.resolve(body) : new Promise((resolve) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => resolve(Buffer.concat(parts)));
    });
    collect.then((buf) => {
      const node = this.pick(req, tried);
      if (!node) { this.stats.errors += 1; res.writeHead(503).end('no live backend'); return; }
      if (!tried.size) this.stats.requests += 1;
      // Append, like a real LB: the node trusts only the hop this proxy adds.
      const xff = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
      const headers = { ...req.headers, 'x-forwarded-for': xff, 'content-length': String(buf.length) };
      delete headers['transfer-encoding'];
      const up = http.request({ host: node.host, port: node.port, method: req.method, path: req.url, headers }, (ur) => {
        this.#count(node.name);
        const h = { ...ur.headers, 'x-mn-served-by': node.name };
        if (this.mode === 'cookie' && this.#cookieNode(req) !== node.name) {
          const prior = [].concat(h['set-cookie'] || []);
          h['set-cookie'] = [...prior, `MNNODE=${node.name}; Path=/; HttpOnly`];
        }
        res.writeHead(ur.statusCode, h);
        ur.pipe(res);
      });
      up.on('error', (err) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
          tried.add(node.name);
          this.stats.failovers += 1;
          if (!this.#forced(req) && this.live().some((n) => !tried.has(n.name))) {
            this.#http(req, res, tried, buf);
            return;
          }
        }
        this.stats.errors += 1;
        if (!res.headersSent) res.writeHead(502).end(`backend ${node.name} error: ${err.code}`);
      });
      up.end(buf);
    });
  }

  #upgrade(req, socket, head, tried = new Set()) {
    const node = this.pick(req, tried);
    if (!node) { socket.destroy(); return; }
    if (!tried.size) this.stats.upgrades += 1;
    const upstream = net.connect({ host: node.host, port: node.port }, () => {
      this.#count(node.name);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' && !this.#forced(req) && this.live().some((n) => !tried.has(n.name) && n.name !== node.name)) {
        tried.add(node.name);
        this.stats.failovers += 1;
        this.#upgrade(req, socket, head, tried);
        return;
      }
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
  }
}
