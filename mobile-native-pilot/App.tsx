import React, { useCallback, useRef, useState } from 'react';
import {
  FlatList, Pressable, SafeAreaView, StatusBar, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { createStartupMetrics } from './src/startup-metrics.mjs';

type Screen = 'sign-in' | 'channels' | 'messages';
type SampleMessage = { id: string; sender: string; body: string };

// Explicit render fixtures, NOT API or message-delivery evidence.
const DISPLAY_ONLY_MESSAGES: readonly SampleMessage[] = [
  { id: 'p1', sender: 'Bridge pilot', body: 'Native message row rendering fixture.' },
  { id: 'p2', sender: 'Bridge pilot', body: 'No data is sent or stored by this experiment.' },
];

const clock = () => globalThis.performance?.now?.() ?? Date.now();
const startup = createStartupMetrics(clock);
startup.mark('js_entry');

export default function App() {
  const [screen, setScreen] = useState<Screen>('sign-in');
  const [draft, setDraft] = useState('');
  const firstLayout = useRef(false);
  const recordLayout = useCallback(() => {
    if (firstLayout.current) return;
    firstLayout.current = true;
    startup.mark('first_layout');
    if (__DEV__) console.info('[native-pilot] js-layout-proxy', startup.snapshot());
  }, []);
  const navigate = (next: Screen) => {
    startup.mark('first_interaction');
    setScreen(next);
  };

  return (
    <SafeAreaView style={styles.root} onLayout={recordLayout}>
      <StatusBar barStyle="light-content" backgroundColor="#0d111b" />
      <Text style={styles.flag}>EXPERIMENTAL NATIVE UI • NOT CONNECTED</Text>
      <Text style={styles.heading}>Bridge</Text>
      <Text style={styles.subheading}>Android / iOS React Native rendering pilot</Text>

      {screen === 'sign-in' && (
        <View style={styles.panel}>
          <Text style={styles.title}>Sign-in layout</Text>
          <Text style={styles.paragraph}>
            UI-only fixture. Authentication is intentionally disabled until the real
            shared auth contract and security tests are integrated.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => navigate('channels')} style={styles.button}>
            <Text style={styles.buttonText}>Inspect channel-list layout</Text>
          </Pressable>
        </View>
      )}

      {screen === 'channels' && (
        <View style={styles.panel}>
          <Text style={styles.title}>Channels (display fixtures)</Text>
          <Pressable accessibilityRole="button" onPress={() => navigate('messages')} style={styles.channel}>
            <Text style={styles.channelText}># native-render-probe</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => navigate('sign-in')} style={styles.link}>
            <Text style={styles.linkText}>Back</Text>
          </Pressable>
        </View>
      )}

      {screen === 'messages' && (
        <View style={styles.panel}>
          <Text style={styles.title}>Message layout (display fixtures)</Text>
          <FlatList<SampleMessage>
            data={DISPLAY_ONLY_MESSAGES as SampleMessage[]}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <View style={styles.message}>
                <Text style={styles.sender}>{item.sender}</Text>
                <Text style={styles.paragraph}>{item.body}</Text>
              </View>
            )}
          />
          <TextInput
            accessibilityLabel="Nonfunctional message composer layout"
            value={draft}
            onChangeText={setDraft}
            editable={false}
            placeholder="Sending disabled in native pilot"
            placeholderTextColor="#8b95a7"
            style={styles.input}
          />
          <Pressable accessibilityRole="button" onPress={() => navigate('channels')} style={styles.link}>
            <Text style={styles.linkText}>Back to channels</Text>
          </Pressable>
        </View>
      )}
      <Text style={styles.footer}>
        JS layout markers are not TTID, TTFD, ANR, or product acceptance evidence.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d111b', paddingHorizontal: 22, paddingVertical: 24 },
  flag: { color: '#fbbf24', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  heading: { color: '#f9fafb', fontSize: 36, fontWeight: '800', marginTop: 20 },
  subheading: { color: '#a9b4c6', fontSize: 13, marginTop: 5, marginBottom: 30 },
  panel: { flex: 1, padding: 20, borderWidth: 1, borderColor: '#2d3748', borderRadius: 18, backgroundColor: '#151c2a' },
  title: { color: '#f1f5f9', fontSize: 20, fontWeight: '700', marginBottom: 16 },
  paragraph: { color: '#c5d0df', fontSize: 15, lineHeight: 23 },
  button: { marginTop: 24, backgroundColor: '#5865f2', padding: 16, borderRadius: 12 },
  buttonText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  channel: { padding: 18, backgroundColor: '#202c43', borderRadius: 10 },
  channelText: { color: '#e2e8f0', fontSize: 16 },
  message: { paddingVertical: 15, borderBottomWidth: 1, borderColor: '#273449' },
  sender: { color: '#a5b4fc', fontWeight: '700', marginBottom: 5 },
  input: { borderWidth: 1, borderColor: '#394558', borderRadius: 10, color: 'white', marginTop: 12, padding: 12 },
  link: { marginTop: 24, paddingVertical: 10 },
  linkText: { color: '#acb6ff', fontWeight: '600' },
  footer: { color: '#94a3b8', fontSize: 11, lineHeight: 17, marginTop: 20 },
});
