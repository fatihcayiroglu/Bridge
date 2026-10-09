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
import { builtinModules } from 'module';
import type { IRouter, Request, Response, RequestHandler } from 'express';
import type { Server as IOServer } from 'socket.io';
import logger from '../lib/logger';
import { registerPluginActionHandlers } from './actions';
import { isAllowed } from './allowlist';
import type { PluginMeta as AllowlistPluginMeta } from './allowlist';
import {
  PLUGIN_DB_PERMISSIONS, PLUGIN_HOOK_PERMISSIONS, isPluginActionEvent,
  makePluginActionEnvelope,
} from './capabilities';

// ── Tipler ────────────────────────────────────────────────────

export interface PluginMeta {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  disabled?: boolean;
  permissions?: string[];
  config?: Record<string, unknown>;
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

export interface PluginSocketFacade {
  emit(event: string, payload?: unknown): void;
}

export interface PluginSocketUser {
  id: string;
  username?: string;
  displayName?: string;
}

export interface PluginSocketEvent {
  event: string;
  handler: (data: unknown, socket: PluginSocketFacade, user: Readonly<PluginSocketUser>) => void | Promise<void>;
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
  // Raw network clients are intentionally not exposed. Plugins that need an
  // outbound integration must go through a capability-owned Bridge action so
  // SSRF policy, destination allowlists and audit logging stay centralized.
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
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

function isPathWithin(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/').filter(Boolean);
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
}

interface PluginTimerApi {
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
}

function makeSandboxedRequire(pluginDir: string, pluginId: string, timerApi?: PluginTimerApi): NodeRequire {
  const pluginRoot = path.resolve(pluginDir);
  const pluginNodeModules = path.resolve(pluginRoot, 'node_modules');
  return function sandboxRequire(id: string): unknown {
    if (typeof id !== 'string' || !id || id.includes('\0')) {
      throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: geçersiz module specifier`);
    }
    if (path.isAbsolute(id)) {
      const resolved = path.resolve(id);
      if (isPathWithin(SERVER_ROOT, resolved)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: sunucu modülüne erişim engellendi: ${id}`);
      }
      // Absolute host paths are not plugin dependencies. Allowing them would let
      // an allowlisted plugin read/execute arbitrary deployment code by path.
      throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: absolute require engellendi: ${id}`);
    }
    if (id.startsWith('.')) {
      const resolved = path.resolve(pluginRoot, id);
      if (!isPathWithin(pluginRoot, resolved)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: path traversal engellendi: ${id}`);
      }
      // Host `require(resolved)` would execute the helper outside this vm
      // context with unrestricted Node capabilities. Until plugin modules have
      // a recursive VM-aware module loader, relative runtime imports are
      // therefore deny-by-default. Bundled plugins have no runtime relative
      // imports (their TypeScript-only context imports are erased at build).
      throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: relative runtime module engellendi: ${id}`);
    }

    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (NODE_BUILTINS.has(bareId)) {
      if (!ALLOWED_BUILTINS.has(bareId)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: built-in module engellendi: ${id}`);
      }
      // `timers` is a capability too: returning the host module would let a
      // failed/timed-out plugin escape the loader's timer ownership and keep
      // intervals alive indefinitely. Route it through the tracked sandbox API.
      if (bareId === 'timers' && timerApi) return Object.freeze({ ...timerApi });
      return require(id);
    }

    const pkgName = packageNameFromSpecifier(bareId);
    if (!pkgName || bareId.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: package path traversal engellendi: ${id}`);
    }
    if (BLOCKED_PACKAGES.has(pkgName)) {
      throw new Error(
        `[plugin:${pluginId}] Güvenlik ihlali: "${id}" direkt import edilemez — ctx.* API'sini kullan.`
      );
    }

    const pluginPkg = path.resolve(pluginNodeModules, pkgName);
    if (fs.existsSync(pluginPkg)) {
      const target = path.resolve(pluginNodeModules, bareId);
      if (!isPathWithin(pluginPkg, target)) {
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: package path traversal engellendi: ${id}`);
      }
      // A plugin-local package loaded with host require() would escape the VM
      // just like a relative helper. Do not create a cosmetic sandbox by
      // executing dependencies with full process/fs/child_process authority.
      throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: plugin package runtime import engellendi: ${id}`);
    }

    // Host application dependencies are capabilities too. Exposing arbitrary
    // packages here lets a plugin reach transitive fs/process/network powers
    // that the explicit builtin allowlist was intended to deny.
    throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: host package import engellendi: ${id}`);
  } as NodeRequire;
}

// ── Güvenli process proxy ─────────────────────────────────────
function makeSafeProcess(pluginId: string): typeof process {
  const pluginEnvPrefix = `BRIDGE_PLUGIN_${pluginId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
  const safeEnv: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  if (process.env.NODE_ENV !== undefined) safeEnv.NODE_ENV = process.env.NODE_ENV;
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(pluginEnvPrefix) && value !== undefined) safeEnv[key] = value;
  }
  Object.freeze(safeEnv);

  // Expose data, not the host Process object. A denylist is unsafe here because
  // new Node releases can add process-level mutation/escape APIs (for example
  // report.writeReport(), umask(), getBuiltinModule(), loadEnvFile(), IPC).
  // Keep this allowlist intentionally small and copy object-valued metadata so
  // plugins never receive mutable references owned by the host process.
  const safeValues: Readonly<Record<string, unknown>> = Object.freeze({
    env: safeEnv,
    version: process.version,
    versions: Object.freeze({ ...process.versions }),
    platform: process.platform,
    arch: process.arch,
    release: Object.freeze({ ...process.release }),
  });

  return new Proxy(Object.create(null) as typeof process, {
    get(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toStringTag) return 'process';
        throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: process symbol erişimi engellendi`);
      }
      if (Object.prototype.hasOwnProperty.call(safeValues, prop)) return safeValues[prop];
      throw new Error(`[plugin:${pluginId}] Güvenlik ihlali: process.${prop} erişimi engellendi`);
    },
    set(): boolean { throw new Error(`[plugin:${pluginId}] process nesnesine yazma engellendi`); },
    deleteProperty(): boolean { throw new Error(`[plugin:${pluginId}] process nesnesinden silme engellendi`); },
    defineProperty(): boolean { throw new Error(`[plugin:${pluginId}] process nesnesinde property tanımlama engellendi`); },
  });
}

// ── Plugin setup timeout wrapper ──────────────────────────────
const SETUP_TIMEOUT_MS = 5000;
async function withTimeout(promise: Promise<unknown> | undefined, _pluginId: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`setup() ${SETUP_TIMEOUT_MS}ms timeout aşıldı`)),
      SETUP_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise ?? Promise.resolve(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Plugin resource limits ───────────────────────────────────
const MAX_HOOKS_PER_PLUGIN = 50;
const MAX_ROUTES_PER_PLUGIN = 100;
const MAX_SOCKET_EVENTS_PER_PLUGIN = 100;
const MAX_TIMERS_PER_PLUGIN = 512;
const MAX_PLUGIN_ROUTE_SUBPATH_LENGTH = 200;

/**
 * Express route patterns are executable matching syntax, not plain paths. Keep
 * plugin-owned routes inside their literal namespace and allow only ordinary
 * path segments plus a whole-segment `:parameter`. This rejects traversal,
 * encoded-path ambiguity, wildcards and path-to-regexp metacharacters before a
 * plugin can hand them to the host application.
 */
function isSafePluginRouteSubPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2 || value.length > MAX_PLUGIN_ROUTE_SUBPATH_LENGTH) return false;
  if (!value.startsWith('/') || value.includes('\\') || value.includes('%') || value.includes('?') || value.includes('#') || value.includes('\0')) return false;
  return value.slice(1).split('/').every(segment =>
    (segment !== '.' && segment !== '..' && /^[A-Za-z0-9._~-]+$/.test(segment)) ||
    /^:[A-Za-z][A-Za-z0-9_]*$/.test(segment),
  );
}

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
  if (fs.existsSync(tsPath)) {
    try {
      // Development/test installs include TypeScript, so execute the canonical
      // source. Production images omit devDependencies and consume the JS
      // artifact generated from this file by scripts/build-plugins.js.
      require.resolve('typescript');
      return tsPath;
    } catch { /* production runtime: use generated JS below */ }
  }
  if (fs.existsSync(jsPath)) return jsPath;
  return null;
}

// ── Loaded plugins registry ───────────────────────────────────
const loadedPlugins = new Map<string, LoadedPlugin>();
// Express does not support removing a route from the public API once mounted.
// Track successful ownership per app so an accidental second loadPlugins() call
// is idempotent instead of duplicating HTTP routes/global hook subscriptions.
const loadedPluginIdsByApp = new WeakMap<object, Set<string>>();

// ── DB read-only proxy ────────────────────────────────────────
function makeReadOnlyDb(
  db: Record<string, unknown>,
  permissions: ReadonlySet<string>,
  pluginId: string,
): ReadOnlyDb {
  const empty: ReadOnlyCollection = { find: () => [], findOne: () => null, count: () => 0 };
  return new Proxy({} as ReadOnlyDb, {
    get(_target, prop: string | symbol): ReadOnlyCollection {
      const collectionName = String(prop);
      const required = PLUGIN_DB_PERMISSIONS[collectionName];
      if (!required || !permissions.has(required)) {
        logger.warn(
          { pluginId, collection: collectionName, requiredPermission: required ?? null, event: 'plugins.db.denied' },
          'Plugin read-only DB access denied by capability policy.',
        );
        return empty;
      }
      const col = db[collectionName] as Record<string, unknown> | undefined;
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
/**
 * Where the plugins (bundled and local) live at runtime:
 *   - repository checkout, ts-node (server/plugins/loader.ts)       → <repo>/plugins
 *   - repository checkout, compiled (server/dist/plugins/loader.js) → <repo>/plugins
 *   - Docker image, compiled (the Dockerfile copies <repo>/plugins to
 *     server/plugins next to server/dist)                            → server/plugins
 * The compiled build used to look only at server/plugins. In a checkout that
 * directory holds this loader's TypeScript sources and no plugin, so
 * `node server/dist/index.js` (process self-hosting, the E2E server) loaded zero
 * plugins without a warning while the Docker image loaded all three.
 * Only these fixed locations are considered; nothing above the repository is.
 */
export function resolvePluginsDir(fromDir: string = __dirname): { dir: string | null; candidates: string[] } {
  const compiled = path.basename(path.dirname(fromDir)) === 'dist';
  const candidates = compiled
    ? [path.resolve(fromDir, '../../plugins'), path.resolve(fromDir, '../../../plugins')]
    : [path.resolve(fromDir, '../../plugins')];
  return { dir: candidates.find(hasPluginManifest) ?? null, candidates };
}

function hasPluginManifest(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir, { withFileTypes: true })
      .some(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'plugin.json')));
  } catch {
    return false;
  }
}

export async function loadPlugins(
  app: IRouter,
  db: Record<string, unknown>,
  io: IOServer,
  authMiddleware: RequestHandler,
): Promise<void> {
  registerPluginActionHandlers(hooks, io);
  const { dir: pluginsDir, candidates } = resolvePluginsDir();
  if (!pluginsDir) {
    logger.info({ candidates, event: 'plugins.dir.missing' }, 'Plugins directory not found, skipping plugin loading.');
    return;
  }
  logger.info({ pluginsDir, event: 'plugins.dir' }, 'Loading plugins.');

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(e => e.isDirectory());
  const bundledPluginIds = new Set(['welcome-bot', 'word-filter', 'auto-role']);
  const isProduction = process.env.NODE_ENV === 'production';
  // Node's vm module is a containment/compatibility mechanism, not a security
  // boundary for hostile code once host callbacks are passed into the context.
  // Therefore arbitrary local executable plugins are never admitted in
  // production. The explicit opt-in remains available only for local dev/test.
  const allowUnsafeLocalPlugins = !isProduction && process.env.ALLOW_UNSAFE_LOCAL_PLUGINS === 'true';
  let loadedForApp = loadedPluginIdsByApp.get(app as unknown as object);
  if (!loadedForApp) {
    loadedForApp = new Set<string>();
    loadedPluginIdsByApp.set(app as unknown as object, loadedForApp);
  }

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

    const declaredPluginId = meta.id ?? entry.name;
    if (declaredPluginId !== entry.name) {
      logger.warn(
        { plugin: declaredPluginId, directory: entry.name, event: 'plugins.identity_mismatch' },
        'Plugin manifest id must exactly match its directory name.',
      );
      continue;
    }
    if (!bundledPluginIds.has(declaredPluginId) && !allowUnsafeLocalPlugins) {
      logger.warn(
        { plugin: declaredPluginId, production: isProduction, event: 'plugins.untrusted_local_rejected' },
        isProduction
          ? 'Non-bundled executable plugins are disabled in production.'
          : 'Non-bundled local plugins are disabled unless ALLOW_UNSAFE_LOCAL_PLUGINS=true.',
      );
      continue;
    }

    if (loadedForApp.has(declaredPluginId)) {
      logger.info(
        { pluginId: declaredPluginId, event: 'plugins.duplicate_load_skipped' },
        'Plugin already owns this application; duplicate load skipped.',
      );
      continue;
    }

    if (meta.disabled) {
      logger.info({ plugin: meta.id ?? entry.name, event: 'plugins.disabled' }, 'Plugin is disabled, skipping.');
      continue;
    }

    const pluginId = meta.id ?? entry.name;
    const permissionSet = new Set(Array.isArray(meta.permissions) ? meta.permissions.filter((p): p is string => typeof p === 'string') : []);
    const routes: PluginRoute[]          = [];
    const socketEvs: PluginSocketEvent[] = [];
    const ownedHooks: Array<{ event: string; handler: HookHandler }> = [];
    let hookCount = 0;
    let committed = false;
    let active = true;
    const pluginTimeouts = new Set<ReturnType<typeof setTimeout>>();
    const pluginIntervals = new Set<ReturnType<typeof setInterval>>();

    const timerCount = () => pluginTimeouts.size + pluginIntervals.size;
    const invokeTimerCallback = (callback: (...args: unknown[]) => unknown, args: unknown[]) => {
      if (!active) return;
      try {
        const result = callback(...args);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          Promise.resolve(result).catch(err => {
            logger.error({ pluginId, err, event: 'plugins.timer.callback_failed' }, 'Plugin timer callback failed.');
          });
        }
      } catch (err) {
        logger.error({ pluginId, err, event: 'plugins.timer.callback_failed' }, 'Plugin timer callback failed.');
      }
    };
    const assertTimerCapacity = () => {
      if (!active) throw new Error(`[plugin:${pluginId}] Plugin artık aktif değil; timer kaydı reddedildi`);
      if (timerCount() >= MAX_TIMERS_PER_PLUGIN) {
        throw new Error(`[plugin:${pluginId}] Timer limiti aşıldı (max ${MAX_TIMERS_PER_PLUGIN})`);
      }
    };
    const safeSetTimeout: typeof setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') throw new TypeError('setTimeout callback must be a function');
      assertTimerCapacity();
      const handle = setTimeout(() => {
        pluginTimeouts.delete(handle);
        invokeTimerCallback(callback, args);
      }, delay);
      pluginTimeouts.add(handle);
      return handle;
    }) as typeof setTimeout;
    const safeSetInterval: typeof setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') throw new TypeError('setInterval callback must be a function');
      assertTimerCapacity();
      const handle = setInterval(() => { invokeTimerCallback(callback, args); }, delay);
      pluginIntervals.add(handle);
      return handle;
    }) as typeof setInterval;
    const safeClearTimeout: typeof clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle !== undefined) pluginTimeouts.delete(handle);
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;
    const safeClearInterval: typeof clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
      if (handle !== undefined) pluginIntervals.delete(handle);
      clearInterval(handle as ReturnType<typeof setInterval>);
    }) as typeof clearInterval;
    const timerApi: PluginTimerApi = {
      setTimeout: safeSetTimeout, setInterval: safeSetInterval,
      clearTimeout: safeClearTimeout, clearInterval: safeClearInterval,
    };
    const clearPluginTimers = () => {
      for (const handle of pluginTimeouts) clearTimeout(handle);
      for (const handle of pluginIntervals) clearInterval(handle);
      pluginTimeouts.clear();
      pluginIntervals.clear();
    };

    // Plugin setup is transactional: hooks/routes/timers are staged/owned while setup()
    // executes and become globally visible only after setup resolves. A plugin
    // that throws or times out must not leave a half-loaded HTTP route or hook
    // behind. The same context remains usable after commit for legitimate
    // runtime hook registration/removal.
    const sandboxedHooks: SandboxedHooks = {
      on(event: string, handler: HookHandler) {
        if (!active) return;
        const ownNamespace = event.startsWith(`plugin:${pluginId}:`);
        const requiredPermission = PLUGIN_HOOK_PERMISSIONS[event];
        if (!ownNamespace && (!requiredPermission || !permissionSet.has(requiredPermission))) {
          logger.warn(
            { pluginId, hookEvent: event, requiredPermission: requiredPermission ?? null, event: 'plugins.hook.denied' },
            'Plugin hook subscription denied by capability policy.',
          );
          return;
        }
        if (hookCount >= MAX_HOOKS_PER_PLUGIN) {
          logger.warn(`[plugin:${pluginId}] Hook limiti aşıldı (max ${MAX_HOOKS_PER_PLUGIN}), "${event}" kaydedilmedi`);
          return;
        }
        hookCount++;
        ownedHooks.push({ event, handler });
        if (committed) hooks.on(event, handler);
      },
      off(event: string, handler: HookHandler) {
        if (!active) return;
        const idx = ownedHooks.findIndex(item => item.event === event && item.handler === handler);
        if (idx < 0) return;
        ownedHooks.splice(idx, 1);
        hookCount = Math.max(0, hookCount - 1);
        if (committed) hooks.off(event, handler);
      },
      async emit(event: string, payload?: unknown) {
        if (!active) return;
        if (!committed) {
          logger.warn(
            { pluginId, hookEvent: event, event: 'plugins.emit.before_commit' },
            'Plugin event emission is disabled until setup commits successfully.',
          );
          return;
        }
        if (isPluginActionEvent(event)) {
          await hooks.emit(event, makePluginActionEnvelope(pluginId, permissionSet, payload));
          return;
        }
        if (event.startsWith(`plugin:${pluginId}:`)) {
          await hooks.emit(event, payload);
          return;
        }
        logger.warn(
          { pluginId, hookEvent: event, event: 'plugins.emit.denied' },
          'Plugin event emission denied outside its namespace/action capability set.',
        );
      },
    };

    const ctx: PluginContext = {
      id:    pluginId,
      meta,
      hooks: sandboxedHooks,
      db:    makeReadOnlyDb(db, permissionSet, pluginId),
      logger: {
        log:   (...a: unknown[]) => logger.info({ args: a, pluginId, event: 'plugin.log' }, `[plugin:${pluginId}]`),
        warn:  (...a: unknown[]) => logger.warn({ args: a, pluginId, event: 'plugin.warn' }, `[plugin:${pluginId}]`),
        error: (...a: unknown[]) => logger.error({ args: a, pluginId, event: 'plugin.error' }, `[plugin:${pluginId}]`),
      },

      registerRoute(method: string, subPath: string, handler: RequestHandler) {
        if (!active) return;
        if (routes.length >= MAX_ROUTES_PER_PLUGIN) {
          logger.warn(`[plugin:${pluginId}] Route limiti aşıldı (max ${MAX_ROUTES_PER_PLUGIN})`);
          return;
        }
        if (!isSafePluginRouteSubPath(subPath)) {
          logger.warn(
            { pluginId, routePath: typeof subPath === 'string' ? subPath : null, event: 'plugins.route_path.denied' },
            'Plugin route must be a bounded literal subpath inside its own namespace.',
          );
          return;
        }
        const fullPath = `/api/plugins/${pluginId}${subPath}`;
        const m = (method ?? 'get').toLowerCase() as HttpMethod;
        const valid: string[] = ['get','post','put','patch','delete'];
        if (!valid.includes(m)) {
          logger.warn(`[plugin:${pluginId}] Geçersiz HTTP metodu: ${method}`);
          return;
        }
        if (typeof handler !== 'function') {
          logger.warn(`[plugin:${pluginId}] Geçersiz route handler: ${m.toUpperCase()} ${fullPath}`);
          return;
        }
        const route = { method: m, path: fullPath, handler };
        routes.push(route);
        if (committed) {
          const register = (app as unknown as Record<string, Function | undefined>)[m];
          if (typeof register !== 'function') {
            throw new Error(`[plugin] Desteklenmeyen HTTP metodu: ${m}`);
          }
          register.call(app, fullPath, authMiddleware, handler);
        }
        ctx.logger.log(`Route kayıt: ${m.toUpperCase()} ${fullPath}`);
      },

      registerSocketEvent(event: string, handler: PluginSocketEvent['handler']) {
        if (!active) return;
        if (socketEvs.length >= MAX_SOCKET_EVENTS_PER_PLUGIN) {
          logger.warn(`[plugin:${pluginId}] Socket event limiti aşıldı (max ${MAX_SOCKET_EVENTS_PER_PLUGIN})`);
          return;
        }
        const namespace = `plugin:${pluginId}:`;
        if (typeof event !== 'string' || event.length <= namespace.length || event.length > 160 || !event.startsWith(namespace)) {
          logger.warn(
            { pluginId, socketEvent: event, event: 'plugins.socket_event.denied' },
            'Plugin socket event must live inside its own namespace.',
          );
          return;
        }
        if (typeof handler !== 'function') {
          logger.warn({ pluginId, socketEvent: event, event: 'plugins.socket_handler.invalid' }, 'Invalid plugin socket handler.');
          return;
        }
        socketEvs.push({ event, handler });
        ctx.logger.log(`Socket event kayıt: ${event}`);
      },
    };

    try {
      const sandboxedRequire = makeSandboxedRequire(pluginDir, pluginId, timerApi);
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
      const sandbox: vm.Context & { __bridgePluginContext?: PluginContext } = {
        module: moduleObj,
        exports: moduleObj.exports,
        require: sandboxedRequire,
        __filename: mainPath,
        __dirname: pluginDir,
        process: safeProcess,
        console,
        Buffer,
        setTimeout: safeSetTimeout,
        setInterval: safeSetInterval,
        clearTimeout: safeClearTimeout,
        clearInterval: safeClearInterval,
      };
      vm.createContext(sandbox, {
        // Bundled plugins do not need eval/new Function/WebAssembly. Disabling
        // runtime code generation removes a common VM escape/amplification
        // primitive and makes the executed artifact auditable.
        codeGeneration: { strings: false, wasm: false },
      });
      // Execute the module invocation itself inside runInContext. Returning the
      // wrapper and calling it on the host side leaves top-level plugin code
      // outside vm's timeout, so a synchronous loop can stall startup forever.
      const wrapped = `(function (exports, require, module, __filename, __dirname, process) { 'use strict'; ${code}\n})(exports, require, module, __filename, __dirname, process);`;
      const script = new vm.Script(wrapped, { filename: mainPath });
      script.runInContext(sandbox, { timeout: SETUP_TIMEOUT_MS });

      // Invoke setup *inside* the context as well. Calling the contextified
      // function from the host side defeats runInContext's synchronous timeout:
      // a plugin with `while (true) {}` in setup() could otherwise stall startup
      // forever and Promise.race cannot pre-empt synchronous JavaScript.
      sandbox.__bridgePluginContext = ctx;
      let setupResult: unknown;
      try {
        const setupScript = new vm.Script(
          `typeof module.exports.setup === 'function'\n` +
          `  ? module.exports.setup(__bridgePluginContext)\n` +
          `  : undefined`,
          { filename: `${mainPath}:setup` },
        );
        setupResult = setupScript.runInContext(sandbox, { timeout: SETUP_TIMEOUT_MS });
      } finally {
        delete sandbox.__bridgePluginContext;
      }
      await withTimeout(Promise.resolve(setupResult), pluginId);

      // Commit staged side effects only after setup has completed successfully.
      // Route registration is deterministic and synchronous; hooks cannot throw.
      for (const route of routes) {
        const register = (app as unknown as Record<string, Function | undefined>)[route.method];
        if (typeof register !== 'function') {
          throw new Error(`[plugin] Desteklenmeyen HTTP metodu: ${route.method}`);
        }
        register.call(app, route.path, authMiddleware, route.handler);
      }
      for (const { event, handler } of ownedHooks) hooks.on(event, handler);
      committed = true;

      loadedPlugins.set(pluginId, { meta, ctx, routes, socketEvs });
      loadedForApp.add(pluginId);
      logger.info({ pluginId, version: meta.version ?? '?', hookCount, event: 'plugins.loaded' }, 'Plugin loaded with restricted runtime capabilities.');
    } catch (e) {
      active = false;
      clearPluginTimers();
      logger.error({ pluginId, err: e, event: 'plugins.load_failed' }, 'Plugin failed to load.');
    }
  }

  logger.info({ count: loadedPlugins.size, event: 'plugins.loaded_total' }, 'Plugin loading completed.');
}

// ── Socket entegrasyonu ───────────────────────────────────────
export function bindPluginSocketEvents(
  socket: { on: (event: string, handler: (data: unknown) => void | Promise<void>) => unknown; emit: (event: string, payload?: unknown) => unknown },
  user: PluginSocketUser,
): void {
  const safeUser = Object.freeze({
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username : undefined,
    displayName: typeof user.displayName === 'string' ? user.displayName : undefined,
  });

  for (const [pluginId, plugin] of loadedPlugins) {
    const namespace = `plugin:${pluginId}:`;
    const safeSocket: PluginSocketFacade = Object.freeze({
      emit(outEvent: string, payload?: unknown): void {
        if (typeof outEvent !== 'string' || !outEvent.startsWith(namespace) || outEvent.length <= namespace.length || outEvent.length > 160) {
          logger.warn(
            { pluginId, socketEvent: outEvent, event: 'plugins.socket_emit.denied' },
            'Plugin socket emit denied outside its own namespace.',
          );
          return;
        }
        socket.emit(outEvent, payload);
      },
    });

    for (const { event, handler } of plugin.socketEvs) {
      socket.on(event, async (data: unknown) => {
        try {
          await handler(data, safeSocket, safeUser);
        } catch (e) {
          logger.error(`[plugin:${pluginId}] socket ${event} error:`, (e as Error).message);
        }
      });
    }
  }
}

// ── GET /api/plugins — yüklü plugin listesi ───────────────────
export function registerPluginListRoute(app: IRouter, authMiddleware: RequestHandler): void {
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
