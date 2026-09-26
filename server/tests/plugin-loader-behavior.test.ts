process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'must-not-reach-pluginxxxxxxxxxxx';
process.env.ALLOW_UNSAFE_LOCAL_PLUGINS = 'true';
process.env.BRIDGE_PLUGIN_ENVSAFE_PUBLIC_VALUE = 'plugin-visible';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockRegisterActions = jest.fn();
// `any` KALDIRILDI: yuk `unknown`tur ve okumadan once DARALTILIR.
const mockIsAllowed = jest.fn((...args: unknown[]) => {
  const meta = args[0];
  const id = typeof meta === 'object' && meta !== null ? (meta as { id?: unknown }).id : undefined;
  return id !== 'rejected';
});
let mockIncludeSyncLoop = false;
let mockIncludeSetupLoop = false;
let mockIncludeDynamic = false;
let mockIncludeTimerGuards = false;
let mockIncludeTimerThrow = false;
let mockPluginsDirExists = true;

const pluginFiles: Record<string, string> = {
  good: `
    module.exports.setup = async function(ctx) {
      ctx.registerRoute('GET', '/ping', function(_req, res) { res.json({ ok: true }); });
      ctx.registerRoute('TRACE', '/bad', function() {});
      ctx.registerSocketEvent('plugin:good:hello', async function(data, socket, user) { if ('join' in socket || 'handshake' in socket) throw new Error('full socket leaked'); socket.emit('plugin:good:echo', { data:data, user:user }); });
      ctx.registerSocketEvent('message:send', async function() { throw new Error('must not register'); });
      ctx.hooks.on('plugin:good:event', async function() {});
      ctx.hooks.on('plugin:good:trigger', async function() { await ctx.hooks.emit('plugin:sendMessage', { channelId:'c1', serverId:'s1', content:'hello' }); });
      ctx.hooks.on('message:deleted', async function() {});
      ctx.hooks.off('plugin:good:event', function nope() {});
      await ctx.hooks.emit('plugin:good:before-commit', {});
      ctx.db.channels.find({ active: true });
      ctx.db.channels.findOne({ active: true });
      ctx.db.channels.count({ active: true });
      ctx.db.users.find({ active: true });
      ctx.db.missing.find();
      ctx.db.missing.findOne();
      ctx.db.missing.count();
      ctx.logger.log('ready'); ctx.logger.warn('warn'); ctx.logger.error('err');
      require('path'); require('node:crypto');
      ctx.registerRoute('GET', '/invalid-handler', null);
      ctx.registerSocketEvent('plugin:good:invalid-handler', null);
    };
  `,
  blocked: `require('express'); module.exports.setup = function() {};`,
  traversal: `require('../secret'); module.exports.setup = function() {};`,
  prefixescape: `require('../prefixescape-evil/secret'); module.exports.setup = function() {};`,
  childproc: `require('node:child_process'); module.exports.setup = function() {};`,
  hostpkg: `require('uuid'); module.exports.setup = function() {};`,
  relativehelper: `require('./helper'); module.exports.setup = function() {};`,
  envsafe: `if (process.env.JWT_SECRET !== undefined) throw new Error('secret leaked'); if (process.env.BRIDGE_PLUGIN_ENVSAFE_PUBLIC_VALUE !== 'plugin-visible') throw new Error('own env missing'); module.exports.setup = function(ctx) { ctx.logger.log(process.env.NODE_ENV); };`,
  processmodule: `process.getBuiltinModule('child_process'); module.exports.setup = function() {};`,
  processreport: `void process.report; module.exports.setup = function() {};`,
  networkbuiltin: `require('node:http'); module.exports.setup = function() {};`,
  proc: `process.exit(1); module.exports.setup = function() {};`,
  hooks: `module.exports.setup = function(ctx) { for (let i=0;i<55;i++) ctx.hooks.on('plugin:hooks:evt'+i, function(){}); };`,
  socketfail: `module.exports.setup = function(ctx) { ctx.registerSocketEvent('plugin:socketfail:explode', async function(_data, socket){ socket.emit('message:new', { forged:true }); throw new Error('plugin boom'); }); };`,
  plain: `module.exports = {};`,
  partialfail: `module.exports.setup = function(ctx) { ctx.registerRoute('GET', '/ghost', function(_req,res){ res.json({ ghost:true }); }); ctx.hooks.on('plugin:partialfail:event', function(){ ctx.logger.log('PARTIAL_HOOK_FIRED'); }); setTimeout(function(){ ctx.hooks.emit('plugin:partialfail:late', { leaked:true }); ctx.registerSocketEvent('late:event', async function(){}); }, 0); throw new Error('setup failed after staging'); };`,
  timerfail: `module.exports.setup = function(ctx) { const timers = require('timers'); setInterval(function(){ ctx.logger.log('GLOBAL_TIMER_LEAK'); }, 1); timers.setInterval(function(){ ctx.logger.log('REQUIRED_TIMER_LEAK'); }, 1); throw new Error('timer setup failed'); };`,
  caps: `module.exports.setup = function(ctx) { for (let i=0;i<105;i++) ctx.registerRoute('GET','/r'+i,function(){}); for (let i=0;i<105;i++) ctx.registerSocketEvent('plugin:caps:e'+i,async function(){}); };`,
  timerthrow: `module.exports.setup = function() { setTimeout(function(){ throw new Error('timer sync boom'); }, 0); setTimeout(async function(){ throw new Error('timer async boom'); }, 0); };`,
  syncloop: `const until = Date.now() + 5100; while (Date.now() < until) {} module.exports.setup = function() {};`,
  setuploop: `module.exports.setup = function() { const until = Date.now() + 5100; while (Date.now() < until) {} };`,
  codegen: `module.exports.setup = function() { return eval('40 + 2'); };`,
  processguards: `
    module.exports.setup = function(ctx) {
      if (Object.prototype.toString.call(process) !== '[object process]') throw new Error('safe process tag missing');
      const attacks = [
        function(){ process.env = {}; },
        function(){ delete process.version; },
        function(){ Object.defineProperty(process, 'escape', { value: true }); },
        function(){ return process[Symbol.iterator]; }
      ];
      for (const attack of attacks) {
        let denied = false;
        try { attack(); } catch (err) { denied = true; ctx.logger.log(String(err.message)); }
        if (!denied) throw new Error('process mutation/symbol access escaped');
      }
    };
  `,
  requireguards: `
    const safePath = require('path');
    module.exports.setup = function(ctx) {
      const ids = [
        null,
        safePath.resolve(__dirname, '../../server/index'),
        safePath.resolve(__dirname, '../../../outside-host-file'),
        '@scope/pkg',
        'left-pad/deep',
        'left-pad/../secret'
      ];
      for (const id of ids) {
        let denied = false;
        try { require(id); } catch (err) { denied = true; ctx.logger.log(String(err.message)); }
        if (!denied) throw new Error('module capability escaped: ' + String(id));
      }
    };
  `,
  routeescape: `module.exports.setup = function(ctx) {
    ctx.registerRoute('GET', '/ok/:itemId', function(_req,res){ res.json({ok:true}); });
    for (const p of ['../admin','/../admin','/%2e%2e/admin','//admin','/wild*','/query?x=1','/back\\\\slash']) {
      ctx.registerRoute('GET', p, function(){});
    }
  };`,
  dynamic: `module.exports.setup = function(ctx) {
    const cancelled = setTimeout(function(){ ctx.logger.error('cancelled timeout ran'); }, 1000);
    clearTimeout(cancelled);
    const cancelledInterval = setInterval(function(){ ctx.logger.error('cancelled interval ran'); }, 1000);
    clearInterval(cancelledInterval);
    setTimeout(function(){
      const handler = function(){ ctx.logger.log('DYNAMIC_HOOK_FIRED'); };
      ctx.hooks.on('plugin:dynamic:runtime', handler);
      ctx.hooks.emit('plugin:dynamic:runtime', {});
      ctx.hooks.off('plugin:dynamic:runtime', handler);
      ctx.hooks.emit('foreign:event', {});
      ctx.registerRoute('POST', '/late', function(_req,res){ res.json({late:true}); });
    }, 0);
  };`,
  timerguards: `module.exports.setup = function(ctx) {
    for (const fn of [function(){ setTimeout(null, 0); }, function(){ setInterval(null, 0); }]) {
      try { fn(); } catch (err) { ctx.logger.log(String(err.message)); }
    }
    clearTimeout(); clearInterval();
    const handles = [];
    for (let i = 0; i < 512; i++) handles.push(setInterval(function(){}, 10000));
    let bounded = false;
    try { setTimeout(function(){}, 0); } catch (err) { bounded = true; ctx.logger.log(String(err.message)); }
    for (const handle of handles) clearInterval(handle);
    if (!bounded) throw new Error('timer capacity escaped');
  };`,
  tsplugin: `export async function setup(ctx: any) { ctx.registerRoute('GET', '/typescript', function(_req: any, res: any) { res.json({ ts: true }); }); }`,
};

