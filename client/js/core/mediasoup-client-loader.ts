// client/js/core/mediasoup-client-loader.ts
//
// mediasoup-client is loaded ON DEMAND: it is ~190 KB of the first bundle
// (esbuild metafile) and only needed once a user actually joins an SFU room.
//
// The package is CommonJS. In the production bundle (esbuild, `format: 'esm'`
// + `splitting`) a dynamic `import()` of a CommonJS package resolves to a
// namespace whose ONLY export is `default` (= `module.exports`); Node and the
// unit-test module mocks expose named exports instead. Destructuring
// `{ Device }` from the bundle's namespace yielded `undefined`, so every SFU
// voice join in the built web app failed with "is not a constructor"
// (reproduced with real browsers in the P2 media lab). Both shapes are
// unwrapped here, in one place.

export type MediasoupClientModule = typeof import('mediasoup-client');

type MaybeMediasoupClient = Partial<MediasoupClientModule> & { default?: Partial<MediasoupClientModule> };

export function mediasoupClientExports(mod: unknown): MediasoupClientModule {
  const ns = (mod ?? {}) as MaybeMediasoupClient;
  if (typeof ns.Device === 'function') return ns as MediasoupClientModule;
  const commonJs = ns.default;
  if (commonJs && typeof commonJs.Device === 'function') return commonJs as MediasoupClientModule;
  throw new Error('mediasoup-client did not expose a Device constructor');
}

let pending: Promise<MediasoupClientModule> | null = null;

export function loadMediasoupClient(): Promise<MediasoupClientModule> {
  // Single flight: concurrent joins share one load.
  pending ??= import('mediasoup-client').then(mediasoupClientExports);
  return pending;
}
