// plugins/lifecycle.ts
// Plugin load / unload lifecycle management
//
// Sprint 65: .js → .ts geçişi — tam tip güvenliği
// Sprint 77: 5 sandbox güçlendirmesi
//   [1] resourceLimits — CPU/memory sınırı (plugin sonsuz döngüye giremez)
//   [2] Worker boot timeout — ready mesajı gelmezse 10s sonra terminate
//   [3] allowlist.ts console.warn → logger geçişi (bu dosyada da logger kullanılıyor)
//   [4] require() → import() — ESM uyumlu dinamik yükleme
//   [5] HTTP route proxy — registerRoute artık gerçek Express handler çalıştırır
//       (MessageChannel üzerinden senkron istek/yanıt döngüsü)
//   [5b] Mock req/res genişletildi: next(), redirect(), set()/header(), _headersSent guard

import { Worker, isMainThread, parentPort, workerData, MessageChannel } from 'worker_threads';
import * as path from 'path';
import type { Application, Request, Response } from 'express';
import type { Server as IOServer } from 'socket.io';

export interface PluginMeta {
  id:       string;
  name:     string;
  version:  string;
  author?:  string;
  [key: string]: unknown;
}

interface PluginLogger {
  info?:  (...args: unknown[]) => void;
  warn?:  (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface PluginRegistry {
  register:   (id: string, meta: PluginMeta) => PluginHooks;
  unregister: (id: string) => void;
  emit:       (event: string, ...args: unknown[]) => void | Promise<void>;
  list:       () => PluginMeta[];
  count:      () => number;
}

interface PluginHooks {
  on:        (event: string, handler: (...args: any[]) => unknown) => void;
  emit:      (event: string, ...args: unknown[]) => Promise<void>;
  /**
   * emitToAll — tüm plugin'lere (wildcard dahil) broadcast yapar.
   * ctx.hooks.emit() yalnızca kendi wildcard'larını tetikler; bu metod izolasyonu kırar.
   * Kasıtlı cross-plugin broadcast için kullanın.
   */
  emitToAll: (event: string, ...args: unknown[]) => Promise<void>;
}

export interface PluginContext {
  meta:   PluginMeta;
  hooks:  PluginHooks;
  db:     unknown;
  io:     IOServer;
  app:    Application;
  logger: {
    log:   (...args: unknown[]) => void;
    warn:  (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  registerRoute: (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path:   string,
    handler: (req: Request, res: Response, next?: (err?: unknown) => void) => void,
  ) => void;
  // Sprint 78: Sandbox içi middleware zinciri
  // Eklenen middleware'ler tüm registerRoute handler'larından ÖNCE çalışır.
  // Ana Express middleware stack'i (auth, CSRF, rate-limit) bunlardan bağımsızdır.
  addMiddleware: (
    fn: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  ) => void;
}

interface LoadedEntry {
  meta:     PluginMeta;
  worker:   Worker;
  teardown: (() => Promise<void>);
}

export interface LoadOpts {
  base:     string;
  meta:     PluginMeta;
  main:     string;
  app:      Application;
  db:       unknown;
  io:       IOServer;
  registry: PluginRegistry;
  logger:   PluginLogger;
}

// ── Sandbox limits ────────────────────────────────────────────
// [1] Her plugin worker'ına uygulanan kaynak sınırları.
//     Aşılırsa worker otomatik sonlandırılır — ana process etkilenmez.
const WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 128,   // JS heap üst sınırı (MB)
  maxYoungGenerationSizeMb: 32,  // Eden space üst sınırı (MB)
  codeRangeSizeMb: 16,           // JIT kodu için ayrılan alan (MB)
  stackSizeMb: 4,                // Call stack üst sınırı (MB)
};

// [2] Worker'ın 'ready' mesajı göndermesi için maksimum süre (ms).
//     Bu süre içinde hazır olmazsa worker terminate edilir.
const WORKER_BOOT_TIMEOUT_MS = 10_000;

// [6] emitToAll rate-limit: bir plugin worker'ının belirli bir süre (pencere)
//     içinde gönderebileceği maksimum hook:event:broadcast mesajı sayısı.
//     Aşılırsa mesaj sessizce düşürülür ve bir kez uyarı loglanır.
//     ctx.hooks.emit() izole olduğu için bu riski taşımaz; emitToAll'a özgüdür.
export const BROADCAST_RATE_LIMIT   = 20;   // pencere başına maksimum broadcast
export const BROADCAST_RATE_WINDOW_MS = 1_000; // pencere süresi (ms)

// ── RPC message shapes ────────────────────────────────────────
type MainToWorker =
  | { type: 'hook:event';                event: string; args: unknown[] }
  | { type: 'hook:event:broadcast';      event: string; args: unknown[]; ackId: string }
  | { type: 'hook:event:broadcast:ack';  ackId: string }
  | { type: 'teardown' }
  | { type: 'http:request';  reqId: string; method: string; routePath: string; body: unknown; query: unknown; headers: Record<string, string> };

type WorkerToMain =
  | { type: 'log';           level: 'log' | 'warn' | 'error'; args: unknown[] }
  | { type: 'io:emit';       room: string; event: string; data: unknown }
  | { type: 'route:register'; method: string; routePath: string }
  | { type: 'http:response'; reqId: string; status: number; body: unknown }
  | { type: 'ready' }
  | { type: 'torn_down' }
  | { type: 'error';         message: string }
  | { type: 'hook:event';                event: string; args: unknown[] }
  | { type: 'hook:event:broadcast';      event: string; args: unknown[]; ackId: string };

const _loaded = new Map<string, LoadedEntry>();

// ── Worker thread entry point ─────────────────────────────────
// Bu blok yalnızca worker içinde çalışır.
if (!isMainThread && parentPort) {
  const { loadPath, meta } = workerData as { loadPath: string; meta: PluginMeta };
  const port = parentPort;

  // Plugin'in registerRoute ile kaydettiği handler'lar burada tutulur.
  // Ana thread HTTP isteği gelince 'http:request' mesajı gönderir;
  // worker handler'ı çalıştırıp 'http:response' ile yanıt verir.
  const _routeHandlers = new Map<string, (req: Request, res: Response, next?: (err?: unknown) => void) => void>();

  // Sprint 78: Sandbox içi middleware zinciri.
  // Her plugin kendi stack'ini tutar — cross-plugin izolasyonu korunur.
  type SandboxMiddlewareFn = (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => void;
  const _middlewareStack: SandboxMiddlewareFn[] = [];

  // Middleware zincirini çalıştırıp sonunda finalHandler'ı çağırır.
  // next(err) ile hata iletilirse stack'te 4-argümanlı handler aranır;
  // bulunamazsa 500 döner.
  function _runMiddlewareChain(
    mockReq: unknown,
    mockRes: { _headersSent: boolean; status(c: number): { json(b: unknown): void }; json(b: unknown): void },
    finalHandler: SandboxMiddlewareFn,
  ): void {
    const stack: SandboxMiddlewareFn[] = [..._middlewareStack, finalHandler];
    let i = 0;

    const dispatch = (err?: unknown): void => {
      if (mockRes._headersSent) return;
      if (err) {
        // 4-argümanlı hata handler: (err, req, res, next)
        const errHandler = stack.slice(i).find(fn => fn.length >= 4) as
          | ((e: unknown, req: unknown, res: unknown, next: () => void) => void)
          | undefined;
        if (errHandler) {
          errHandler(err, mockReq, mockRes, () => {});
        } else {
          mockRes.status(500).json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      const fn = stack[i++];
      if (!fn) {
        mockRes.status(404).json({ error: 'No handler matched in plugin sandbox.' });
        return;
      }
      try {
        fn(mockReq as Request, mockRes as unknown as Response, dispatch);
      } catch (e) {
        dispatch(e);
      }
    };

    dispatch();
  }

  const ctx: PluginContext = {
    meta,
    hooks: {
      on:   (event, handler) => {
        port.on('message', (msg: MainToWorker) => {
          if (msg.type === 'hook:event' && msg.event === event) handler(msg.args[0]);
        });
      },
      emit: (event, data) => {
        port.postMessage({ type: 'hook:event', event, args: [data] } satisfies MainToWorker);
        return Promise.resolve();
      },
      // Sprint 80: opt-in cross-plugin broadcast
      // Ana thread'e 'hook:event:broadcast' mesajı gönderir ve ack bekler.
      // Bu sayede await ctx.hooks.emitToAll(...) broadcast tamamlanmadan resolve etmez.
      emitToAll: (event, data) => {
        return new Promise<void>((resolve) => {
          const ackId = `bcast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const cleanup = () => {
            port.off('message', onAck);
            port.off('close', onClose);
          };
          const onAck = (msg: MainToWorker) => {
            if (msg.type === 'hook:event:broadcast:ack' && msg.ackId === ackId) {
              cleanup();
              resolve();
            }
          };
          const onClose = () => {
            // Port kapandı (worker sonlandı) — listener'ı temizle, Promise'i resolve et.
            // Caller açısından "broadcast tamamlandı" sayılır; worker zaten yok.
            cleanup();
            resolve();
          };
          port.on('message', onAck);
          port.once('close', onClose);
          port.postMessage({ type: 'hook:event:broadcast', event, args: [data], ackId } satisfies MainToWorker);
        });
      },
    },
    // [4] db/io/app: worker thread'de doğrudan erişim yok — Proxy hata fırlatır.
    db:  new Proxy({}, { get: () => { throw new Error('[Plugin sandbox] db doğrudan erişilemez; hook RPC kullanın.'); } }),
    io:  new Proxy({}, { get: () => { throw new Error('[Plugin sandbox] io doğrudan erişilemez; hook RPC kullanın.'); } }) as unknown as IOServer,
    app: new Proxy({}, { get: () => { throw new Error('[Plugin sandbox] app doğrudan erişilemez; registerRoute kullanın.'); } }) as unknown as Application,
    logger: {
      log:   (...a) => port.postMessage({ type: 'log', level: 'log',   args: a } satisfies WorkerToMain),
      warn:  (...a) => port.postMessage({ type: 'log', level: 'warn',  args: a } satisfies WorkerToMain),
      error: (...a) => port.postMessage({ type: 'log', level: 'error', args: a } satisfies WorkerToMain),
    },
    // [5] registerRoute: handler worker'da saklanır; ana thread HTTP proxy ile iletir.
    registerRoute(method, routePath, handler) {
      const key = `${method.toUpperCase()}:${routePath}`;
      _routeHandlers.set(key, handler as (req: Request, res: Response, next?: (err?: unknown) => void) => void);
      port.postMessage({ type: 'route:register', method, routePath } satisfies WorkerToMain);
    },
    // Sprint 78: addMiddleware — sandbox içi middleware zinciri
    addMiddleware(fn) {
      _middlewareStack.push(fn as unknown as SandboxMiddlewareFn);
    },
  };

  // [5] Ana thread'den gelen HTTP isteklerini karşıla
  port.on('message', (msg: MainToWorker) => {
    if (msg.type !== 'http:request') return;
    const { reqId, method, routePath, body, query, headers } = msg;
    const key = `${method.toUpperCase()}:${routePath}`;
    const handler = _routeHandlers.get(key);
    if (!handler) {
      port.postMessage({ type: 'http:response', reqId, status: 404, body: { error: 'Route not found in plugin.' } } satisfies WorkerToMain);
      return;
    }
    // req/res mock'u — worker thread sınırları içinde Express subset'ini karşılar.
    // Desteklenen: status(), json(), send(), set()/header(), redirect(), next()
    const mockReq = {
      method,
      path: routePath,
      body,
      query,
      headers,
      params: {} as Record<string, string>,
    };
    const mockRes = {
      _status: 200,
      _headersSent: false,
      _headers: {} as Record<string, string>,
      status(code: number) { this._status = code; return this; },
      set(field: string, value?: string) {
        if (typeof field === 'object') {
          Object.assign(this._headers, field);
        } else if (value !== undefined) {
          this._headers[field] = value;
        }
        return this;
      },
      header(field: string, value?: string) { return this.set(field, value); },
      json(data: unknown) {
        if (this._headersSent) return;
        this._headersSent = true;
        port.postMessage({ type: 'http:response', reqId, status: this._status, body: data } satisfies WorkerToMain);
      },
      send(data: unknown) {
        if (this._headersSent) return;
        this._headersSent = true;
        const body = typeof data === 'object' ? data : { data };
        port.postMessage({ type: 'http:response', reqId, status: this._status, body } satisfies WorkerToMain);
      },
      redirect(urlOrStatus: string | number, url?: string) {
        if (this._headersSent) return;
        this._headersSent = true;
        const redirectUrl = typeof urlOrStatus === 'string' ? urlOrStatus : (url ?? '/');
        const redirectStatus = typeof urlOrStatus === 'number' ? urlOrStatus : 302;
        port.postMessage({ type: 'http:response', reqId, status: redirectStatus, body: { redirect: redirectUrl } } satisfies WorkerToMain);
      },
    };
    // Sprint 78: mockNext artık kullanılmıyor — _runMiddlewareChain zinciri yönetiyor.
    // Doğrudan handler çağrısı yerine middleware zincirini çalıştır.
    _runMiddlewareChain(
      mockReq,
      mockRes,
      (req, res, next) => {
        try {
          handler(req, res, next);
        } catch (e) {
          if (!mockRes._headersSent) {
            port.postMessage({ type: 'http:response', reqId, status: 500, body: { error: (e as Error).message } } satisfies WorkerToMain);
          }
        }
      },
    );
  });

  (async () => {
    try {
      // [4] require() → dynamic import() — ESM uyumlu
      const pluginModule = await import(loadPath) as { setup: (ctx: PluginContext) => Promise<{ teardown?: () => Promise<void> } | void> };
      const result = await pluginModule.setup(ctx);
      port.postMessage({ type: 'ready' } satisfies WorkerToMain);

      port.on('message', async (msg: MainToWorker) => {
        if (msg.type === 'teardown') {
          try { await result?.teardown?.(); } catch { /* teardown hataları yutulur */ }
          port.postMessage({ type: 'torn_down' } satisfies WorkerToMain);
          process.exit(0);
        }
      });
    } catch (e) {
      port.postMessage({ type: 'error', message: (e as Error).message } satisfies WorkerToMain);
      process.exit(1);
    }
  })();
}

// ── Ana thread: plugin'i worker içinde başlat ─────────────────
async function load({ meta, main, app, io, registry, logger }: LoadOpts): Promise<void> {
  if (_loaded.has(meta.id)) {
    logger.warn?.(`[Lifecycle] ${meta.id} already loaded, skipping`);
    return;
  }

  const hooks = registry.register(meta.id, meta);
  const loadPath = main.endsWith('.ts') ? main.replace(/\.ts$/, '.js') : main;

  // [1] resourceLimits ile worker oluştur
  const worker = new Worker(path.resolve(__filename), {
    workerData: { loadPath, meta },
    resourceLimits: WORKER_RESOURCE_LIMITS,
  });

  // [5] Bekleyen HTTP isteklerini sakla (reqId → { resolve, timer })
  const _pendingRequests = new Map<string, { resolve: (r: { status: number; body: unknown }) => void; timer: ReturnType<typeof setTimeout> }>();

  // emitToAll RPC: bekleyen broadcast ack'leri (ackId → resolve)
  // Teardown sırasında temizlenerek Promise leak'i önlenir.
  const _pendingBroadcasts = new Map<string, () => void>();

  // [6] emitToAll rate-limit: BROADCAST_RATE_WINDOW_MS penceresi içindeki broadcast sayısı.
  // BROADCAST_RATE_LIMIT aşılırsa mesaj düşürülür; ack hemen gönderilir (caller bloke olmaz).
  let _broadcastCount = 0;
  let _broadcastWindowTimer: ReturnType<typeof setTimeout> | null = null;

  function _broadcastAllowed(): boolean {
    if (_broadcastWindowTimer === null) {
      _broadcastWindowTimer = setTimeout(() => {
        _broadcastCount = 0;
        _broadcastWindowTimer = null;
      }, BROADCAST_RATE_WINDOW_MS);
    }
    _broadcastCount++;
    if (_broadcastCount > BROADCAST_RATE_LIMIT) {
      if (_broadcastCount === BROADCAST_RATE_LIMIT + 1) {
        // Yalnızca ilk aşımda logla — sonraki her mesajda log basma
        logger.warn?.(
          `[Lifecycle] ${meta.id}: emitToAll rate-limit aşıldı ` +
          `(>${BROADCAST_RATE_LIMIT} broadcast/${BROADCAST_RATE_WINDOW_MS}ms). ` +
          `Mesaj düşürüldü.`
        );
      }
      return false;
    }
    return true;
  }

  worker.on('message', (msg: WorkerToMain) => {
    switch (msg.type) {
      case 'log':
        logger[msg.level as 'info' | 'warn' | 'error']?.(`[Plugin:${meta.id}]`, ...msg.args);
        break;
      case 'io:emit':
        io.to(msg.room).emit(msg.event, msg.data);
        break;
      case 'route:register':
        // [5] Route kaydedilince Express'e gerçek proxy handler ekle
        logger.info?.(`[Lifecycle] ${meta.id} route: ${msg.method} /api/plugins/${meta.id}${msg.routePath}`);
        (app as Application)[msg.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](
          `/api/plugins/${meta.id}${msg.routePath}`,
          (req: Request, res: Response) => {
            const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timer = setTimeout(() => {
              _pendingRequests.delete(reqId);
              res.status(504).json({ error: 'Plugin request timed out.' });
            }, 5_000);
            _pendingRequests.set(reqId, {
              resolve: ({ status, body }) => {
                clearTimeout(timer);
                res.status(status).json(body);
              },
              timer,
            });
            worker.postMessage({
              type: 'http:request',
              reqId,
              method: req.method,
              routePath: msg.routePath,
              body: req.body,
              query: req.query,
              // Fix #6: Express headers are string | string[] | undefined.
              // Flatten arrays (e.g. set-cookie) to comma-joined strings so
              // the worker always receives Record<string, string>.
              headers: Object.fromEntries(
                Object.entries(req.headers)
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v as string]),
              ),
            } satisfies MainToWorker);
          },
        );
        break;
      case 'http:response': {
        const pending = _pendingRequests.get(msg.reqId);
        if (pending) {
          _pendingRequests.delete(msg.reqId);
          pending.resolve({ status: msg.status, body: msg.body });
        }
        break;
      }
      case 'ready':
        clearTimeout(bootTimer);
        logger.info?.(`[Lifecycle] Sandboxed + loaded: ${meta.id} v${meta.version}`);
        break;
      case 'error':
        clearTimeout(bootTimer);
        registry.unregister(meta.id);
        logger.error?.(`[Lifecycle] Failed to load ${meta.id}: ${msg.message}`);
        break;
      case 'hook:event':
        // Fix #2: was duplicated in a separate if-block after the switch — removed.
        hooks.emit(msg.event, ...msg.args);
        break;
      case 'hook:event:broadcast':
        // Sprint 80: emitToAll() — tüm plugin worker'larına broadcast.
        // Sprint 81: [6] rate-limit koruması — BROADCAST_RATE_LIMIT aşılırsa
        //   mesaj düşürülür, ack hemen gönderilir (caller asılı kalmaz).
        if (!_broadcastAllowed()) {
          // Rate-limit: ack'i hemen gönder, caller'ı bloke etme.
          worker.postMessage({
            type: 'hook:event:broadcast:ack',
            ackId: msg.ackId,
          } satisfies MainToWorker);
          break;
        }
        // registry.emit() beklenir; tamamlanınca ack worker'a geri gönderilir.
        // Bu sayede await ctx.hooks.emitToAll() doğru semantiği korur.
        void Promise.resolve(registry.emit(msg.event, ...msg.args)).then(() => {
          // _pendingBroadcasts'ten silinmişse (teardown) ack gönderme.
          if (!_pendingBroadcasts.has(msg.ackId)) return;
          _pendingBroadcasts.delete(msg.ackId);
          worker.postMessage({
            type: 'hook:event:broadcast:ack',
            ackId: msg.ackId,
          } satisfies MainToWorker);
        });
        // Teardown'da resolve edebilmek için ackId'yi kaydet.
        _pendingBroadcasts.set(msg.ackId, () => { /* resolved via ack or teardown */ });
        break;
    }
  });

  worker.on('error', (err) => {
    clearTimeout(bootTimer); // Fix #1: prevent stale terminate after crash
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error?.(`[Lifecycle] Worker error (${meta.id}): ${errorMessage}`);
    registry.unregister(meta.id);
    _loaded.delete(meta.id);
  });

  worker.on('exit', (code) => {
    clearTimeout(bootTimer); // Fix #1: prevent stale terminate after exit
    if (code !== 0) logger.warn?.(`[Lifecycle] Worker exited with code ${code} (${meta.id})`);
    registry.unregister(meta.id);
    _loaded.delete(meta.id);
  });

  hooks.on('*', (event: string, ...args: unknown[]) => {
    worker.postMessage({ type: 'hook:event', event, args } satisfies MainToWorker);
  });

  // [2] Boot timeout: 10 saniye içinde 'ready' gelmezse terminate
  const bootTimer = setTimeout(() => {
    logger.error?.(`[Lifecycle] Boot timeout (${WORKER_BOOT_TIMEOUT_MS}ms): ${meta.id} — terminating`);
    registry.unregister(meta.id);
    _loaded.delete(meta.id);
    void worker.terminate();
  }, WORKER_BOOT_TIMEOUT_MS);

  const teardown = (): Promise<void> =>
    new Promise((resolve) => {
      // Fix #3: cancel all in-flight HTTP proxy timers so Express responses
      // aren't left dangling after the worker is gone.
      for (const { timer } of _pendingRequests.values()) clearTimeout(timer);
      _pendingRequests.clear();
      // emitToAll RPC: in-flight broadcast ack'leri temizle.
      // Worker kapanınca ack asla gelmeyecek; map'i boşalt.
      _pendingBroadcasts.clear();
      // [6] rate-limit pencere timer'ını temizle.
      if (_broadcastWindowTimer !== null) { clearTimeout(_broadcastWindowTimer); _broadcastWindowTimer = null; }

      const timeout = setTimeout(() => { void worker.terminate(); resolve(); }, 5_000);
      // Fix #4: use worker.on (not .once) so an intermediate non-torn_down
      // message (e.g. a late 'log') doesn't consume the listener before
      // torn_down arrives.
      const onMsg = (msg: WorkerToMain) => {
        if (msg.type !== 'torn_down') return;
        worker.off('message', onMsg);
        clearTimeout(timeout);
        void worker.terminate();
        resolve();
      };
      worker.on('message', onMsg);
      worker.postMessage({ type: 'teardown' } satisfies MainToWorker);
    });

  _loaded.set(meta.id, { meta, worker, teardown });
}

async function unload(id: string, registry: PluginRegistry): Promise<void> {
  const entry = _loaded.get(id);
  if (!entry) return;
  try { await entry.teardown(); } catch { registry.unregister(id); }
  registry.unregister(id);
  _loaded.delete(id);
}

function loadedList(): PluginMeta[] {
  return [..._loaded.values()].map(e => e.meta);
}

export { load, unload, loadedList, WORKER_RESOURCE_LIMITS, WORKER_BOOT_TIMEOUT_MS };