const metas: Record<string, any> = {
  good: { id: 'good', name: 'Good', version: '1.2.3', description: 'ok', author: 'me', permissions: ['channels:read','messages:send'] },
  blocked: { id: 'blocked' }, traversal: { id: 'traversal' }, prefixescape: { id: 'prefixescape' }, childproc: { id: 'childproc' }, envsafe: { id: 'envsafe' }, processmodule: { id: 'processmodule' }, processreport: { id: 'processreport' }, networkbuiltin: { id: 'networkbuiltin' }, proc: { id: 'proc' }, hooks: { id: 'hooks' },
  socketfail: { id: 'socketfail' }, plain: { id: 'plain' }, partialfail: { id: 'partialfail' }, timerfail: { id: 'timerfail' }, caps: { id: 'caps' }, timerthrow: { id: 'timerthrow' },
  syncloop: { id: 'syncloop' },
  setuploop: { id: 'setuploop' }, codegen: { id: 'codegen' }, processguards: { id: 'processguards' },
  requireguards: { id: 'requireguards' }, routeescape: { id: 'routeescape' }, dynamic: { id: 'dynamic' },
  timerguards: { id: 'timerguards' }, tsplugin: { id: 'tsplugin' },
  hostpkg: { id: 'hostpkg' }, relativehelper: { id: 'relativehelper' }, spoof: { id: 'welcome-bot', name: 'Spoof', version: '1.0.0' },
  rejected: { id: 'rejected' }, disabled: { id: 'disabled', disabled: true },
};

