export {};

type BridgeApi = {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
};

type BridgeUser = {
  id?: string;
  _id?: string;
  username?: string;
  displayName?: string;
  avatar?: string;
  email?: string;
  roles?: string[];
  isAdmin?: boolean;
  serverId?: string;
  [key: string]: unknown;
};

type BridgeServer = {
  id?: string;
  _id?: string;
  name?: string;
  ownerId?: string;
  [key: string]: unknown;
};

type BridgeQRCode = {
  new (el: Element | string, options?: unknown): unknown;
  toDataURL(text: string, options?: unknown): Promise<string>;
  toCanvas(canvas: HTMLCanvasElement, text: string, options?: unknown): Promise<void>;
};

declare global {
  const API: BridgeApi;
  const api: BridgeApi;
  const toast: (message: string, type?: string, timeoutMs?: number) => void;
  const showToast: (message: string, type?: string, timeoutMs?: number) => void;
  const escHtml: (value: unknown) => string;
  let currentUser: BridgeUser | null;
  let currentServer: BridgeServer | null;
  const QRCode: BridgeQRCode;
  const _nsM: ((key: string, fallback?: string) => string) & { process?: (stream: MediaStream) => Promise<MediaStream> | MediaStream };
  function initActivities(): void;
  function initSuperReactions(): void;
  function initClips(): void;
  function initStickers(): void;

  interface Window {
    API?: BridgeApi;
    api?: BridgeApi;
    toast?: typeof toast;
    showToast?: typeof showToast;
    escHtml?: typeof escHtml;
    currentUser?: BridgeUser | null;
    currentServer?: BridgeServer | null;
    QRCode?: BridgeQRCode;
    _nsM?: typeof _nsM;
    initActivities?: typeof initActivities;
    initSuperReactions?: typeof initSuperReactions;
    initClips?: typeof initClips;
    initStickers?: typeof initStickers;
    [key: string]: unknown;
  }
}

declare global {
  interface EventTarget {
    key?: string;
    shiftKey?: boolean;
    preventDefault?: () => void;
  }
  interface Element {
    style: CSSStyleDeclaration;
    value: string;
    disabled: boolean;
    dataset: DOMStringMap;
    onclick: ((this: GlobalEventHandlers, ev: MouseEvent) => unknown) | null;
    src: string;
    files: FileList | null;
    setSelectionRange(start: number, end: number, direction?: "forward" | "backward" | "none"): void;
    focus(options?: FocusOptions): void;
    checked: boolean;
    textContent: string | null;
    title: string;
    innerHTML: string;
  }
  interface Credential {
    response?: AuthenticatorResponse;
    authenticatorAttachment?: AuthenticatorAttachment | null;
  }
  interface AuthenticatorResponse {
    clientDataJSON?: ArrayBuffer;
  }
  interface AuthenticatorAttestationResponse {
    getTransports?: () => AuthenticatorTransport[];
  }
  type BridgeSocket = {
    emit(event: string, ...args: unknown[]): void;
    on(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener?: (...args: unknown[]) => void): void;
  };
  let socket: BridgeSocket | undefined;
  let currentThread: { id?: string; _id?: string; serverId?: string; channelId?: string; [key: string]: unknown } | null;
  function sendThreadMessage(...args: unknown[]): void;
  function cssColor(value?: unknown): string;
  function initials(value?: unknown): string;
  function formatText(value?: unknown): string;
  function openDm(userId: string, displayName?: string, avatarColor?: string): void;
  const rtc: { currentRoomId?: string; isInVoice?: () => boolean; playRemoteSound?: (...args: unknown[]) => void; [key: string]: unknown };
  const currentChannel: { id?: string; _id?: string; serverId?: string; [key: string]: unknown } | null;
  function closeMobilePanels(): void;
  const BridgeRegistry: import('../core/bridge-registry.ts').BridgeRegistry;
}

declare global {
  interface ImportMeta { env?: Record<string, string | boolean | undefined>; }
  interface RTCSessionDescriptionInit { toJSON?: () => unknown; }
}
