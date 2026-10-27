// The pilot's session wiring: one coordinator per app process, over the native
// Keychain/Keystore port, the read-only API and the sign-in adapter. No screen uses it
// yet, and constructing it does not read storage; restore() does.
import { createBridgeAuthApi, type BridgeAuthApi } from './bridge-auth-api.mjs';
import { createBridgeReadApi, type BridgeReadApi } from './bridge-read-api.mjs';
import { createSessionCoordinator, type SessionCoordinator } from './session-coordinator.mjs';
import { pilotNativeCredentialPort } from './expo-credential-port';

export type PilotSession = {
  coordinator: SessionCoordinator;
  auth: BridgeAuthApi;
  /** Reads with the current validated session only; fenced against account changes. */
  read: BridgeReadApi;
};

export function createPilotSession(origin: string): PilotSession {
  const auth = createBridgeAuthApi({ origin });
  const coordinator = createSessionCoordinator({
    credentials: pilotNativeCredentialPort,
    createReadApi: (getSession) => createBridgeReadApi({ origin, getSession }),
    serverLogout: () => auth.logout(),
  });
  const read = createBridgeReadApi({ origin, getSession: () => coordinator.getSession() });
  return { coordinator, auth, read };
}
