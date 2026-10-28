export declare function base64Url(bytes: Uint8Array): string;
export type PkceAttempt = Readonly<{ verifier: string; challenge: string; state: string }>;
export declare function createPkceAttempt(crypto: {
  randomBytes: (n: number) => Uint8Array;
  sha256: (ascii: string) => Promise<Uint8Array>;
}): Promise<PkceAttempt>;
