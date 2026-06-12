// server/tests/__mocks__/mediasoup.ts
// Jest moduleNameMapper hedefi — tüm testlerde `import 'mediasoup'` bu dosyaya yönlenir.
// mediasoup.test.ts kendi jest.mock() override'ını kullanmaya devam edebilir;
// bu dosya sadece diğer test dosyalarının yanlışlıkla native mediasoup'u yüklememesini sağlar.

export const createWorker = jest.fn().mockResolvedValue({
  createRouter: jest.fn().mockResolvedValue({
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    canConsume: jest.fn(() => true),
    createWebRtcTransport: jest.fn().mockResolvedValue({
      id: 'transport-mock',
      iceParameters:  { usernameFragment: 'uf', password: 'pw', iceLite: false },
      iceCandidates:  [],
      dtlsParameters: { fingerprints: [], role: 'auto' },
      connect:  jest.fn().mockResolvedValue(undefined),
      produce:  jest.fn().mockResolvedValue({ id: 'producer-mock', rtpParameters: {}, on: jest.fn() }),
      consume:  jest.fn().mockResolvedValue({ id: 'consumer-mock', rtpParameters: {}, on: jest.fn() }),
      close:    jest.fn(),
      on:       jest.fn(),
    }),
  }),
  close: jest.fn(),
  on:    jest.fn(),
});
