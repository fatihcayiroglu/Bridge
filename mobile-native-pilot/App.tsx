import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { createPilotSession } from './src/pilot-session';
import { createMessagingController, type MessagingSnapshot } from './src/messaging-controller.mjs';
import NativeAcceptanceProbe from './src/NativeAcceptanceProbe';

function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}
export default function App() {
  if (__DEV__ && process.env.EXPO_PUBLIC_NATIVE_SELF_TEST === '1') return <NativeAcceptanceProbe />;
  const origin = process.env.EXPO_PUBLIC_BRIDGE_ORIGIN ?? '';
  let valid = false;
  try { const url = new URL(origin); valid = url.protocol === 'https:' && url.origin === origin && !url.username && !url.password; } catch {}
  if (!valid) return <SafeAreaView style={styles.root}><Text style={styles.title}>Bridge native pilot</Text>
    <Text style={styles.text}>Configure EXPO_PUBLIC_BRIDGE_ORIGIN with your test Bridge HTTPS origin and register com.bridge.nativepilot:/oauth on that server. No server is selected automatically.</Text>
    <Text style={styles.muted}>Experimental pilot. Physical Android/iOS acceptance remains outstanding.</Text></SafeAreaView>;
  return <ConnectedPilot origin={origin} />;
}
function ConnectedPilot({ origin }: { origin: string }) {
  const [runtime] = useState(() => {
    const session = createPilotSession(origin, 'com.bridge.nativepilot:/oauth');
    return { session, controller: createMessagingController({ ...session, createId: () => Crypto.randomUUID() }) };
  });
  const [state, setState] = useState<MessagingSnapshot>(() => runtime.controller.snapshot());
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(state.session.epoch), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = runtime.controller.subscribe(next => {
      if (epoch.current !== next.session.epoch) { epoch.current = next.session.epoch; setDraft(''); setNotice(null); }
      setState(next);
    });
    void runtime.session.coordinator.restore().then(() => runtime.controller.start()).catch(() => { if (alive.current) setNotice('Session restoration failed. Please sign in again.'); });
    return () => { alive.current = false; unsubscribe(); runtime.controller.dispose(); };
  }, [runtime]);
  async function perform(work: () => Promise<unknown>) {
    setBusy(true); setNotice(null);
    try { await work(); } catch { if (alive.current) setNotice('The operation could not be completed. Check the message state before retrying.'); }
    finally { if (alive.current) setBusy(false); }
  }
  const ids = new Set(state.messages.map(message => message._id));
  const rows = [
    ...state.messages.map(message => ({ id: `server:${message._id}`, body: typeof message.content === 'string' ? message.content : '[Unsupported message]', author: typeof message.displayName === 'string' ? message.displayName : 'Member', status: 'received', retryId: null as string | null })),
    ...state.drafts.filter(row => !row.messageId || !ids.has(row.messageId)).map(row => ({ id: `draft:${row.id}`, body: row.content, author: 'You', status: row.status, retryId: ['failed', 'unconfirmed'].includes(row.status) ? row.id : null })),
  ];
  return <SafeAreaView style={styles.root}>
    <Text style={styles.title}>Bridge</Text>
    <Text style={styles.muted}>Experimental native pilot • {state.connection === 'online' ? 'Connected' : 'Offline / reconnecting'}</Text>
    <Text style={styles.muted}>Encrypted local outbox pilot. Unconfirmed sends require an explicit retry.</Text>
    {(notice || state.error) && <Text accessibilityRole="alert" style={styles.error}>{notice ?? 'Could not refresh messages. Try again.'}</Text>}
    {state.session.phase !== 'authenticated' ? <View><Text style={styles.text}>Session: {state.session.phase}</Text>
      <Action label="Sign in with your browser" disabled={busy} onPress={() => void perform(() => runtime.session.signInWithBrowser())} /></View> : <>
      <View style={styles.actions}>
        <Action label="Sign out" disabled={busy} onPress={() => void perform(async () => { const result = await runtime.session.coordinator.signOut(); if (alive.current && result.serverSignOut === 'unconfirmed') setNotice('Signed out locally. Server revocation was not confirmed.'); })} />
        <Action label="Switch account" disabled={busy} onPress={() => void perform(async () => { await runtime.session.coordinator.signOut(); await runtime.session.signInWithBrowser({ freshAuthentication: true }); })} />
      </View>
      {!state.channelId ? <View style={styles.selection}>
        <Text style={styles.text}>Choose a community</Text>
        {state.servers.map(server => <Action key={server.id} label={server.name} disabled={busy} onPress={() => void perform(() => runtime.controller.selectServer(server.id))} />)}
        {state.serverId && <Text style={styles.text}>Choose a channel</Text>}
        {state.channels.map(channel => <Action key={channel.id} label={`# ${channel.name}`} disabled={busy} onPress={() => void perform(() => runtime.controller.selectChannel(channel.id))} />)}
      </View> : <>
        <View style={styles.actions}>
          <Action label="Channels" disabled={busy} onPress={() => void perform(async () => { setDraft(''); await runtime.controller.selectServer(state.serverId!); })} />
          <Action label="Refresh history" disabled={busy} onPress={() => void perform(() => runtime.controller.refresh())} />
        </View>
        <FlatList style={styles.messages} data={rows} keyExtractor={row => row.id} renderItem={({ item }) => <View style={styles.message}>
          <Text style={styles.author}>{item.author}</Text><Text style={styles.text}>{item.body}</Text><Text style={styles.muted}>{item.status}</Text>
          {item.retryId && <Action label="Retry with original message ID" disabled={busy || state.connection !== 'online'} onPress={() => void perform(() => runtime.controller.retry(item.retryId!))} />}
        </View>} />
        <TextInput accessibilityLabel="Message" multiline maxLength={4000} value={draft} onChangeText={setDraft} editable={!busy} style={styles.input} placeholder="Write a message" placeholderTextColor="#8b95a7" />
        <Action label={state.connection === 'online' ? 'Send message' : 'Queue offline'} disabled={busy || !draft.trim()} onPress={() => { const content = draft, admittedEpoch = epoch.current; void perform(async () => { await runtime.controller.send(content); if (alive.current && epoch.current === admittedEpoch) setDraft(''); }); }} />
      </>}
    </>}
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: 20, backgroundColor: '#101622' }, title: { fontSize: 28, fontWeight: '700', color: '#f4f6ff', marginBottom: 8 },
  text: { fontSize: 16, color: '#e0e5f0', marginVertical: 5 }, muted: { fontSize: 12, color: '#acb6ca', marginVertical: 4 }, error: { color: '#ffb6ae', marginVertical: 8 },
  author: { color: '#b7c0ff', fontWeight: '600' }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, selection: { flex: 1 }, messages: { flex: 1 },
  message: { paddingVertical: 12, borderBottomColor: '#30394c', borderBottomWidth: 1 }, input: { borderWidth: 1, borderColor: '#59637b', borderRadius: 8, color: '#ffffff', padding: 12, minHeight: 48 },
  button: { padding: 12, marginVertical: 5, borderRadius: 8, backgroundColor: '#4655c2' }, disabled: { opacity: 0.45 }, buttonText: { color: '#ffffff', fontWeight: '600' },
});
