// client/tests/helpers/canvas-mock.ts
//
// jsdom'da HTMLCanvasElement.getContext('2d') stub döndürür — gerçek 2D context yok.
// jest-canvas-mock paketi tam çözüm sağlar.
//
// Kurulum:
//   npm install --save-dev jest-canvas-mock
//   client/tests/package.json "jest.setupFiles"'a ekle:
//     ["./helpers/setup.ts", "jest-canvas-mock"]
//
// jest-canvas-mock KURULU DEĞİLSE bu dosyayı setupFiles'a ekle:
//   ["./helpers/setup.ts", "./helpers/canvas-mock.ts"]

// ── Manuel Canvas 2D context mock ─────────────────────────────────────────────
// jest-canvas-mock kadar kapsamlı değil ama temel drawStroke/clearRect testleri için yeterli.

class MockCanvasRenderingContext2D {
  // State
  fillStyle   : string | CanvasGradient | CanvasPattern = '#000000';
  strokeStyle : string | CanvasGradient | CanvasPattern = '#000000';
  lineWidth   = 1;
  lineCap     : CanvasLineCap  = 'butt';
  lineJoin    : CanvasLineJoin = 'miter';
  globalAlpha = 1;
  font        = '10px sans-serif';
  textAlign   : CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  shadowBlur  = 0;
  shadowColor = 'transparent';

  // Transform
  canvas = { width: 800, height: 600 } as HTMLCanvasElement;

  // All draw methods are jest.fn()
  clearRect        = jest.fn();
  fillRect         = jest.fn();
  strokeRect       = jest.fn();
  beginPath        = jest.fn();
  closePath        = jest.fn();
  moveTo           = jest.fn();
  lineTo           = jest.fn();
  arc              = jest.fn();
  arcTo            = jest.fn();
  rect             = jest.fn();
  ellipse          = jest.fn();
  bezierCurveTo    = jest.fn();
  quadraticCurveTo = jest.fn();
  fill             = jest.fn();
  stroke           = jest.fn();
  clip             = jest.fn();
  save             = jest.fn();
  restore          = jest.fn();
  scale            = jest.fn();
  rotate           = jest.fn();
  translate        = jest.fn();
  transform        = jest.fn();
  setTransform     = jest.fn();
  resetTransform   = jest.fn();
  drawImage        = jest.fn();
  createLinearGradient = jest.fn().mockReturnValue({ addColorStop: jest.fn() });
  createRadialGradient = jest.fn().mockReturnValue({ addColorStop: jest.fn() });
  createPattern    = jest.fn().mockReturnValue({});
  fillText         = jest.fn();
  strokeText       = jest.fn();
  measureText      = jest.fn().mockReturnValue({ width: 50 } as TextMetrics);
  putImageData     = jest.fn();
  getImageData     = jest.fn().mockReturnValue({ data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData);
  createImageData  = jest.fn().mockReturnValue({ data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData);
  setLineDash      = jest.fn();
  getLineDash      = jest.fn().mockReturnValue([]);
  isPointInPath    = jest.fn().mockReturnValue(false);
  isPointInStroke  = jest.fn().mockReturnValue(false);
}

// ── HTMLCanvasElement.getContext patch ─────────────────────────────────────────

const _mockCtxInstance = new MockCanvasRenderingContext2D();

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: jest.fn((contextType: string) => {
    if (contextType === '2d') return _mockCtxInstance;
    return null;
  }),
  writable: true,
  configurable: true,
});

// Canvas boyutları (jsdom'da 0 döner)
Object.defineProperty(HTMLCanvasElement.prototype, 'width',  { value: 800, writable: true, configurable: true });
Object.defineProperty(HTMLCanvasElement.prototype, 'height', { value: 600, writable: true, configurable: true });

// toDataURL mock
Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
  value: jest.fn().mockReturnValue('data:image/png;base64,iVBORw0KGgo='),
  writable: true,
  configurable: true,
});

export { MockCanvasRenderingContext2D, _mockCtxInstance };
