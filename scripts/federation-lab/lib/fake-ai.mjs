// scripts/federation-lab/lib/fake-ai.mjs
//
// A real HTTP server speaking the OpenAI chat-completions API — the same wire
// protocol vLLM, llama.cpp server, LM Studio, LocalAI and Ollama /v1 speak.
// Bridge reaches it through its ordinary provider code (AI_PROVIDER=
// openai-compatible), not an in-process mock, and the lab inspects EVERY
// request body that crossed the boundary. No test data goes to a real AI
// service.
//
// modes: ok | fail500 | hang

import http from 'node:http';

export class FakeAiProvider {
  constructor({ port }) {
    this.port = port;
    this.mode = 'ok';
    this.requests = []; // { at, path, auth, body (parsed), raw }
    this.sockets = new Set();
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}/v1`; }

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* recorded raw */ }
        this.requests.push({ at: Date.now(), path: req.url, auth: req.headers.authorization || null, body, raw });
        if (this.mode === 'hang') return; // never answer
        if (this.mode === 'fail500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'lab-internal-detail 10.9.8.7:8000 exploded' } }));
          return;
        }
        if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
        if (body?.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lab-answer' } }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'lab-answer' } }] }));
      });
    });
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
  }

  /** Everything any request carried to the provider since index `from`. */
  textSince(from = 0) { return this.requests.slice(from).map((r) => r.raw).join('\n'); }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}
