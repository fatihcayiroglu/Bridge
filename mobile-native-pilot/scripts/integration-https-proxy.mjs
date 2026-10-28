// Disposable CI-only TLS terminator; fixed loopback upstream, no remote targets.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const server = https.createServer({ key: readFileSync(process.env.IT_TLS_KEY), cert: readFileSync(process.env.IT_TLS_CERT) }, (req, res) => {
  const route = req.url?.split('?')[0];
  const kind = ({ '/api/native-auth/token': 'native-code', '/api/native-auth/refresh': 'native-refresh',
    '/api/refresh/logout': 'revoke', '/api/servers': 'servers' })[route];
  if (req.method === 'POST' && req.url?.split('?')[0] === '/api/refresh/native-authorize') {
    // Closed, CI-only wire evidence: never log cookie, URL, body, code or state.
    const origin = req.headers.origin === 'https://127.0.0.1:8443' ? 'expected'
      : req.headers.origin === 'null' ? 'null' : req.headers.origin ? 'other' : 'absent';
    const site = req.headers['sec-fetch-site'];
    const fetchSite = ['same-origin', 'same-site', 'cross-site', 'none'].includes(site) ? site : site ? 'other' : 'absent';
    console.log('NATIVE_CONSENT_BOUNDARY ' + JSON.stringify({ origin, fetchSite }));
  }
  const upstream = http.request({ host: '127.0.0.1', port: 3001, method: req.method, path: req.url,
    headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, reply => {
    if (kind) console.log('NATIVE_AUTH_HTTP ' + JSON.stringify({ kind, status: reply.statusCode,
      cookiePresent: !!req.headers.cookie, bearerPresent: /^Bearer /.test(req.headers.authorization ?? '') }));
    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(3001, '127.0.0.1', () => {
    const headers = Object.entries({ ...req.headers, 'x-forwarded-proto': 'https' })
      .map(([key, value]) => `${key}: ${value}`).join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.listen(8443, '127.0.0.1', () => console.log('CI HTTPS proxy listening on loopback:8443'));
