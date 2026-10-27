// Explicit debug-only native acceptance route. Never uses a real account/token.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { openNativeOutboxJournal } from './native-outbox-journal';
import { pilotNativeCredentialPort } from './expo-credential-port';
import { pilotInstallMarker } from './expo-install-marker';
import { createInstallGuard } from './install-guard.mjs';

// Fixture only; never a real credential. Stored with the real pilot credential port so the
// install guard is exercised against the actual Keychain/Keystore item it protects.
const FIXTURE_REFRESH = 'native-acceptance-fixture-refresh-token';

export default function NativeAcceptanceProbe() {
  const [result, setResult] = useState('NATIVE_ACCEPTANCE_RUNNING');
  useEffect(() => {
    let stage = 'secure-store-availability';
    void (async () => {
      const key = 'bridge.nativepilot.acceptance.ack.v1';
      const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
      if (!await SecureStore.isAvailableAsync()) throw new Error('SECURE_STORE_REQUIRED');
      // Fresh-install purge first, exactly as the app does before restoring a session.
      stage = 'install-guard';
      const install = await createInstallGuard({ marker: pilotInstallMarker, credentials: pilotNativeCredentialPort,
        revoke: async () => {}, createId: () => Crypto.randomUUID() }).prepare();
      // The probe's own fixture state belongs to one installation too.
      if (install.freshInstall) await SecureStore.deleteItemAsync(key, options);
      stage = 'install-guard-credential';
      if (await pilotNativeCredentialPort.readToken() !== (install.freshInstall ? null : FIXTURE_REFRESH)) throw new Error('INSTALL_GUARD_CREDENTIAL_MISMATCH');
      if (install.freshInstall) await pilotNativeCredentialPort.writeToken(FIXTURE_REFRESH);
      const installMarkers = `${install.freshInstall ? 'NATIVE_INSTALL_GUARD_FRESH' : 'NATIVE_INSTALL_GUARD_KEPT'} ${install.purged ? 'NATIVE_INSTALL_LEFTOVER_PURGED' : 'NATIVE_INSTALL_LEFTOVER_NONE'}`;
      stage = 'secure-store-read';
      const prior = await SecureStore.getItemAsync(key, options);
      const id = prior ?? Crypto.randomUUID();
      stage = 'journal-A-open';
      const a = await openNativeOutboxJournal('native-acceptance-account-A');
      stage = 'journal-B-open';
      const b = await openNativeOutboxJournal('native-acceptance-account-B');
      stage = 'journal-confirmed-receipts-open';
      const receipts = await openNativeOutboxJournal('native-acceptance-confirmed-receipts');
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
        stage = 'native-sqlcipher-receipt-compaction';
        const receiptId = (index: number) => `native-confirmed-${index}`;
        if (!prior) {
          for (let i = 0; i < 100; i++) {
            const msgId = receiptId(i);
            await receipts.append({ id: msgId, serverId: 'test-server', channelId: 'test-channel', content: `receipt fixture ${i}` });
            if (i === 4) { await receipts.mark(msgId, 'sending'); await receipts.mark(msgId, 'unconfirmed'); }
            else if (i !== 9) { await receipts.mark(msgId, 'sending'); await receipts.mark(msgId, 'confirmed', `confirmed-${i}`); }
          }
          const removed = await receipts.pruneConfirmed(25);
          const expected = Array.from({ length: 100 }, (_, i) => i).filter(i => i !== 4 && i !== 9).slice(0, 25).map(receiptId);
          if (JSON.stringify(removed) !== JSON.stringify(expected)) throw new Error('CONFIRMED_RECEIPTS_ONLY_REQUIRED');
          await receipts.append({ id: 'native-after-compaction', serverId: 'test-server', channelId: 'test-channel', content: 'safe new draft' });
        }
        const surviving = await receipts.list();
        if (surviving.length !== 76 || surviving.some(row => row.id === receiptId(0)) ||
            surviving.find(row => row.id === receiptId(4))?.status !== 'unconfirmed' ||
            surviving.find(row => row.id === receiptId(9))?.status !== 'queued' ||
            surviving.find(row => row.id === 'native-after-compaction')?.status !== 'queued') throw new Error('NATIVE_RECEIPT_COMPACTION_PERSISTENCE_FAILED');
        const marker = prior ? 'NATIVE_RECEIPT_COMPACTION_RESTORE_PASS' : 'NATIVE_RECEIPT_COMPACTION_PASS';
        setResult(prior ? `NATIVE_SECURE_STORE_RESTORE_PASS NATIVE_SQLCIPHER_RECOVERY_PASS NATIVE_ACCOUNT_ISOLATION_PASS ${marker} ${installMarkers}` : `NATIVE_SECURE_STORE_ROUNDTRIP_PASS NATIVE_SQLCIPHER_WRITE_PASS NATIVE_ACCOUNT_ISOLATION_PASS ${marker} ${installMarkers}`);
      } finally { await a.close(); await b.close(); await receipts.close(); }
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
