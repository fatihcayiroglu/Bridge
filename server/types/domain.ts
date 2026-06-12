export interface UserEntity {
  _id: string;
  username: string;
  displayName?: string;
  tokenVersion?: number;
  status?: 'online' | 'offline' | 'idle' | 'dnd';
}

export interface ChannelEntity {
  _id: string;
  serverId: string;
  name: string;
  type: 'text' | 'voice' | 'stage' | string;
}

export interface MessageEntity {
  _id: string;
  channelId: string;
  serverId?: string;
  userId: string;
  content: string;
  createdAt: number;
}

export interface RepoResult<T> {
  ok: boolean;
  data?: T;
  error?: string | Error;
}
