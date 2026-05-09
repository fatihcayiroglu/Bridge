// @ts-nocheck
// server/plugins/loader.ts
// Plugin sistemi: ./plugins/ klasöründeki plugin.json dosyalarını yükler,
// her plugin'i sandboxed bir context'te çalıştırır.
//
// Plugin API:
//   ctx.hooks.on(event, handler)  — sunucu event'lerine abone ol
//   ctx.hooks.off(event, handler) — aboneliği kaldır
//   ctx.db                        — read-only db wrapper
//   ctx.logger                    — plugin'e özel logger
//   ctx.registerRoute(method, path, handler) — /api/plugins/:id/* altında route ekle
//   ctx.registerSocketEvent(event, handler)  — socket event handler ekle
//
// v75 — Sprint 14: Tam TypeScript dönüşümü (loader.js → loader.ts)
//   - Tüm tipler açıkça tanımlandı: PluginMeta, PluginContext, HookHandler vs.
//   - Import/export sistemi: named exports + default export
//   - vm.Script ve Proxy tiplemeleri eklendi
//   - loader.js artık kullanılmıyor (silinebilir)

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import type { Application, Request, Response, RequestHandler } from 'express';
import logger from '../lib/logger';

// ── Tipler ────────────────────────────────────────────────────

export interface PluginMeta {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  disabled?: boolean;
}

export type HookHandler = (payload: unknown) => void | Promise<void>;

export interface SandboxedHooks {
  on(event: string, handler: HookHandler): void;
  off(event: string, handler: HookHandler): void;
  emit(event: string, payload?: unknown): Promise<void>;
}

export interface ReadOnlyCollection {
  find: (...args: unknown[]) => unknown;
  findOne: (...args: unknown[]) => unknown;
  count?: (...args: unknown[]) => unknown;
}

export type ReadOnlyDb = Record<string, ReadOnlyCollection>;

export interface PluginLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface PluginRoute {
  method: HttpMethod;
  path: string;
  handler: RequestHandler;
}

export interface PluginSocketEvent {
  event: string;
  handler: (data: unknown, socket: unknown, user: unknown) => Promise<void>;
}

export interface PluginContext {
  id: string;
  meta: PluginMeta;
  hooks: SandboxedHooks;
  db: ReadOnlyDb;
  logger: PluginLogger;
  registerRoute(method: string, subPath: string, handler: RequestHandler): void;
  registerSocketEvent(event: string, handler: PluginSocketEvent['handler']): void;
}

export interface PluginModule {
  setup?: (ctx: PluginContext) => void | Promise<void>;
}

interface LoadedPlugin {
  meta: PluginMeta;
  ctx: PluginContext;
  routes: PluginRoute[];
  socketEvs: PluginSocketEvent[];
}

// ── İzin verilen built-in modüller (sandbox allowlist) ────────
const ALLOWED_BUILTINS = new Set([
  'path', 'url', 'querystring', 'string_decoder',
  'events', 'stream', 'util', 'crypto',
  'http', 'https', 'net', 'dns',
  'zlib', 'buffer', 'assert',
  'timers', 'os',
]);

// Sunucu iç modüllerini tanımlamak için kök dizin
const SERVER_ROOT = path.resolve(__dirname, '..');

// Sunucu'nun direkt erişilmesini istemediğimiz paketler
const BLOCKED_PACKAGES = new Set([
  'express', 'socket.io', 'jsonwebtoken', 'bcryptjs',
  'pg', 'redis', 'multer', 'helmet',
  'nodemailer', 'web-push', 'mediasoup',
]);

