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
import type { Server as IOServer } from 'socket.io';
import logger from '../lib/logger';
import { registerPluginActionHandlers } from './actions';
import { isAllowed } from './allowlist';
import type { PluginMeta as AllowlistPluginMeta } from './allowlist';

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
       
      return require(id);
    }
    if (id.startsWith('.')) {
      const resolved = path.resolve(pluginDir, id);
      if (!resolved.startsWith(pluginDir)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: path traversal engellendi: ${id}`);
      }
       
      return require(resolved);
    }
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (ALLOWED_BUILTINS.has(bareId)) {
       
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
       
      return require(path.join(pluginDir, 'node_modules', id));
    }
     
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
      const val = Reflect.get(target, prop);
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
        logger.error(`[plugin-hooks] ${event} handler error:`, (e as Error).message);
      }
    }
  }
}

// Singleton event bus — server index.ts'den de import edilebilir
export const hooks = new PluginHooks();

/** TypeScript plugin kaynağını CommonJS'e çevir (vm sandbox için). */
function transpilePluginTs(code: string, fileName: string): string | null {
  try {
     
    const ts = require('typescript') as typeof import('typescript');
    const out = ts.transpileModule(code, {
      compilerOptions: {
        module:          ts.ModuleKind.CommonJS,
        target:          ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        strict:          false,
      },
      fileName,
    });
    return out.outputText;
  } catch {
    return null;
  }
}

function resolvePluginMain(pluginDir: string): string | null {
  const jsPath = path.join(pluginDir, 'index.js');
  const tsPath = path.join(pluginDir, 'index.ts');
  if (fs.existsSync(jsPath)) return jsPath;
  if (fs.existsSync(tsPath)) return tsPath;
  return null;
}

// ── Loaded plugins registry ───────────────────────────────────
const loadedPlugins = new Map<string, LoadedPlugin>();

// ── DB read-only proxy ────────────────────────────────────────
function makeReadOnlyDb(db: Record<string, unknown>): ReadOnlyDb {
  const empty: ReadOnlyCollection = { find: () => [], findOne: () => null, count: () => 0 };
  return new Proxy({} as ReadOnlyDb, {
    get(_target, prop: string | symbol): ReadOnlyCollection {
      const col = db[prop as string] as Record<string, unknown> | undefined;
      if (!col || typeof col !== 'object') return empty;
      return {
        find:    (...a: unknown[]) => typeof col['find'] === 'function' ? (col['find'] as (...args: unknown[]) => unknown)(...a) : [],
        findOne: (...a: unknown[]) => typeof col['findOne'] === 'function' ? (col['findOne'] as (...args: unknown[]) => unknown)(...a) : null,
        count:   (...a: unknown[]) => typeof col['count'] === 'function' ? (col['count'] as (...args: unknown[]) => unknown)(...a) : 0,
      };
    },
  });
}

// ── Plugin loader ─────────────────────────────────────────────
export async function loadPlugins(
  app: Application,
  db: Record<string, unknown>,
  io: IOServer,
): Promise<void> {
  registerPluginActionHandlers(hooks, io);
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
    const mainPath   = resolvePluginMain(pluginDir);

    if (!fs.existsSync(metaPath) || !mainPath) continue;

    let meta: PluginMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PluginMeta;
    } catch (e) {
      logger.error({ plugin: entry.name, err: e, event: 'plugins.meta.parse_failed' }, 'Plugin metadata parse failed.');
      continue;
    }

    if (!isAllowed(meta as AllowlistPluginMeta)) {
      logger.warn({ plugin: meta.id ?? entry.name, event: 'plugins.allowlist_rejected' }, 'Plugin manifest rejected by allowlist.');
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
          logger.warn(`[plugin:${pluginId}] Hook limiti aşıldı (max ${MAX_HOOKS_PER_PLUGIN}), "${event}" kaydedilmedi`);
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
        log:   (...a: unknown[]) => logger.info({ args: a, pluginId, event: 'plugin.log' }, `[plugin:${pluginId}]`),
        warn:  (...a: unknown[]) => logger.warn({ args: a, pluginId, event: 'plugin.warn' }, `[plugin:${pluginId}]`),
        error: (...a: unknown[]) => logger.error({ args: a, pluginId, event: 'plugin.error' }, `[plugin:${pluginId}]`),
      },

      registerRoute(method: string, subPath: string, handler: RequestHandler) {
        const fullPath = `/api/plugins/${pluginId}${subPath}`;
        const m = (method ?? 'get').toLowerCase() as HttpMethod;
        const valid: string[] = ['get','post','put','patch','delete'];
        if (!valid.includes(m)) {
          logger.warn(`[plugin:${pluginId}] Geçersiz HTTP metodu: ${method}`);
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

      let code = fs.readFileSync(mainPath, 'utf8');
      if (mainPath.endsWith('.ts')) {
        const transpiled = transpilePluginTs(code, mainPath);
        if (!transpiled) {
          logger.error(
            { pluginId, event: 'plugins.ts_transpile_failed' },
            'TypeScript plugin yüklenemedi — index.js derleyin veya typescript paketini kurun.',
          );
          continue;
        }
        code = transpiled;
      }
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
      const script = new vm.Script(wrapped, { filename: mainPath });
      const fn = script.runInContext(sandbox, { timeout: SETUP_TIMEOUT_MS }) as Function;
      fn(moduleObj.exports, sandboxedRequire, moduleObj, mainPath, pluginDir, safeProcess);

      const plugin = moduleObj.exports as PluginModule;
      await withTimeout(Promise.resolve(plugin.setup?.(ctx)), pluginId);

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
          logger.error(`[plugin:${pluginId}] socket ${event} error:`, (e as Error).message);
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
