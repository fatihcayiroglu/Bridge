describe('runtime version owner', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; jest.resetModules(); });

  test('reads the packaged Bridge version without npm lifecycle environment', () => {
    delete process.env.BRIDGE_VERSION;
    delete process.env.npm_package_version;
    jest.resetModules();
    const { BRIDGE_VERSION } = require('../lib/version') as typeof import('../lib/version');
    expect(BRIDGE_VERSION).toBe('1.125.0');
  });

  test('explicit BRIDGE_VERSION remains an operator build override', () => {
    process.env.BRIDGE_VERSION = '1.125.0+build.7';
    jest.resetModules();
    const { BRIDGE_VERSION } = require('../lib/version') as typeof import('../lib/version');
    expect(BRIDGE_VERSION).toBe('1.125.0+build.7');
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
