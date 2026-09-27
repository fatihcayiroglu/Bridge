// scripts/medialab/lib/net.mjs
//
// Real kernel networking for the media lab: one network namespace per
// client, connected to the root namespace only through userspace impairment
// links (impair.py over TUN). Clients cannot reach each other directly
// (ip_forward stays 0), so every packet a browser sends goes to the SFU, the
// TURN server or the signaling load balancer — through its impaired link.
//
// Addresses
//   10.77.0.1   Bridge signaling LB + mediasoup (announced IP)   root, lo alias
//   10.77.0.2   coturn listening + relay address                 root, lo alias
//   10.78.<i>.2 client i, link "a" (primary, e.g. Wi-Fi)          netns ml<i>
//   10.79.<i>.2 client i, link "b" (secondary, e.g. cellular)     netns ml<i>

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPAIR = path.resolve(HERE, '..', 'impair.py');

export const SFU_IP = '10.77.0.1';
export const TURN_IP = '10.77.0.2';
const SUBNET = { a: 78, b: 79 };

function sh(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

const ip = (...args) => sh('ip', args);
const ipAllowFail = (...args) => sh('ip', args, { allowFail: true });

export function clientIp(index, link = 'a') { return `10.${SUBNET[link]}.${index}.2`; }

export class Net {
  constructor(workDir) {
    this.workDir = workDir;
    // UNIX socket paths are limited to 108 bytes; keep control sockets short.
    this.ctlDir = fs.mkdtempSync(fs.existsSync('/run') ? '/run/mlab-' : '/tmp/mlab-');
    this.clients = new Map(); // index -> { ns, links: Map<link, {proc, ctl, rootIf, active}> }
  }

  static preflight() {
    const missing = ['ip', 'nft', 'python3'].filter((b) => sh('sh', ['-c', `command -v ${b}`], { allowFail: true }).status !== 0);
    if (missing.length) throw new Error(`media lab needs: ${missing.join(', ')}`);
    if (!fs.existsSync('/dev/net/tun')) throw new Error('media lab needs /dev/net/tun');
    if (process.getuid?.() !== 0) throw new Error('media lab needs root (netns/TUN)');
  }

  up() {
    Net.preflight();
    for (const addr of [SFU_IP, TURN_IP]) {
      const r = sh('ip', ['addr', 'add', `${addr}/32`, 'dev', 'lo'], { allowFail: true });
      if (r.status !== 0 && !/File exists|already assigned/.test(r.stderr)) throw new Error(r.stderr);
    }
    this.resetFirewall();
  }

  // ── firewall (root namespace, input hook) ──────────────────────────────
  resetFirewall() {
    sh('nft', ['delete', 'table', 'inet', 'medialab'], { allowFail: true });
    sh('nft', ['add', 'table', 'inet', 'medialab']);
    sh('nft', ['add', 'chain', 'inet', 'medialab', 'input', '{ type filter hook input priority -10 ; policy accept ; }']);
    this.firewall = { directSfuBlocked: false, turnBlocked: false, turnUdpBlocked: false };
  }

  #applyFirewall() {
    sh('nft', ['flush', 'chain', 'inet', 'medialab', 'input']);
    const rules = [];
    if (this.firewall.directSfuBlocked) {
      // A client network that cannot reach the SFU's media ports directly
      // (enterprise firewall / UDP+TCP egress filtering). Only TURN remains.
      rules.push(`iifname "mlr*" ip daddr ${SFU_IP} udp dport 40000-49999 drop`);
      rules.push(`iifname "mlr*" ip daddr ${SFU_IP} tcp dport 40000-49999 drop`);
    }
    if (this.firewall.turnBlocked) {
      rules.push(`iifname "mlr*" ip daddr ${TURN_IP} drop`);
    }
    if (this.firewall.turnUdpBlocked) {
      // UDP-hostile network (only TCP egress): TURN must fall back to TCP.
      rules.push(`iifname "mlr*" ip daddr ${TURN_IP} udp dport 3478 drop`);
    }
    for (const rule of rules) sh('nft', ['add', 'rule', 'inet', 'medialab', 'input', ...rule.split(' ')]);
  }

  blockDirectSfu(on) { this.firewall.directSfuBlocked = on; this.#applyFirewall(); }
  blockTurn(on) { this.firewall.turnBlocked = on; this.#applyFirewall(); }
  blockTurnUdp(on) { this.firewall.turnUdpBlocked = on; this.#applyFirewall(); }

  // ── clients ────────────────────────────────────────────────────────────
  async addClient(index) {
    const ns = `ml${index}`;
    ipAllowFail('netns', 'del', ns);
    ip('netns', 'add', ns);
    ip('-n', ns, 'link', 'set', 'lo', 'up');
    const entry = { index, ns, links: new Map() };
    this.clients.set(index, entry);
    await this.addLink(index, 'a');
    this.activate(index, 'a');
    return entry;
  }

  async addLink(index, link) {
    const entry = this.clients.get(index);
    const rootIf = `mlr${index}${link}`;
    const clientIf = `ml${link}`;
    const ctl = path.join(this.ctlDir, `${index}${link}.sock`);
    const log = fs.openSync(path.join(this.workDir, 'logs', `impair-${index}${link}.log`), 'a');
    const proc = spawn('python3', [IMPAIR, '--netns', entry.ns, '--client-if', clientIf, '--root-if', rootIf, '--control', ctl, '--seed', String(1000 + index)], {
      stdio: ['ignore', 'pipe', log],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`impair link ${rootIf} did not start`)), 10_000);
      proc.stdout.once('data', () => { clearTimeout(t); resolve(); });
      proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`impair link ${rootIf} exited ${code}`)); });
    });
    const sub = SUBNET[link];
    ip('addr', 'add', `10.${sub}.${index}.1/24`, 'dev', rootIf);
    ip('link', 'set', rootIf, 'up');
    ip('-n', entry.ns, 'addr', 'add', `10.${sub}.${index}.2/24`, 'dev', clientIf);
    ip('-n', entry.ns, 'link', 'set', clientIf, 'up');
    entry.links.set(link, { proc, ctl, rootIf, clientIf, active: false });
    return entry.links.get(link);
  }

  /** Make `link` the client's default route (the only usable path). */
  activate(index, link) {
    const entry = this.clients.get(index);
    const l = entry.links.get(link);
    ipAllowFail('-n', entry.ns, 'route', 'del', 'default');
    ip('-n', entry.ns, 'link', 'set', l.clientIf, 'up');
    ip('-n', entry.ns, 'route', 'add', 'default', 'dev', l.clientIf, 'src', clientIp(index, link));
    for (const [name, other] of entry.links) other.active = name === link;
  }

  /**
   * Wi-Fi -> cellular style handoff: bring the other link up as the default
   * route and take the old interface down (its address disappears), exactly
   * what an OS does when one radio goes away.
   */
  async handoff(index, to) {
    const entry = this.clients.get(index);
    if (!entry.links.has(to)) await this.addLink(index, to);
    const from = [...entry.links.entries()].find(([, l]) => l.active)?.[0];
    this.activate(index, to);
    if (from && from !== to) ip('-n', entry.ns, 'link', 'set', entry.links.get(from).clientIf, 'down');
    return { from, to };
  }

  async control(index, link, msg) {
    const l = this.clients.get(index)?.links.get(link);
    if (!l) throw new Error(`no link ${index}${link}`);
    return new Promise((resolve, reject) => {
      const s = net.createConnection(l.ctl);
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) { s.end(); resolve(JSON.parse(buf.split('\n')[0])); }
      });
      s.on('error', reject);
      s.write(`${JSON.stringify(msg)}\n`);
    });
  }

  /** Apply an impairment profile to every link of a client (both directions). */
  async impair(index, { up = {}, down = {} } = {}) {
    const entry = this.clients.get(index);
    for (const link of entry.links.keys()) await this.control(index, link, { op: 'set', up, down });
  }

  async linkStats(index) {
    const out = {};
    for (const link of this.clients.get(index).links.keys()) out[link] = await this.control(index, link, { op: 'stats' });
    return out;
  }

  down() {
    for (const entry of this.clients.values()) {
      for (const l of entry.links.values()) { try { l.proc.kill('SIGTERM'); } catch { /* gone */ } }
      ipAllowFail('netns', 'del', entry.ns);
    }
    this.clients.clear();
    sh('nft', ['delete', 'table', 'inet', 'medialab'], { allowFail: true });
  }
}