jest.mock('../lib/logger', () => mockLogger);
jest.mock('../plugins/actions', () => ({ registerPluginActionHandlers: (...a: any[]) => mockRegisterActions(...a) }));
jest.mock('../plugins/allowlist', () => ({ isAllowed: (...a: unknown[]) => mockIsAllowed(...a) }));

jest.mock('fs', () => {
  const path = require('path');
    const baseDirs = ['good','blocked','traversal','prefixescape','childproc','hostpkg','relativehelper','spoof','envsafe','processmodule','processreport','networkbuiltin','proc','hooks','socketfail','plain','partialfail','timerfail','caps','codegen','processguards','requireguards','routeescape','rejected','disabled','invalidmeta','nometa','nomain'];
  return {
    existsSync: (p: string) => {
      const s=String(p);
      if (s.endsWith('/plugins') || s.endsWith('\\plugins')) return mockPluginsDirExists;
      const base=path.basename(path.dirname(s)); const file=path.basename(s);
      if (file === 'plugin.json') return base !== 'nometa';
      if (file === 'index.js') return base !== 'nomain';
      if (file === 'index.ts') return false;
      if (s.includes('requireguards') && s.includes('node_modules') && s.endsWith(`${path.sep}left-pad`)) return true;
      if (s.includes('node_modules')) return false;
      return false;
    },
    readdirSync: (_p: string, opts?: any) => {
      const dirs = [...baseDirs];
      if (mockIncludeSyncLoop) dirs.push('syncloop');
      if (mockIncludeSetupLoop) dirs.push('setuploop');
      if (mockIncludeDynamic) dirs.push('dynamic');
      if (mockIncludeTimerGuards) dirs.push('timerguards');
      if (mockIncludeTimerThrow) dirs.push('timerthrow');
      return opts?.withFileTypes
        ? [...dirs.map((name: string) => ({ name, isDirectory: () => true })), { name: 'README.txt', isDirectory: () => false }]
        : dirs;
    },
    readFileSync: (p: string, _enc?: string) => {
      const s=String(p); const base=path.basename(path.dirname(s)); const file=path.basename(s);
      if (file === 'plugin.json') {
        if (base === 'invalidmeta') return '{broken';
        return JSON.stringify(metas[base] ?? { id: base });
      }
      if (file === 'index.js' || file === 'index.ts') return pluginFiles[base] ?? 'module.exports = {}';
      throw new Error('unexpected read '+s);
    },
  };
});

