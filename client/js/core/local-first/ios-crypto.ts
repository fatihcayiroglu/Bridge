// WKWebView cannot persist a non-extractable CryptoKey (DataCloneError). This
// adapter keeps key bytes entirely in Keychain/CryptoKit and retains the v1
// AES-GCM envelope and authenticated record scope. It is local at-rest storage.
import { Capacitor } from '@capacitor/core';
import { BridgeLocalFirstCrypto } from '@bridge/local-first-crypto';
import type { LocalFirstEnvelope } from './crypto.ts';
import type { LocalFirstCipher } from './store.ts';
import { isLocalAccountErased } from './erased-accounts.ts';

export function iosLocalFirstCipher(userId: string): (LocalFirstCipher & {
  hasKey(): Promise<boolean>; ensureKey(): Promise<void>;
}) | null {
  if (Capacitor.getPlatform() !== 'ios' || !Capacitor.isPluginAvailable('BridgeLocalFirstCrypto')) return null;
  const scopeCheck = (scope: string) => {
    if (!scope.startsWith(`user:${encodeURIComponent(userId)}:`)) throw new Error('Local encryption account scope mismatch');
  };
  return {
    userId, kind: 'ios-keychain', durable: true,
    async hasKey() {
      const value = await BridgeLocalFirstCrypto.hasKey({ userId });
      if (typeof value?.exists !== 'boolean') throw new Error('Native key status is unverifiable');
      return value.exists;
    },
    async ensureKey() {
      // Account erasure removes the Keychain key; never create it again. A
      // key created while an erasure was being marked is deleted at once.
      if (isLocalAccountErased(userId)) throw new Error('Local data for this account was erased');
      const persistent = (await BridgeLocalFirstCrypto.ensureKey({ userId }))?.persistent === true;
      if (isLocalAccountErased(userId)) {
        await BridgeLocalFirstCrypto.deleteKey({ userId });
        throw new Error('Local data for this account was erased');
      }
      if (!persistent) throw new Error('Native key persistence is unverifiable');
    },
    async encryptJson(value, scope) {
      scopeCheck(scope);
      const plaintext = JSON.stringify(value);
      if (typeof plaintext !== 'string') throw new Error('Invalid local JSON value');
      const envelope = await BridgeLocalFirstCrypto.encrypt({ userId, plaintext, scope });
      if (envelope?.v !== 1 || envelope.alg !== 'AES-GCM' || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
        throw new Error('Invalid native encryption envelope');
      }
      return envelope;
    },
    async decryptJson<T>(envelope: LocalFirstEnvelope, scope: string): Promise<T> {
      scopeCheck(scope);
      const value = await BridgeLocalFirstCrypto.decrypt({ userId, envelope, scope });
      if (typeof value?.plaintext !== 'string') throw new Error('Invalid native decrypted value');
      return JSON.parse(value.plaintext) as T;
    },
    async deleteKey() { await BridgeLocalFirstCrypto.deleteKey({ userId }); },
  };
}
