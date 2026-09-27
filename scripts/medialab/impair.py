#!/usr/bin/env python3
"""Userspace network impairment link for the Bridge media lab.

The lab host's kernel has no `netem` qdisc, so latency/jitter/loss cannot be
added with `tc`. This process is the link instead: it owns one TUN device
inside a client network namespace and one TUN device in the root namespace
and forwards every IP packet between them, applying a per-direction profile:

    loss          Bernoulli loss (percent), or Gilbert-Elliott burst loss
    delay/jitter  one-way propagation delay (ms) +/- uniform jitter (ms);
                  order is preserved (a later packet never departs first)
    rate          bottleneck bandwidth (kbit/s) with a tail-drop queue
                  bounded in milliseconds of queueing (bufferbloat bound)
    blackhole     drop everything (interruption / cable pull)

Nothing here is synthetic media: browsers, TURN and mediasoup exchange real
IP packets through the real kernel stack. Only the impairment is synthetic.

Control: a UNIX stream socket accepting one JSON object per line:
    {"op": "set", "up": {...}, "down": {...}}   replace the direction profiles
    {"op": "stats"}                              counters since start
The reply is one JSON line. `up` is client -> root, `down` is root -> client.
"""

import argparse
import ctypes
import fcntl
import heapq
import json
import os
import random
import select
import signal
import socket
import struct
import sys
import time

TUNSETIFF = 0x400454CA
IFF_TUN = 0x0001
IFF_NO_PI = 0x1000
CLONE_NEWNET = 0x40000000

libc = ctypes.CDLL(None, use_errno=True)


def setns(fd):
    if libc.setns(fd, CLONE_NEWNET) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def open_tun(name):
    fd = os.open('/dev/net/tun', os.O_RDWR | os.O_NONBLOCK)
    ifr = struct.pack('16sH', name.encode(), IFF_TUN | IFF_NO_PI)
    fcntl.ioctl(fd, TUNSETIFF, ifr)
    return fd


