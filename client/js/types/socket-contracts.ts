export interface ClientSocketEvents {
  'message:new': (payload: { _id: string; channelId: string; content: string }) => void;
  'user:status': (payload: { userId: string; status: string }) => void;
  'error:ratelimit': (payload: { event: string; message: string }) => void;
}

export interface ServerSocketEvents {
  'message:send': (payload: { channelId: string; content: string }) => void;
  'dm:send': (payload: { conversationId: string; content: string }) => void;
  'typing:start': (payload: { channelId: string }) => void;
}
