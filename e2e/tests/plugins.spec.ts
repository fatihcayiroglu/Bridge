// e2e/tests/plugins.spec.ts — Sprint 81
// Plugin sisteminin E2E entegrasyon testleri
//
// Kapsam:
//   1. Plugin yükleme API'si — POST /api/admin/plugins/load
//   2. Plugin listeleme — GET /api/admin/plugins
//   3. Plugin hook event: kendi listener'ını tetikler
//   4. Plugin emitToAll: cross-plugin broadcast
//   5. emitToAll rate-limit: 20 istek/saniye aşılınca sonraki çağrılar
//      yine de resolve eder (caller bloke olmaz)
//   6. Plugin kaldırma — POST /api/admin/plugins/unload
//
// Gereksinimler:
//   - BASE_URL ortamda ya da localhost:3000
//   - Admin kullanıcısı: ADMIN_USERNAME / ADMIN_PASSWORD env var
//   - Test plugin'leri: fixtures/plugins/ altında (aşağıda inline tanımlanır)

import { test, expect, request as pwRequest } from '@playwright/test';
import * as path from 'path';
import * as fs   from 'fs';
import * as os   from 'os';

const BASE_URL       = process.env.BASE_URL        || 'http://localhost:3000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME  || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD  || 'AdminPass123!';

// ── Yardımcılar ───────────────────────────────────────────────────────────────

async function adminToken(request: ReturnType<typeof pwRequest.newContext> extends Promise<infer R> ? R : never): Promise<string> {
  const res = await request.post(`${BASE_URL}/api/login`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!res.ok()) test.skip(true, `Admin giriş yapılamadı (${res.status()}) — ortam hazır değil`);
  const data = await res.json() as { token?: string };
  return data.token ?? '';
}

