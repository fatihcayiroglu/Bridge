// The pilot's session wiring: one coordinator per app process, over the native
// Keychain/Keystore port, the native token endpoints, system-browser sign-in
// (Custom Tabs / ASWebAuthenticationSession) and the read API. Configured pilot
// screens use it; constructing it does not read storage or open a browser.
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { io } from 'socket.io-client';
import { createBridgeReadApi, type BridgeReadApi } from './bridge-read-api.mjs';
import { createBrowserSignIn } from './browser-sign-in.mjs';
import { createBrowserSessionSignIn } from './browser-session.mjs';
import { createBridgeRealtime, type BridgeRealtime } from './bridge-realtime.mjs';
import { createNativeAuthApi } from './native-auth-api.mjs';
import { createPkceAttempt } from './pkce.mjs';
import { createSessionCoordinator, type SessionCoordinator, type SessionState } from './session-coordinator.mjs';
import { pilotNativeCredentialPort } from './expo-credential-port';
import { openNativeOutboxJournal } from './native-outbox-journal';
import { createPersistentOutbox, type PersistentOutbox } from './persistent-outbox.mjs';

export type PilotSession = {
  coordinator: SessionCoordinator;
  /** Opens the system browser, then exchanges the code and adopts the session. */
  signInWithBrowser(): Promise<SessionState>;
  /** Reads with the current validated session only; fenced against account changes. */
  read: BridgeReadApi;
  /** Channel messaging over the existing Socket.IO contract; one socket per session epoch. */
  realtime: BridgeRealtime;
  outbox: PersistentOutbox;
};

const pkceCrypto = {
  randomBytes: (n: number) => Crypto.getRandomBytes(n),
  sha256: async (ascii: string) =>
    new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(ascii))),
};

/**
 * @param origin      Bridge web origin (https)
 * @param redirectUri exact entry of the server's NATIVE_AUTH_REDIRECT_URIS
 */
export function createPilotSession(origin: string, redirectUri: string): PilotSession {
  const authApi = createNativeAuthApi({ origin });
  const coordinator = createSessionCoordinator({
    credentials: pilotNativeCredentialPort,
    authApi,
    createReadApi: (getSession) => createBridgeReadApi({ origin, getSession }),
  });
  const browser = createBrowserSignIn({
    origin,
    redirectUri,
    createPkce: () => createPkceAttempt(pkceCrypto),
    // iOS: an ephemeral session does not share the Safari cookie jar, so every
    // native sign-in is an explicit sign-in on the web page.
    openAuthSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect, { preferEphemeralSession: true }),
  });
  const read = createBridgeReadApi({ origin, getSession: () => coordinator.getSession() });
  const realtime = createBridgeRealtime({ origin, coordinator, connect: (url, options) => io(url, options) });

  const signInWithBrowser = createBrowserSessionSignIn({ browser, authApi, coordinator });
  const outbox = createPersistentOutbox({ coordinator, realtime, createId: () => Crypto.randomUUID(), openJournal: accountId => openNativeOutboxJournal(accountId, origin) });
  return { coordinator, signInWithBrowser, read, realtime, outbox };
}