import { loadPlugins, bindPluginSocketEvents, registerPluginListRoute, hooks } from '../plugins/loader';

function makeApp() {
  const routes: Record<string, { path: string; handlers: Function[] }[]> = { get:[],post:[],put:[],patch:[],delete:[] };
  const app: any = {};
  for (const m of Object.keys(routes)) app[m]=jest.fn((path: string,...handlers: Function[])=>{routes[m].push({path,handlers});});
  return { app, routes };
}

const testAuth = jest.fn((_req:any,_res:any,next:any)=>next());

beforeEach(()=>{
  jest.clearAllMocks();
  mockIncludeSyncLoop = false;
  mockIncludeSetupLoop = false;
  mockIncludeDynamic = false;
  mockIncludeTimerGuards = false;
  mockIncludeTimerThrow = false;
  mockPluginsDirExists = true;
  mockIsAllowed.mockImplementation((meta: any)=>meta?.id!=='rejected');
});

describe('server plugin sandbox loader',()=>{
  test('missing plugin directory is an observable no-op',async()=>{
    mockPluginsDirExists = false;
    const {app,routes}=makeApp();
    await loadPlugins(app,{},{} as any,testAuth as any);
    expect(Object.values(routes).flat()).toHaveLength(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({event:'plugins.dir.missing'}),
      expect.any(String),
    );
  });

  test('production rejects non-bundled executable plugins even when unsafe local opt-in is set',async()=>{
    const previousNodeEnv = process.env.NODE_ENV;
    const previousUnsafe = process.env.ALLOW_UNSAFE_LOCAL_PLUGINS;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_UNSAFE_LOCAL_PLUGINS = 'true';
    try {
      const {app,routes}=makeApp();
      await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
      expect(Object.values(routes).flat()).toHaveLength(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ plugin:'good', production:true, event:'plugins.untrusted_local_rejected' }),
        expect.stringMatching(/disabled in production/i),
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousUnsafe === undefined) delete process.env.ALLOW_UNSAFE_LOCAL_PLUGINS;
      else process.env.ALLOW_UNSAFE_LOCAL_PLUGINS = previousUnsafe;
    }
  });

  test('non-bundled local plugins are disabled unless the explicit unsafe opt-in is enabled',async()=>{
    const previous = process.env.ALLOW_UNSAFE_LOCAL_PLUGINS;
    delete process.env.ALLOW_UNSAFE_LOCAL_PLUGINS;
    try {
      const {app,routes}=makeApp();
      await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
      expect(Object.values(routes).flat()).toHaveLength(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ plugin:'good', event:'plugins.untrusted_local_rejected' }),
        expect.any(String),
      );
    } finally {
      if (previous === undefined) delete process.env.ALLOW_UNSAFE_LOCAL_PLUGINS;
      else process.env.ALLOW_UNSAFE_LOCAL_PLUGINS = previous;
    }
  });

  test('loads allowed plugins, skips malformed/rejected/disabled/missing entries, and registers actions once',async()=>{
    const {app,routes}=makeApp(); const io:any={};
    const db:any={ channels:{ find:jest.fn(()=>[{id:1}]), findOne:jest.fn(()=>null), count:jest.fn(()=>1) } };
    await loadPlugins(app,db,io,testAuth as any);
    expect(mockRegisterActions).toHaveBeenCalledWith(hooks,io);
    expect(routes.get.some(r=>r.path==='/api/plugins/good/ping')).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({plugin:'invalidmeta',event:'plugins.meta.parse_failed'}),expect.any(String));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({plugin:'rejected',event:'plugins.allowlist_rejected'}),expect.any(String));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({plugin:'disabled',event:'plugins.disabled'}),expect.any(String));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({pluginId:'blocked',event:'plugins.load_failed'}),expect.any(String));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({pluginId:'traversal',event:'plugins.load_failed'}),expect.any(String));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({pluginId:'prefixescape',event:'plugins.load_failed'}),expect.any(String));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({pluginId:'childproc',event:'plugins.load_failed'}),expect.any(String));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({pluginId:'hostpkg',event:'plugins.load_failed'}),expect.any(String));
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({pluginId:'relativehelper',event:'plugins.load_failed'}),expect.any(String));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin:'welcome-bot', directory:'spoof', event:'plugins.identity_mismatch' }),
      expect.any(String),
    );
    const prefixErr = mockLogger.error.mock.calls.find(([meta]: any[]) => meta?.pluginId === 'prefixescape')?.[0]?.err;
    const childProcErr = mockLogger.error.mock.calls.find(([meta]: any[]) => meta?.pluginId === 'childproc')?.[0]?.err;
    const hostPkgErr = mockLogger.error.mock.calls.find(([meta]: any[]) => meta?.pluginId === 'hostpkg')?.[0]?.err;
    const relativeErr = mockLogger.error.mock.calls.find(([meta]: any[]) => meta?.pluginId === 'relativehelper')?.[0]?.err;
    expect(String(prefixErr?.message)).toMatch(/path traversal/i);
    expect(String(childProcErr?.message)).toMatch(/built-in module engellendi/i);
    expect(String(hostPkgErr?.message)).toMatch(/host package import engellendi/i);
    expect(String(relativeErr?.message)).toMatch(/relative runtime module engellendi/i);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'envsafe', event: 'plugin.log' }), expect.any(String));
    const processModuleErr = mockLogger.error.mock.calls.find(([meta]: any[]) => meta?.pluginId === 'processmodule')?.[0]?.err;
    expect(String(processModuleErr?.message)).toMatch(/process\.getBuiltinModule.*engellendi/i);
    const processReportErr = mockLogger.error.mock.calls.find(([meta]: any[]) => meta?.pluginId === 'processreport')?.[0]?.err;
    expect(String(processReportErr?.message)).toMatch(/process\.report.*engellendi/i);
    const networkBuiltinErr = mockLogger.error.mock.calls.find(([meta]: any[]) => meta?.pluginId === 'networkbuiltin')?.[0]?.err;
    expect(String(networkBuiltinErr?.message)).toMatch(/built-in module engellendi/i);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({pluginId:'proc',event:'plugins.load_failed'}),expect.any(String));
    expect(db.channels.find).toHaveBeenCalledWith({active:true});
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId:'good', collection:'users', event:'plugins.db.denied' }),
      expect.any(String),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId:'good', hookEvent:'message:deleted', event:'plugins.hook.denied' }),
      expect.any(String),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Hook limiti aşıldı'));
  });

  test('failed setup leaves no staged HTTP route or global hook behind',async()=>{
    const {app,routes}=makeApp();
    await loadPlugins(app,{users:{find:()=>[]}},{} as any,testAuth as any);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'partialfail',event:'plugins.load_failed'}),
      expect.any(String),
    );
    expect(Object.values(routes).flat().some((r:any)=>r.path==='/api/plugins/partialfail/ghost')).toBe(false);
    mockLogger.info.mockClear();
    const late = jest.fn();
    hooks.on('plugin:partialfail:late', late);
    await hooks.emit('plugin:partialfail:event',{});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(late).not.toHaveBeenCalled();
    hooks.off('plugin:partialfail:late', late);
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'partialfail'}),
      expect.stringContaining('PARTIAL_HOOK_FIRED'),
    );
  });

  test('failed setup clears sandbox-global and require("timers") intervals',async()=>{
    const {app}=makeApp();
    await loadPlugins(app,{users:{find:()=>[]}},{} as any,testAuth as any);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'timerfail',event:'plugins.load_failed'}),
      expect.any(String),
    );
    mockLogger.info.mockClear();
    await new Promise(resolve => setTimeout(resolve, 15));
    const loggedArgs = mockLogger.info.mock.calls.flatMap((call:any[]) => Array.isArray(call[0]?.args) ? call[0].args : []);
    expect(loggedArgs).not.toContain('GLOBAL_TIMER_LEAK');
    expect(loggedArgs).not.toContain('REQUIRED_TIMER_LEAK');
  });

  test('top-level synchronous plugin code is contained by the VM execution deadline',async()=>{
    mockIncludeSyncLoop = true;
    const {app}=makeApp();
    const started = Date.now();
    await loadPlugins(app,{users:{find:()=>[]}},{} as any,testAuth as any);
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(Date.now() - started).toBeLessThan(6_500);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'syncloop',event:'plugins.load_failed'}),
      expect.any(String),
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'syncloop',event:'plugins.loaded'}),
      expect.any(String),
    );
  }, 15_000);

  test('synchronous setup code is also contained by the VM execution deadline',async()=>{
    mockIncludeSetupLoop = true;
    const {app}=makeApp();
    const started = Date.now();
    await loadPlugins(app,{users:{find:()=>[]}},{} as any,testAuth as any);
    expect(Date.now() - started).toBeLessThan(6_500);
    const failure = mockLogger.error.mock.calls.find(([meta]:any[]) => meta?.pluginId === 'setuploop' && meta?.event === 'plugins.load_failed');
    expect(String(failure?.[0]?.err?.message)).toMatch(/timed out/i);
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'setuploop',event:'plugins.loaded'}),
      expect.any(String),
    );
  }, 15_000);

  test('sandbox denies runtime code generation, host paths, local packages and process mutation surfaces',async()=>{
    const {app}=makeApp();
    await loadPlugins(app,{channels:{}},{} as any,testAuth as any);

    const codegenFailure = mockLogger.error.mock.calls.find(([meta]:any[]) => meta?.pluginId === 'codegen' && meta?.event === 'plugins.load_failed');
    expect(String(codegenFailure?.[0]?.err?.message)).toMatch(/code generation|strings disallowed/i);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'processguards',event:'plugins.loaded'}), expect.any(String),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'requireguards',event:'plugins.loaded'}), expect.any(String),
    );

    const guardMessages = mockLogger.info.mock.calls
      .filter(([meta]:any[]) => ['processguards','requireguards'].includes(meta?.pluginId))
      .flatMap(([meta]:any[]) => meta.args ?? [])
      .map(String).join('\n');
    expect(guardMessages).toMatch(/absolute require engellendi/i);
    expect(guardMessages).toMatch(/sunucu modülüne erişim engellendi/i);
    expect(guardMessages).toMatch(/plugin package runtime import engellendi/i);
    expect(guardMessages).toMatch(/package path traversal engellendi/i);
    expect(guardMessages).toMatch(/process nesnesine yazma engellendi/i);
    expect(guardMessages).toMatch(/process symbol erişimi engellendi/i);
  });

  test('plugin route paths remain literal and inside the plugin namespace',async()=>{
    const {app,routes}=makeApp();
    await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
    expect(routes.get.filter(r=>r.path.startsWith('/api/plugins/routeescape/')).map(r=>r.path))
      .toEqual(['/api/plugins/routeescape/ok/:itemId']);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'routeescape',event:'plugins.route_path.denied'}),
      expect.any(String),
    );
  });

  test('post-commit hooks, routes and owned timers remain functional and bounded',async()=>{
    mockIncludeDynamic = true;
    mockIncludeTimerGuards = true;
    const {app,routes}=makeApp();
    await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(routes.post.some(r=>r.path==='/api/plugins/dynamic/late')).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'dynamic',args:['DYNAMIC_HOOK_FIRED']}), expect.any(String),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'dynamic',hookEvent:'foreign:event',event:'plugins.emit.denied'}),
      expect.any(String),
    );
    const timerLogs = mockLogger.info.mock.calls
      .filter(([meta]:any[]) => meta?.pluginId === 'timerguards')
      .flatMap(([meta]:any[]) => meta.args ?? []).map(String).join('\n');
    expect(timerLogs).toMatch(/callback must be a function/i);
    expect(timerLogs).toMatch(/Timer limiti aşıldı/i);
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'timerguards',event:'plugins.load_failed'}), expect.any(String),
    );
  });

  test('plugin timer callback failures are isolated instead of escaping the process',async()=>{
    mockIncludeTimerThrow = true;
    const {app}=makeApp();
    await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
    await new Promise(resolve => setTimeout(resolve, 15));
    const timerErrors = mockLogger.error.mock.calls.filter(([meta]:any[]) => meta?.pluginId === 'timerthrow' && meta?.event === 'plugins.timer.callback_failed');
    expect(timerErrors).toHaveLength(2);
    expect(timerErrors.map(([meta]:any[]) => String(meta.err?.message)).sort()).toEqual(['timer async boom','timer sync boom']);
  });

  test('plugin route and socket-event registration is bounded',async()=>{
    const {app,routes}=makeApp();
    await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
    expect(routes.get.filter(r=>r.path.startsWith('/api/plugins/caps/'))).toHaveLength(100);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Route limiti aşıldı'));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Socket event limiti aşıldı'));
  });

  test('committed plugin actions carry immutable loader-owned origin/capabilities',async()=>{
    const actionPayloads:any[]=[];
    const capture=(payload:any)=>{actionPayloads.push(payload);};
    hooks.on('plugin:sendMessage',capture);
    const {app}=makeApp();
    await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
    await hooks.emit('plugin:good:trigger',{});
    hooks.off('plugin:sendMessage',capture);
    expect(actionPayloads).toContainEqual(expect.objectContaining({
      __bridgePluginAction:true,
      pluginId:'good',
      permissions:expect.arrayContaining(['messages:send','channels:read']),
      payload:{channelId:'c1',serverId:'s1',content:'hello'},
    }));
  });

  test('re-loading the same application does not duplicate committed plugin routes',async()=>{
    const {app,routes}=makeApp();
    await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
    const firstCount=routes.get.filter(r=>r.path==='/api/plugins/good/ping').length;
    expect(firstCount).toBe(1);

    await loadPlugins(app,{channels:{find:()=>[]}},{} as any,testAuth as any);
    expect(routes.get.filter(r=>r.path==='/api/plugins/good/ping')).toHaveLength(firstCount);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'good',event:'plugins.duplicate_load_skipped'}),
      expect.any(String),
    );
  });

  test('registered route works and invalid HTTP method is not mounted',async()=>{
    const {app,routes}=makeApp();
    await loadPlugins(app,{users:{find:()=>[]}},{} as any,testAuth as any);
    const route=routes.get.find(r=>r.path==='/api/plugins/good/ping')!;
    expect(route.handlers[0]).toBe(testAuth);
    const res={json:jest.fn()}; route.handlers.at(-1)!({},res);
    expect(res.json).toHaveBeenCalledWith({ok:true});
    expect(Object.values(routes).flat().some((r:any)=>r.path==='/api/plugins/good/bad')).toBe(false);
  });

  test('bindPluginSocketEvents invokes plugin handler and isolates plugin exceptions',async()=>{
    const {app}=makeApp(); await loadPlugins(app,{users:{find:()=>[]}},{} as any,testAuth as any);
    const handlers=new Map<string,Function>();
    const socket:any={on:jest.fn((event:string,fn:Function)=>handlers.set(event,fn)),emit:jest.fn()};
    bindPluginSocketEvents(socket,{id:'u1'});
    expect(handlers.has('plugin:good:hello')).toBe(true);
    expect(handlers.has('plugin:socketfail:explode')).toBe(true);
    expect(handlers.has('message:send')).toBe(false);
    await handlers.get('plugin:good:hello')!({x:1});
    expect(socket.emit).toHaveBeenCalledWith('plugin:good:echo',{data:{x:1},user:{id:'u1',username:undefined,displayName:undefined}});
    await expect(handlers.get('plugin:socketfail:explode')!({})).resolves.toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalledWith('message:new',expect.anything());
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({pluginId:'socketfail',socketEvent:'message:new',event:'plugins.socket_emit.denied'}),
      expect.any(String),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('[plugin:socketfail] socket plugin:socketfail:explode error:'),'plugin boom');
  });

  test('plugin list route exposes metadata only',async()=>{
    const {app,routes}=makeApp(); await loadPlugins(app,{users:{find:()=>[]}},{} as any,testAuth as any);
    const auth=jest.fn((_q:any,_s:any,n:any)=>n());
    registerPluginListRoute(app,auth as any);
    const r=routes.get.find(x=>x.path==='/api/plugins')!;
    const res={json:jest.fn()}; r.handlers.at(-1)!({},res);
    const list=res.json.mock.calls[0][0];
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({id:'good',name:'Good',version:'1.2.3'})]));
    expect(JSON.stringify(list)).not.toContain('ctx');
  });

  test('global hooks support on/off and isolate throwing handlers',async()=>{
    const good=jest.fn(); const bad=jest.fn(()=>{throw new Error('hook boom');});
    hooks.on('unit:event',bad); hooks.on('unit:event',good);
    await hooks.emit('unit:event',{a:1});
    expect(good).toHaveBeenCalledWith({a:1});
    expect(mockLogger.error).toHaveBeenCalledWith('[plugin-hooks] unit:event handler error:','hook boom');
    hooks.off('unit:event',bad); hooks.off('unit:event',good);
    await expect(hooks.emit('missing:event',{})).resolves.toBeUndefined();
  });
});
