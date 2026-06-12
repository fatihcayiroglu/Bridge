
export {};

declare global {
  interface Window {
    _flushPendingQueue?: () => unknown | Promise<unknown>;
    _enqueueOfflineMessage?: (message: {
      channelId: string;
      serverId: string;
      content: string;
      [key: string]: unknown;
    }) => unknown;
    currentChannel?: { _id?: string; id?: string; [key: string]: unknown };
    currentServer?: { _id?: string; id?: string; [key: string]: unknown };
    _bridgeVS?: {
      stats: () => {
        total: number;
        inDOM: number;
        windowStart: number;
        windowEnd: number;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
  }
}
