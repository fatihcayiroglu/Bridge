/** Optional native-window observations. Codes never contain app/user data. */
export enum NativeStartupStage {
  AppReady = 1,
  TrayStarting = 2,
  TrayReady = 3,
  ConnectCreated = 4,
  ConnectLoadRequested = 5,
  ConnectDomReady = 6,
  ConnectReadyToShow = 7,
  ConnectShowHandlerAttached = 8,
  ConnectShown = 9,
  ConnectLoadComplete = 10,
  ConnectLoadFailed = 11,
  ConnectRendererGone = 12,
}

export function nativeStartupTraceEnabled(): boolean {
  return process.env.BRIDGE_NATIVE_STARTUP_TRACE === '1';
}

export function traceNativeStartupStage(stage: NativeStartupStage): boolean {
  if (!nativeStartupTraceEnabled() || typeof stage !== 'number' || !Number.isInteger(stage)
      || !Object.prototype.hasOwnProperty.call(NativeStartupStage, stage)) return false;
  try {
    console.log(`BRIDGE_NATIVE_STAGE=${stage}`);
    return true;
  } catch {
    // Diagnostic sink failures must not change window startup behavior.
    return false;
  }
}
