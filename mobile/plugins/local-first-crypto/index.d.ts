export interface LocalCryptoEnvelope { v: 1; alg: 'AES-GCM'; iv: string; ct: string; }
export interface NativeLocalFirstCrypto {
  hasKey(options: { userId: string }): Promise<{ exists: boolean }>;
  ensureKey(options: { userId: string }): Promise<{ persistent: boolean }>;
  encrypt(options: { userId: string; plaintext: string; scope: string }): Promise<LocalCryptoEnvelope>;
  decrypt(options: { userId: string; envelope: LocalCryptoEnvelope; scope: string }): Promise<{ plaintext: string }>;
  deleteKey(options: { userId: string }): Promise<void>;
}
export const BridgeLocalFirstCrypto: NativeLocalFirstCrypto;
