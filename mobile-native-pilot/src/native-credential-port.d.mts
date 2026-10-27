export type NativeCredentialErrorCode =
  | 'INVALID_NATIVE_ADAPTER'
  | 'INVALID_TOKEN'
  | 'INVALID_STORED_TOKEN'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_FAILURE';

export declare class NativeCredentialError extends Error {
  readonly code: NativeCredentialErrorCode;
  constructor(code: NativeCredentialErrorCode);
}

export declare const NATIVE_PILOT_CREDENTIAL_KEY: 'bridge.nativepilot.session.v1';

export interface SecureStorePort {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: string | number;
  isAvailableAsync(): Promise<boolean>;
  getItemAsync(key: string, options?: {
    keychainAccessible: string | number;
    requireAuthentication: boolean;
  }): Promise<string | null>;
  setItemAsync(key: string, token: string, options?: {
    keychainAccessible: string | number;
    requireAuthentication: boolean;
  }): Promise<void>;
  deleteItemAsync(key: string, options?: {
    keychainAccessible: string | number;
    requireAuthentication: boolean;
  }): Promise<void>;
}

export interface NativeCredentialPort {
  readToken(): Promise<string | null>;
  writeToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
}
export declare function createNativeCredentialPort(config: {
  secureStore: SecureStorePort;
}): NativeCredentialPort;
