import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  ServerConnection,
  type ConnectionSnapshot,
  type ProbeTransport,
} from '@bridge/core';

import { nativeProbe, nativeServerOptions } from './src/network';
const errors: Record<
  Extract<ConnectionSnapshot, { state: 'error' }>['reason'],
  string
> = {
  empty: 'Enter your Bridge server address.',
  invalid: 'Enter a valid HTTPS server address.',
  insecure: 'Use HTTPS to protect your connection.',
  credentials: 'Enter the server address without a username or password.',
  'not-bridge': 'This address did not return a Bridge liveness response.',
  unavailable:
    'The server could not be reached. Check the address and connection.',
};

export default function App({
  transport = nativeProbe,
}: {
  transport?: ProbeTransport;
}) {
  const dark = useColorScheme() === 'dark';
  const [address, setAddress] = useState('');
  const connection = useMemo(
    () =>
      new ServerConnection(
        transport,
        nativeServerOptions(Platform.OS, __DEV__),
      ),
    [transport],
  );
  const snapshot = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
  );
  useEffect(() => () => connection.dispose(), [connection]);
  const themedStyles = useMemo(
    () =>
      StyleSheet.create({
        screen: { backgroundColor: dark ? '#0c0e1a' : '#f5f7fb' },
        text: { color: dark ? '#f1f5f9' : '#111827' },
        input: {
          color: dark ? '#f1f5f9' : '#111827',
          backgroundColor: dark ? '#19213a' : '#ffffff',
        },
        error: { color: dark ? '#fda4af' : '#b91c1c' },
      }),
    [dark],
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.screen, themedStyles.screen]}>
        <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            accessibilityRole="header"
            style={[styles.brand, themedStyles.text]}
          >
            Bridge
          </Text>
          <Text style={[styles.preview, themedStyles.text]}>
            Native preview
          </Text>
          <Text
            accessibilityRole="header"
            style={[styles.heading, themedStyles.text]}
          >
            Connect to your server
          </Text>
          <Text style={[styles.description, themedStyles.text]}>
            Enter the address of your Bridge installation.
          </Text>
          <TextInput
            testID="server-url-input"
            accessibilityLabel="Server address"
            value={address}
            onChangeText={value => {
              setAddress(value);
              connection.setTarget(value);
            }}
            placeholder="https://chat.example.com"
            placeholderTextColor={dark ? '#a4afc6' : '#596579'}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType="go"
            onSubmitEditing={() => {
              connection.connect();
            }}
            style={[styles.input, themedStyles.input]}
          />
          <Pressable
            testID="connect-button"
            accessibilityRole="button"
            accessibilityLabel="Connect"
            accessibilityState={{ disabled: snapshot.state === 'checking' }}
            disabled={snapshot.state === 'checking'}
            onPress={() => {
              connection.connect();
            }}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            <Text style={styles.buttonText}>Connect</Text>
          </Pressable>
          {snapshot.state === 'checking' && (
            <View style={styles.status}>
              <ActivityIndicator accessibilityLabel="Checking server" />
              <Text style={themedStyles.text}>Checking your server…</Text>
            </View>
          )}
          {snapshot.state === 'error' && (
            <Text
              testID="connection-error"
              accessibilityRole="alert"
              style={[styles.error, themedStyles.error]}
            >
              {errors[snapshot.reason]}
            </Text>
          )}
          {snapshot.state === 'connected' && (
            <View accessibilityLiveRegion="polite" style={styles.status}>
              <Text
                testID="connection-success"
                style={[styles.success, themedStyles.text]}
              >
                Server verified
              </Text>
              <Text style={themedStyles.text}>{snapshot.origin}</Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: 28, gap: 16 },
  brand: { fontSize: 42, fontWeight: '700' },
  preview: { fontSize: 14, marginBottom: 24 },
  heading: { fontSize: 25, fontWeight: '600' },
  description: { fontSize: 16, lineHeight: 24 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: '#62708b',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
  },
  button: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: '#2463a8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: 17, fontWeight: '600' },
  status: { gap: 10, paddingVertical: 14 },
  error: { fontSize: 16, lineHeight: 24 },
  success: { fontSize: 18, fontWeight: '600' },
});
