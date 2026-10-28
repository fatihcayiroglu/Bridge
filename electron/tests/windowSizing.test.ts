import { fitInitialWindowToDisplay } from '../windowSizing';

const requested = { width: 1280, height: 800, minWidth: 900, minHeight: 600 };

describe('real Electron screen work-area contract (DIP units)', () => {
  it.each([
    ['small work area', { width: 1024, height: 680 }, { width: 1024, height: 680, minWidth: 900, minHeight: 600 }],
    ['720p with a taskbar', { width: 1280, height: 680 }, { width: 1280, height: 680, minWidth: 900, minHeight: 600 }],
    ['Full HD', { width: 1920, height: 1040 }, requested],
    ['QHD', { width: 2560, height: 1400 }, requested],
    ['4K', { width: 3840, height: 2100 }, requested],
    ['small secondary display', { width: 720, height: 480 }, { width: 720, height: 480, minWidth: 720, minHeight: 480 }],
  ])('%s is visible without exceeding the operating system work area', (_label, workArea, expected) => {
    expect(fitInitialWindowToDisplay(workArea, requested)).toEqual(expected);
  });

  it.each([1, 1.25, 1.5, 2])('does not double-scale an already-DIP work area (OS scale %s)', (_scale) => {
    // Physical resolution changes with OS scaling. Electron already reports
    // workAreaSize as DIP, so its values are used as supplied.
    expect(fitInitialWindowToDisplay({ width: 1024, height: 720 }, requested))
      .toEqual({ width: 1024, height: 720, minWidth: 900, minHeight: 600 });
  });

  it('the fixed-size first-run connection window also fits a small display', () => {
    expect(fitInitialWindowToDisplay({ width: 480, height: 420 }, { width: 520, height: 600 }))
      .toEqual({ width: 480, height: 420 });
  });

  it('never emits a zero, NaN, or oversized minimum window', () => {
    expect(fitInitialWindowToDisplay({ width: Number.NaN, height: 0 }, requested)).toEqual(requested);
    expect(() => fitInitialWindowToDisplay({ width: 1920, height: 1080 }, { width: -1, height: 800 }))
      .toThrow(/Invalid requested window size/);
  });
});
