declare module 'mediasoup' {
  export function createWorker(opts?: object): Promise<unknown>;
  export type Worker = unknown;
  export const types: Record<string, unknown>;
  const mediasoup: { createWorker(opts?: object): Promise<unknown> };
  export default mediasoup;
}
