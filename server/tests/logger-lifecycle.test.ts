describe('logger process lifecycle', () => {
  it('does not grow process exit listeners across isolated Jest module registries', () => {
    const before = process.listenerCount('exit');

    for (let i = 0; i < 20; i += 1) {
      jest.isolateModules(() => {
        // Each call gets a fresh logger + Pino dependency graph, matching the
        // multi-node Redis and provider-isolation integration harnesses.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const logger = require('../lib/logger') as typeof import('../lib/logger');
        expect(logger.default).toBeDefined();
      });
    }

    expect(process.listenerCount('exit')).toBe(before);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
