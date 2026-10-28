// Electron screen.getPrimaryDisplay().workAreaSize reports DEVICE-INDEPENDENT
// pixels (DIP), already adjusted for the operating system's DPI scaling.
// Never divide by scaleFactor again: Windows 125/150/200% and macOS Retina
// would otherwise shrink the UI a second time.
export interface WorkAreaSize { width: number; height: number }
export interface WindowSizeRequest {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
}

// This is a window-start contract, not a claim that all content is responsive.
// The OS may change usable size after launch (taskbar, dock, external monitors);
// those transitions still require native acceptance.
export function fitInitialWindowToDisplay(
  workArea: WorkAreaSize,
  desired: WindowSizeRequest,
): WindowSizeRequest {
  function fit(available: number, requested: number): number {
    if (!Number.isFinite(requested) || requested <= 0) throw new RangeError('Invalid requested window size');
    // Electron normally supplies valid positive DIP values. If a display
    // reports transient invalid geometry, preserve the previous default rather
    // than opening a zero-sized window or propagating NaN to BrowserWindow.
    const usable = Number.isFinite(available) && available > 0 ? Math.floor(available) : requested;
    return Math.max(1, Math.min(Math.floor(requested), usable));
  }
  const width = fit(workArea.width, desired.width);
  const height = fit(workArea.height, desired.height);
  return {
    width,
    height,
    ...(desired.minWidth === undefined ? {} : { minWidth: fit(width, desired.minWidth) }),
    ...(desired.minHeight === undefined ? {} : { minHeight: fit(height, desired.minHeight) }),
  };
}
