// client/js/webrtc-base.ts
// Shared type declarations for webrtc.ts and webrtc-sfu.ts
// Import this file (or use triple-slash reference) instead of redeclaring.

export interface BridgeSocket {
  on(event: string, fn: (...args: unknown[]) => void): this;
  once(event: string, fn: (...args: unknown[]) => void): this;
  off(event: string, fn?: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): this;
  id: string;
  connected: boolean;
}