class Direction:
    def __init__(self, label):
        self.label = label
        self.profile = {}
        self.link_free_at = 0.0
        self.last_departure = 0.0
        self.ge_bad = False
        self.counters = dict(rx_pkts=0, rx_bytes=0, tx_pkts=0, tx_bytes=0,
                             drop_loss=0, drop_queue=0, drop_blackhole=0)

    def configure(self, profile):
        self.profile = dict(profile or {})
        self.ge_bad = False

    def _lost(self):
        p = self.profile
        ge = p.get('gilbert')
        if ge:
            # Two-state Markov chain: good <-> bad, loss only in bad.
            if self.ge_bad:
                if random.random() < ge.get('p_bad_to_good', 0.3):
                    self.ge_bad = False
            elif random.random() < ge.get('p_good_to_bad', 0.01):
                self.ge_bad = True
            return self.ge_bad and random.random() < ge.get('loss_in_bad', 1.0)
        loss = p.get('loss', 0.0)
        return loss > 0 and random.random() * 100.0 < loss

    def schedule(self, now, size):
        """Departure time for a packet arriving now, or None if dropped."""
        p = self.profile
        c = self.counters
        c['rx_pkts'] += 1
        c['rx_bytes'] += size
        if p.get('blackhole'):
            c['drop_blackhole'] += 1
            return None
        if self._lost():
            c['drop_loss'] += 1
            return None
        t = now
        rate = p.get('rate_kbps')
        if rate:
            start = max(now, self.link_free_at)
            queue_ms = (start - now) * 1000.0
            if queue_ms > p.get('queue_ms', 200.0):
                c['drop_queue'] += 1
                return None
            self.link_free_at = start + (size * 8.0) / (rate * 1000.0)
            t = self.link_free_at
        delay = p.get('delay_ms', 0.0)
        jitter = p.get('jitter_ms', 0.0)
        if delay or jitter:
            t += max(0.0, delay + random.uniform(-jitter, jitter)) / 1000.0
        # FIFO: jitter varies spacing but never reorders packets.
        t = max(t, self.last_departure)
        self.last_departure = t
        return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--netns', required=True, help='client namespace name (/var/run/netns/<name>)')
    ap.add_argument('--client-if', required=True)
    ap.add_argument('--root-if', required=True)
    ap.add_argument('--control', required=True, help='UNIX control socket path')
    ap.add_argument('--seed', type=int, default=None)
    args = ap.parse_args()
    if args.seed is not None:
        random.seed(args.seed)

    root_ns = os.open('/proc/self/ns/net', os.O_RDONLY)
    client_ns = os.open(f'/var/run/netns/{args.netns}', os.O_RDONLY)
    setns(client_ns)
    client_fd = open_tun(args.client_if)
    setns(root_ns)
    root_fd = open_tun(args.root_if)

    up = Direction('up')      # client -> root
    down = Direction('down')  # root -> client
    queue = []                # (departure, seq, out_fd, direction, packet)
    seq = 0

    try:
        os.unlink(args.control)
    except FileNotFoundError:
        pass
    ctl = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    ctl.bind(args.control)
    ctl.listen(8)
    ctl.setblocking(False)
    conns = {}

    running = True

    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    print(json.dumps({'ready': True, 'pid': os.getpid()}), flush=True)

    def handle_ctl(line):
        msg = json.loads(line)
        op = msg.get('op')
        if op == 'set':
            if 'up' in msg:
                up.configure(msg['up'])
            if 'down' in msg:
                down.configure(msg['down'])
            return {'ok': True, 'up': up.profile, 'down': down.profile}
        if op == 'stats':
            return {'ok': True, 'up': up.counters, 'down': down.counters,
                    'queued': len(queue), 'profile': {'up': up.profile, 'down': down.profile}}
        return {'ok': False, 'error': 'unknown op'}

    while running:
        now = time.monotonic()
        timeout = 0.5
        if queue:
            timeout = max(0.0, min(timeout, queue[0][0] - now))
        rlist = [client_fd, root_fd, ctl] + list(conns.keys())
        try:
            readable, _, _ = select.select(rlist, [], [], timeout)
        except InterruptedError:
            continue
        now = time.monotonic()
        for r in readable:
            if r is ctl:
                try:
                    c, _ = ctl.accept()
                    c.setblocking(False)
                    conns[c] = b''
                except BlockingIOError:
                    pass
                continue
            if r in conns:
                try:
                    data = r.recv(65536)
                except BlockingIOError:
                    continue
                if not data:
                    conns.pop(r, None)
                    r.close()
                    continue
                buf = conns[r] + data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    try:
                        reply = handle_ctl(line.decode())
                    except Exception as e:  # malformed control input
                        reply = {'ok': False, 'error': str(e)}
                    r.sendall((json.dumps(reply) + '\n').encode())
                conns[r] = buf
                continue
            # Drain everything the kernel has for this device.
            direction, out_fd = (up, root_fd) if r == client_fd else (down, client_fd)
            while True:
                try:
                    pkt = os.read(r, 65536)
                except BlockingIOError:
                    break
                except OSError:
                    break
                if not pkt:
                    break
                dep = direction.schedule(now, len(pkt))
                if dep is None:
                    continue
                seq += 1
                heapq.heappush(queue, (dep, seq, out_fd, direction, pkt))
        now = time.monotonic()
        while queue and queue[0][0] <= now:
            _, _, out_fd, direction, pkt = heapq.heappop(queue)
            try:
                os.write(out_fd, pkt)
                direction.counters['tx_pkts'] += 1
                direction.counters['tx_bytes'] += len(pkt)
            except OSError:
                pass

    for c in list(conns):
        c.close()
    ctl.close()
    try:
        os.unlink(args.control)
    except FileNotFoundError:
        pass


if __name__ == '__main__':
    sys.exit(main())
