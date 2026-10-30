// Ephemeral CI TLS termination in front of the unmodified real Bridge runtime.
// Binds loopback only. No certificate/authentication overrides or response mocks.
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
const server = https.createServer({ key: fs.readFileSync(process.env.BRIDGE_PERF_TLS_KEY),
  cert: fs.readFileSync(process.env.BRIDGE_PERF_TLS_CERT), minVersion: 'TLSv1.2' }, (req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: 3000, path: req.url, method: req.method,
    headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(3000, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(req.headers)) {
      if (name !== 'x-forwarded-proto') upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write('x-forwarded-proto: https\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(3443, '127.0.0.1', () => console.log('PERF_TLS_LOOPBACK_READY'));
