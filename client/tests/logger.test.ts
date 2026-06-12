// client/tests/logger.test.ts
// Sprint 77 — createLogger / clientLogger birim testleri

import { createLogger, logger } from '../js/core/logger';

describe('createLogger', () => {
  let spyLog: jest.SpyInstance;
  let spyWarn: jest.SpyInstance;
  let spyError: jest.SpyInstance;
  let spyInfo: jest.SpyInstance;

  beforeEach(() => {
    spyLog   = jest.spyOn(console, 'log').mockImplementation(() => {});
    spyWarn  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    spyError = jest.spyOn(console, 'error').mockImplementation(() => {});
    spyInfo  = jest.spyOn(console, 'info').mockImplementation(() => {});
    // Dev modda tüm loglar aktif
    (window as Window & { BRIDGE_ENV?: string; BRIDGE_DEBUG?: boolean }).BRIDGE_ENV = 'development';
    (window as Window & { BRIDGE_DEBUG?: boolean }).BRIDGE_DEBUG = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prefix ile logger oluşturur', () => {
    const log = createLogger('Test');
    log.log('merhaba');
    expect(spyLog).toHaveBeenCalledWith('[Test]', 'merhaba');
  });

  it('warn doğru prefix ile çıkış yapar', () => {
    const log = createLogger('WebRTC');
    log.warn('bağlantı kesildi');
    expect(spyWarn).toHaveBeenCalledWith('[WebRTC]', 'bağlantı kesildi');
  });

  it('error doğru prefix ile çıkış yapar', () => {
    const log = createLogger('SFU');
    log.error('hata', { detail: 1 });
    expect(spyError).toHaveBeenCalledWith('[SFU]', 'hata', { detail: 1 });
  });

  it('info doğru prefix ile çıkış yapar', () => {
    const log = createLogger('NS');
    log.info('hazır');
    expect(spyInfo).toHaveBeenCalledWith('[NS]', 'hazır');
  });

  it('debug çıkışı dev modda aktif (console.debug kullanır)', () => {
    const spyDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const log = createLogger('State');
    log.debug('debug mesajı');
    expect(spyDebug).toHaveBeenCalledWith('[State]', 'debug mesajı');
    // console.log çağrılmamalı — debug ayrı bir seviye
    expect(spyLog).not.toHaveBeenCalled();
    spyDebug.mockRestore();
  });
});

describe('createLogger — production modu', () => {
  let spyLog: jest.SpyInstance;
  let spyWarn: jest.SpyInstance;
  let spyError: jest.SpyInstance;

  beforeEach(() => {
    spyLog   = jest.spyOn(console, 'log').mockImplementation(() => {});
    spyWarn  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    spyError = jest.spyOn(console, 'error').mockImplementation(() => {});
    (window as Window & { BRIDGE_ENV?: string }).BRIDGE_ENV = 'production';
    (window as Window & { BRIDGE_DEBUG?: boolean }).BRIDGE_DEBUG = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('[production] log() sessizdir', () => {
    const log = createLogger('App');
    log.log('bu görünmemeli');
    expect(spyLog).not.toHaveBeenCalled();
  });

  it('[production] info() sessizdir', () => {
    const log = createLogger('App');
    log.info('bu görünmemeli');
    expect(spyLog).not.toHaveBeenCalled();
  });

  it('[production] debug() sessizdir', () => {
    const spyDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const log = createLogger('App');
    log.debug('bu görünmemeli');
    expect(spyDebug).not.toHaveBeenCalled();
    expect(spyLog).not.toHaveBeenCalled();
    spyDebug.mockRestore();
  });

  it('[production] warn() aktif kalır', () => {
    const log = createLogger('App');
    log.warn('bu görünmeli');
    expect(spyWarn).toHaveBeenCalledWith('[App]', 'bu görünmeli');
  });

  it('[production] error() aktif kalır', () => {
    const log = createLogger('App');
    log.error('kritik hata');
    expect(spyError).toHaveBeenCalledWith('[App]', 'kritik hata');
  });
});

describe('createLogger — BRIDGE_DEBUG override', () => {
  let spyLog: jest.SpyInstance;

  beforeEach(() => {
    spyLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    (window as Window & { BRIDGE_ENV?: string }).BRIDGE_ENV = 'production';
    (window as Window & { BRIDGE_DEBUG?: boolean }).BRIDGE_DEBUG = true;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('[production + BRIDGE_DEBUG] debug() aktif olur (console.debug)', () => {
    const spyDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const log = createLogger('Debug');
    log.debug('override ile görünmeli');
    expect(spyDebug).toHaveBeenCalledWith('[Debug]', 'override ile görünmeli');
    spyDebug.mockRestore();
  });

  it('[production + BRIDGE_DEBUG] log() aktif olur', () => {
    const log = createLogger('Debug');
    log.log('override ile görünmeli');
    expect(spyLog).toHaveBeenCalledWith('[Debug]', 'override ile görünmeli');
  });
});

describe('createLogger — Sentry entegrasyonu', () => {
  let spyError: jest.SpyInstance;
  let spyReport: jest.Mock;

  beforeEach(() => {
    spyError  = jest.spyOn(console, 'error').mockImplementation(() => {});
    spyReport = jest.fn();
    (window as Window & { errorBoundary?: { report: jest.Mock } }).errorBoundary = { report: spyReport };
    (window as Window & { BRIDGE_ENV?: string }).BRIDGE_ENV = 'development';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (window as Window & { errorBoundary?: unknown }).errorBoundary;
  });

  it('Error instance iletilince errorBoundary.report çağrılır', () => {
    const log = createLogger('E2EE');
    const err = new Error('şifreleme hatası');
    log.error(err);
    expect(spyReport).toHaveBeenCalledWith(err, 'E2EE');
  });

  it('string iletilince errorBoundary.report çağrılmaz', () => {
    const log = createLogger('E2EE');
    log.error('string hata mesajı');
    expect(spyReport).not.toHaveBeenCalled();
  });

  it('errorBoundary yoksa hata fırlatmaz', () => {
    delete (window as Window & { errorBoundary?: unknown }).errorBoundary;
    const log = createLogger('DM');
    expect(() => log.error(new Error('test'))).not.toThrow();
  });
});

describe('varsayılan logger export', () => {
  it('logger [Bridge] prefiksiyle çalışır', () => {
    const spyWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (window as Window & { BRIDGE_ENV?: string }).BRIDGE_ENV = 'development';
    logger.warn('test');
    expect(spyWarn).toHaveBeenCalledWith('[Bridge]', 'test');
    jest.restoreAllMocks();
  });
});
