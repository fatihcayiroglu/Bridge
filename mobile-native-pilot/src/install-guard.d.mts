import type { NativeCredentialPort } from './native-credential-port.mjs';

export type InstallGuardErrorCode =
  | 'INVALID_ADAPTER'
  | 'INVALID_ID'
  | 'MARKER_READ_FAILED'
  | 'MARKER_WRITE_FAILED'
  | 'PURGE_FAILED';

export declare class InstallGuardError extends Error {
  readonly code: InstallGuardErrorCode;
  constructor(code: InstallGuardErrorCode);
}

export interface InstallMarkerPort {
  read(): Promise<string | null>;
  write(id: string): Promise<void>;
}

export interface InstallGuard {
  prepare(): Promise<{ freshInstall: boolean; purged: boolean }>;
}

export declare function createInstallGuard(config: {
  marker: InstallMarkerPort;
  credentials: Pick<NativeCredentialPort, 'readToken' | 'clearToken'>;
  revoke(refreshToken: string): Promise<unknown>;
  createId(): string;
}): InstallGuard;