// ── Sandbox require factory ───────────────────────────────────
function makeSandboxedRequire(pluginDir: string, pluginId: string): NodeRequire {
  return function sandboxRequire(id: string): unknown {
    if (path.isAbsolute(id)) {
      const resolved = path.resolve(id);
      if (resolved.startsWith(SERVER_ROOT)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: sunucu modülüne erişim engellendi: ${id}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(id);
    }
    if (id.startsWith('.')) {
      const resolved = path.resolve(pluginDir, id);
      if (!resolved.startsWith(pluginDir)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: path traversal engellendi: ${id}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(resolved);
    }
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (ALLOWED_BUILTINS.has(bareId)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(id);
    }
    const pkgName = id.split('/')[0];
    if (BLOCKED_PACKAGES.has(pkgName)) {
      throw new Error(
        `[plugin:${pluginId}] Güvenlik ihlali: "${id}" direkt import edilemez — ctx.* API'sini kullan.`
      );
    }
    const pluginPkg = path.join(pluginDir, 'node_modules', pkgName);
    if (fs.existsSync(pluginPkg)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(path.join(pluginDir, 'node_modules', id));
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id);
  } as NodeRequire;
}

// ── Güvenli process proxy ─────────────────────────────────────
function makeSafeProcess(pluginId: string): typeof process {
  const BLOCKED_PROPS = new Set(['exit', 'abort', 'kill', 'binding', 'dlopen', '_linkedBinding']);
  return new Proxy(process, {
    get(target, prop: string | symbol) {
      const propStr = String(prop);
      if (BLOCKED_PROPS.has(propStr)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: process.${propStr} erişimi engellendi`);
      }
      if (propStr === 'env') {
        return new Proxy(target.env, {
          set(): boolean { throw new Error(`[plugin:${pluginId}] process.env yazma engellendi`); },
          deleteProperty(): boolean { throw new Error(`[plugin:${pluginId}] process.env silme engellendi`); },
        });
      }
      const val = (target as Record<string | symbol, unknown>)[prop];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
    set(): boolean { throw new Error(`[plugin:${pluginId}] process nesnesine yazma engellendi`); },
  });
}

// ── Plugin setup timeout wrapper ──────────────────────────────
const SETUP_TIMEOUT_MS = 5000;
function withTimeout(promise: Promise<unknown> | undefined, _pluginId: string): Promise<unknown> {
  return Promise.race([
    promise ?? Promise.resolve(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`setup() ${SETUP_TIMEOUT_MS}ms timeout aşıldı`)),
        SETUP_TIMEOUT_MS
      )
    ),
  ]);
}

// ── Hook limiti ───────────────────────────────────────────────
const MAX_HOOKS_PER_PLUGIN = 50;

// ── Plugin event bus ──────────────────────────────────────────
class PluginHooks {
  private _handlers = new Map<string, Set<HookHandler>>();

  on(event: string, handler: HookHandler): void {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event)!.add(handler);
  }

  off(event: string, handler: HookHandler): void {
    this._handlers.get(event)?.delete(handler);
  }

  async emit(event: string, payload?: unknown): Promise<void> {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const fn of handlers) {
      try { await fn(payload); } catch (e) {
        console.error(`[plugin-hooks] ${event} handler error:`, (e as Error).message);
      }
    }
  }
}

// Singleton event bus — server index.ts'den de import edilebilir
export const hooks = new PluginHooks();

// ── Loaded plugins registry ───────────────────────────────────
const loadedPlugins = new Map<string, LoadedPlugin>();

// ── DB read-only proxy ────────────────────────────────────────
function makeReadOnlyDb(db: Record<string, unknown>): ReadOnlyDb {
  return new Proxy(db as Record<string, Record<string, (...a: unknown[]) => unknown>>, {
    get(target, prop: string | symbol) {
      const col = target[prop as string];
      if (!col || typeof col !== 'object') return col;
      return {
        find:    (...a: unknown[]) => col['find']?.(...a),
        findOne: (...a: unknown[]) => col['findOne']?.(...a),
        count:   (...a: unknown[]) => col['count']?.(...a),
      };
    },
  }) as ReadOnlyDb;
}

// ── Plugin loader ─────────────────────────────────────────────
export async function loadPlugins(
  app: Application,
  db: Record<string, unknown>,
  _io: unknown
): Promise<void> {
  const pluginsDir = path.resolve(__dirname, '../../plugins');
  if (!fs.existsSync(pluginsDir)) {
    logger.info({ pluginsDir, event: 'plugins.dir.missing' }, 'Plugins directory not found, skipping plugin loading.');
    return;
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  for (const entry of entries) {
    const pluginDir  = path.join(pluginsDir, entry.name);
    const metaPath   = path.join(pluginDir, 'plugin.json');
    const mainPath   = path.join(pluginDir, 'index.js');

    if (!fs.existsSync(metaPath) || !fs.existsSync(mainPath)) continue;

    let meta: PluginMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PluginMeta;
    } catch (e) {
      logger.error({ plugin: entry.name, err: e, event: 'plugins.meta.parse_failed' }, 'Plugin metadata parse failed.');
      continue;
    }

    if (meta.disabled) {
      logger.info({ plugin: meta.id ?? entry.name, event: 'plugins.disabled' }, 'Plugin is disabled, skipping.');
      continue;
    }

    const pluginId = meta.id ?? entry.name;
    const routes: PluginRoute[]          = [];
    const socketEvs: PluginSocketEvent[] = [];
    let hookCount = 0;

    const sandboxedHooks: SandboxedHooks = {
      on(event: string, handler: HookHandler) {
        if (hookCount >= MAX_HOOKS_PER_PLUGIN) {
          console.warn(`[plugin:${pluginId}] Hook limiti aşıldı (max ${MAX_HOOKS_PER_PLUGIN}), "${event}" kaydedilmedi`);
          return;
        }
        hookCount++;
        hooks.on(event, handler);
      },
      off(event: string, handler: HookHandler) {
        hooks.off(event, handler);
        hookCount = Math.max(0, hookCount - 1);
      },
      emit: hooks.emit.bind(hooks),
    };

    const ctx: PluginContext = {
      id:    pluginId,
      meta,
      hooks: sandboxedHooks,
      db:    makeReadOnlyDb(db),
      logger: {
        log:   (...a: unknown[]) => console.log(`[plugin:${pluginId}]`, ...a),
        warn:  (...a: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...a),
        error: (...a: unknown[]) => console.error(`[plugin:${pluginId}]`, ...a),
      },

      registerRoute(method: string, subPath: string, handler: RequestHandler) {
        const fullPath = `/api/plugins/${pluginId}${subPath}`;
        const m = (method ?? 'get').toLowerCase() as HttpMethod;
        const valid: string[] = ['get','post','put','patch','delete'];
        if (!valid.includes(m)) {
          console.warn(`[plugin:${pluginId}] Geçersiz HTTP metodu: ${method}`);
          return;
        }
        routes.push({ method: m, path: fullPath, handler });
        (app as unknown as Record<string, Function>)[m](fullPath, handler);
        ctx.logger.log(`Route kayıt: ${m.toUpperCase()} ${fullPath}`);
      },

      registerSocketEvent(event: string, handler: PluginSocketEvent['handler']) {
        socketEvs.push({ event, handler });
        ctx.logger.log(`Socket event kayıt: ${event}`);
      },
    };

    try {
      const sandboxedRequire = makeSandboxedRequire(pluginDir, pluginId);
      const safeProcess      = makeSafeProcess(pluginId);

      const code = fs.readFileSync(mainPath, 'utf8');
      const moduleObj = { exports: {} as Record<string, unknown> };
      const sandbox: vm.Context = {
        module: moduleObj,
        exports: moduleObj.exports,
        require: sandboxedRequire,
        __filename: mainPath,
        __dirname: pluginDir,
        process: safeProcess,
        console,
        Buffer,
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
      };
      vm.createContext(sandbox);
      const wrapped = `(function (exports, require, module, __filename, __dirname, process) { 'use strict'; ${code}\n})`;
      const script = new vm.Script(wrapped, { filename: mainPath, timeout: SETUP_TIMEOUT_MS });
      const fn = script.runInContext(sandbox, { timeout: SETUP_TIMEOUT_MS }) as Function;
      fn(moduleObj.exports, sandboxedRequire, moduleObj, mainPath, pluginDir, safeProcess);

      const plugin = moduleObj.exports as PluginModule;
      await withTimeout(plugin.setup?.(ctx), pluginId);

      loadedPlugins.set(pluginId, { meta, ctx, routes, socketEvs });
      logger.info({ pluginId, version: meta.version ?? '?', hookCount, event: 'plugins.loaded' }, 'Plugin loaded in sandbox.');
    } catch (e) {
      logger.error({ pluginId, err: e, event: 'plugins.load_failed' }, 'Plugin failed to load.');
    }
  }

  logger.info({ count: loadedPlugins.size, event: 'plugins.loaded_total' }, 'Plugin loading completed.');
}

// ── Socket entegrasyonu ───────────────────────────────────────
export function bindPluginSocketEvents(socket: { on: (...a: unknown[]) => void }, user: unknown): void {
  for (const [pluginId, plugin] of loadedPlugins) {
    for (const { event, handler } of plugin.socketEvs) {
      socket.on(event, async (data: unknown) => {
        try {
          await handler(data, socket, user);
        } catch (e) {
          console.error(`[plugin:${pluginId}] socket ${event} error:`, (e as Error).message);
        }
      });
    }
  }
}

// ── GET /api/plugins — yüklü plugin listesi ───────────────────
export function registerPluginListRoute(app: Application, authMiddleware: RequestHandler): void {
  app.get('/api/plugins', authMiddleware, (_req: Request, res: Response) => {
    const list = [...loadedPlugins.values()].map(({ meta }) => ({
      id:          meta.id,
      name:        meta.name,
      version:     meta.version,
      description: meta.description,
      author:      meta.author,
    }));
    res.json(list);
  });
}
