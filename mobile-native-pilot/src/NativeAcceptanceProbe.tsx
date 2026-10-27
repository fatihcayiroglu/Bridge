// Explicit debug-only native acceptance route. Never uses a real account/token.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { openNativeOutboxJournal } from './native-outbox-journal';

export default function NativeAcceptanceProbe() {
  const [result, setResult] = useState('NATIVE_ACCEPTANCE_RUNNING');
  useEffect(() => {
    let stage = 'secure-store-availability';
    void (async () => {
      const key = 'bridge.nativepilot.acceptance.ack.v1';
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      if (!await SecureStore.isAvailableAsync()) throw new Error('SECURE_STORE_REQUIRED');
      stage = 'secure-store-read';
      const prior = await SecureStore.getItemAsync(key, options);
      const id = prior ?? Crypto.randomUUID();
      stage = 'journal-A-open';
      const a = await openNativeOutboxJournal('native-acceptance-account-A');
      stage = 'journal-B-open';
      const b = await openNativeOutboxJournal('native-acceptance-account-B');
      try {
        stage = 'journal-A-write-or-restore';
        if (prior) {
          const rows = await a.list();
          if (rows.length !== 1 || rows[0].id !== id || rows[0].status !== 'unconfirmed' || rows[0].content !== 'native-private-A') throw new Error('RESTART_RECOVERY_FAILED');
        } else {
          await a.append({ id, serverId: 'test-server', channelId: 'test-channel', content: 'native-private-A' });
          await a.mark(id, 'sending'); // simulate a process killed before an ACK
          await SecureStore.setItemAsync(key, id, options);
        }
        if (await SecureStore.getItemAsync(key, options) !== id) throw new Error('SECURE_STORE_ROUNDTRIP_FAILED');
        stage = 'journal-B-isolation';
        await b.append({ id, serverId: 'test-server', channelId: 'test-channel', content: 'native-private-B' });
        const isolated = await b.list();
        if (isolated.length !== 1 || isolated[0].content !== 'native-private-B') throw new Error('ACCOUNT_ISOLATION_FAILED');
        setResult(prior ? 'NATIVE_SECURE_STORE_RESTORE_PASS NATIVE_SQLCIPHER_RECOVERY_PASS NATIVE_ACCOUNT_ISOLATION_PASS' : 'NATIVE_SECURE_STORE_ROUNDTRIP_PASS NATIVE_SQLCIPHER_WRITE_PASS NATIVE_ACCOUNT_ISOLATION_PASS');
      } finally { await a.close(); await b.close(); }
    })().catch((error: unknown) => {
      // This debug-only route uses fixture accounts only. Keep the original
      // failure observable without emitting the generated database key/hash.
      const outer = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
      const reason = `${outer} ${cause}`.replace(/[a-f0-9]{64}/gi, '[redacted]').slice(0, 350);
      const failure = `NATIVE_ACCEPTANCE_FAILED ${stage}: ${reason}`;
      console.warn(failure);
      setResult(failure);
    });
  }, []);
  return <SafeAreaView><Text accessibilityLabel={result}>{result}</Text></SafeAreaView>;
}
