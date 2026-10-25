import { NativeStartupStage, nativeStartupTraceEnabled, traceNativeStartupStage } from '../nativeStartupTrace';

const originalFlag = process.env.BRIDGE_NATIVE_STARTUP_TRACE;
afterEach(() => {
  if (originalFlag === undefined) delete process.env.BRIDGE_NATIVE_STARTUP_TRACE;
  else process.env.BRIDGE_NATIVE_STARTUP_TRACE = originalFlag;
  jest.restoreAllMocks();
});

it('requires exact opt-in and does not publish private flag contents', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  for (const flag of [undefined, '0', 'true', 'private-token']) {
    if (flag === undefined) delete process.env.BRIDGE_NATIVE_STARTUP_TRACE;
    else process.env.BRIDGE_NATIVE_STARTUP_TRACE = flag;
    expect(nativeStartupTraceEnabled()).toBe(false);
    expect(traceNativeStartupStage(NativeStartupStage.AppReady)).toBe(false);
  }
  expect(log).not.toHaveBeenCalled();
});

it('emits only owned numeric stages in observation order', () => {
  process.env.BRIDGE_NATIVE_STARTUP_TRACE = '1';
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const stages = Object.values(NativeStartupStage).filter((value): value is number => typeof value === 'number');
  expect(stages).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  for (const stage of stages) expect(traceNativeStartupStage(stage)).toBe(true);
  expect(log.mock.calls).toEqual(stages.map(stage => [`BRIDGE_NATIVE_STAGE=${stage}`]));
});

it('rejects unknown runtime values without serializing or echoing them', () => {
  process.env.BRIDGE_NATIVE_STARTUP_TRACE = '1';
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const toJSON = jest.fn(() => 'private-secret');
  for (const value of ['private-stage', 0, 13, -1, NaN, Infinity, 1.5, { toJSON }]) {
    expect(traceNativeStartupStage(value as NativeStartupStage)).toBe(false);
  }
  expect(log).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
});

it('does not throw into the application when the diagnostic sink fails', () => {
  process.env.BRIDGE_NATIVE_STARTUP_TRACE = '1';
  jest.spyOn(console, 'log').mockImplementation(() => { throw new Error('private-sink-path'); });
  expect(traceNativeStartupStage(NativeStartupStage.ConnectCreated)).toBe(false);
});