/** Geçici bir plugin dizini oluşturur ve main dosyasını yazar. */
function makePluginFixture(id: string, mainCode: string): string {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-plugin-e2e-${id}-`));
  const meta = { id, name: `E2E Test Plugin (${id})`, version: '0.0.1', main: 'index.js' };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), mainCode);
  return dir;
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('Plugin sistemi E2E', () => {
  let token = '';
  let request: Awaited<ReturnType<typeof pwRequest.newContext>>;
  const loadedPlugins: string[] = [];

  test.beforeAll(async () => {
    request = await pwRequest.newContext({ baseURL: BASE_URL });
    token   = await adminToken(request);
  });

  test.afterAll(async () => {
    // Yüklü kalan plugin'leri temizle
    for (const id of loadedPlugins) {
      await request.post(`${BASE_URL}/api/admin/plugins/unload`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        data: JSON.stringify({ id }),
      }).catch(() => { /* best-effort */ });
    }
    await request.dispose();
  });

  // ── [1] Plugin yükleme ─────────────────────────────────────────────────────

  test('plugin yükle → 200 ve id döner', async () => {
    const pluginDir = makePluginFixture('e2e-basic', `
      module.exports = async function(ctx) {
        ctx.logger.log('e2e-basic yüklendi');
      };
    `);

    const res = await request.post(`${BASE_URL}/api/admin/plugins/load`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ path: pluginDir }),
    });

    // Ortam desteklemiyorsa atla
    if (res.status() === 404 || res.status() === 501) {
      test.skip(true, 'Plugin yükleme API\'si bu ortamda aktif değil');
      return;
    }

    expect(res.ok()).toBeTruthy();
    const data = await res.json() as { id?: string };
    expect(data.id).toBe('e2e-basic');
    loadedPlugins.push('e2e-basic');
  });

  // ── [2] Plugin listeleme ───────────────────────────────────────────────────

  test('yüklü plugin listede görünür', async () => {
    const res = await request.get(`${BASE_URL}/api/admin/plugins`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status() === 404) {
      test.skip(true, 'Plugin listeleme API\'si bu ortamda aktif değil');
      return;
    }

    expect(res.ok()).toBeTruthy();
    const list = await res.json() as Array<{ id: string }>;
    const ids  = list.map(p => p.id);
    // e2e-basic ya yüklüdür ya da ortam bunu desteklemiyordur (skip)
    if (loadedPlugins.includes('e2e-basic')) {
      expect(ids).toContain('e2e-basic');
    }
  });

  // ── [3] Hook event — kendi listener'ını tetikler ──────────────────────────

  test('plugin kendi hook listener\'ını tetikleyebilir', async () => {
    const pluginDir = makePluginFixture('e2e-hook', `
      module.exports = async function(ctx) {
        let received = null;
        ctx.hooks.on('test:ping', (data) => { received = data; });
        await ctx.hooks.emit('test:ping', { ts: Date.now() });
        // Sonucu HTTP route üzerinden dışarıya aç
        ctx.registerRoute('GET', '/ping-result', (req, res) => {
          res.json({ received: received !== null });
        });
      };
    `);

    const loadRes = await request.post(`${BASE_URL}/api/admin/plugins/load`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ path: pluginDir }),
    });

    if (loadRes.status() === 404 || loadRes.status() === 501) {
      test.skip(true, 'Plugin API bu ortamda aktif değil');
      return;
    }

    expect(loadRes.ok()).toBeTruthy();
    loadedPlugins.push('e2e-hook');

    // Kısa bekleme — worker boot timeout'u aşmamak için
    await new Promise(r => setTimeout(r, 300));

    const res = await request.get(`${BASE_URL}/api/plugins/e2e-hook/ping-result`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json() as { received: boolean };
    expect(data.received).toBe(true);
  });

  // ── [4] emitToAll — cross-plugin broadcast ────────────────────────────────

  test('emitToAll başka plugin\'in wildcard listener\'ını tetikler', async () => {
    // Plugin B: wildcard listener kurar, sonucu HTTP route ile döner
    const dirB = makePluginFixture('e2e-receiver', `
      module.exports = async function(ctx) {
        let broadcastReceived = false;
        ctx.hooks.on('*', (event, data) => {
          if (event === 'cross:broadcast') broadcastReceived = true;
        });
        ctx.registerRoute('GET', '/received', (req, res) => {
          res.json({ broadcastReceived });
        });
      };
    `);

    // Plugin A: emitToAll çağırır
    const dirA = makePluginFixture('e2e-broadcaster', `
      module.exports = async function(ctx) {
        // Kısa gecikme — receiver worker'ının boot etmesini bekle
        await new Promise(r => setTimeout(r, 200));
        await ctx.hooks.emitToAll('cross:broadcast', { from: 'e2e-broadcaster' });
        ctx.registerRoute('GET', '/done', (req, res) => res.json({ ok: true }));
      };
    `);

    const loadB = await request.post(`${BASE_URL}/api/admin/plugins/load`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ path: dirB }),
    });

    if (loadB.status() === 404 || loadB.status() === 501) {
      test.skip(true, 'Plugin API bu ortamda aktif değil');
      return;
    }

    expect(loadB.ok()).toBeTruthy();
    loadedPlugins.push('e2e-receiver');

    const loadA = await request.post(`${BASE_URL}/api/admin/plugins/load`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ path: dirA }),
    });
    expect(loadA.ok()).toBeTruthy();
    loadedPlugins.push('e2e-broadcaster');

    // Broadcaster'ın emitToAll'ı tamamlamasını bekle
    await new Promise(r => setTimeout(r, 800));

    const res = await request.get(`${BASE_URL}/api/plugins/e2e-receiver/received`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json() as { broadcastReceived: boolean };
    expect(data.broadcastReceived).toBe(true);
  });

  // ── [5] emitToAll rate-limit — caller bloke olmaz ─────────────────────────

  test('emitToAll rate-limit aşılınca çağrılar yine resolve eder', async () => {
    const dir = makePluginFixture('e2e-ratelimit', `
      module.exports = async function(ctx) {
        // 25 emitToAll çağrısı — limit 20/s, 5'i düşürülmeli
        let resolved = 0;
        const calls = [];
        for (let i = 0; i < 25; i++) {
          calls.push(ctx.hooks.emitToAll('rl:test', { i }).then(() => { resolved++; }));
        }
        await Promise.all(calls);
        ctx.registerRoute('GET', '/result', (req, res) => {
          res.json({ resolved });
        });
      };
    `);

    const loadRes = await request.post(`${BASE_URL}/api/admin/plugins/load`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ path: dir }),
    });

    if (loadRes.status() === 404 || loadRes.status() === 501) {
      test.skip(true, 'Plugin API bu ortamda aktif değil');
      return;
    }

    expect(loadRes.ok()).toBeTruthy();
    loadedPlugins.push('e2e-ratelimit');

    await new Promise(r => setTimeout(r, 600));

    const res = await request.get(`${BASE_URL}/api/plugins/e2e-ratelimit/result`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json() as { resolved: number };
    // Tüm 25 çağrı resolve olmalı (rate-limit düşürür ama bloke etmez)
    expect(data.resolved).toBe(25);
  });

  // ── [6] Plugin kaldırma ────────────────────────────────────────────────────

  test('plugin kaldırıldıktan sonra listede görünmez', async () => {
    // e2e-basic yüklenmediyse bu testi de atla
    if (!loadedPlugins.includes('e2e-basic')) {
      test.skip(true, 'e2e-basic yüklenmedi — önceki test atlandı');
      return;
    }

    const unloadRes = await request.post(`${BASE_URL}/api/admin/plugins/unload`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ id: 'e2e-basic' }),
    });
    expect(unloadRes.ok()).toBeTruthy();
    loadedPlugins.splice(loadedPlugins.indexOf('e2e-basic'), 1);

    const listRes = await request.get(`${BASE_URL}/api/admin/plugins`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json() as Array<{ id: string }>;
    expect(list.map(p => p.id)).not.toContain('e2e-basic');
  });
});
