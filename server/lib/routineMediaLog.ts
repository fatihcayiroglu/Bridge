import logger from './logger';
import { currentRequestId, runWithRequestContext } from './requestContext';

export type RoutineMediaEvent =
  | { event: 'socket.voice_evicted'; sfu?: boolean }
  | { event: 'socket.voice_access_evicted' }
  | { event: 'socket.voice_publish_revoked'; producers?: number }
  | { event: 'socket.channel_access_evicted'; rooms: number }
  | { event: 'media.expiry_evicted' };

const MESSAGES = {
  'socket.voice_evicted': 'Voice session ended after access revocation.',
  'socket.voice_access_evicted': 'Voice connect permission revoked; live voice session evicted.',
  'socket.voice_publish_revoked': 'Voice publishing ended after permission change.',
  'socket.channel_access_evicted': 'Channel access revoked; live rooms evicted.',
  'media.expiry_evicted': 'Live media ended at channel expiry',
} as const satisfies Record<RoutineMediaEvent['event'], string>;

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Only operational aggregates cross this boundary, including at runtime. */
export function logRoutineMediaInfo(fields: RoutineMediaEvent): void {
  const event: unknown = fields?.event;
  if (typeof event !== 'string' || !Object.hasOwn(MESSAGES, event)) {
    throw new TypeError('Unsupported routine media event');
  }
  const name = event as keyof typeof MESSAGES;
  const input = fields as unknown as Record<string, unknown>;
  const safe: Record<string, unknown> = { event: name };
  if (name === 'socket.voice_evicted') {
    const sfu = input.sfu;
    if (typeof sfu === 'boolean') safe.sfu = sfu;
  }
  if (name === 'socket.voice_publish_revoked') {
    const producers = count(input.producers);
    if (producers !== undefined) safe.producers = producers;
  }
  if (name === 'socket.channel_access_evicted') {
    const rooms = count(input.rooms);
    if (rooms !== undefined) safe.rooms = rooms;
  }
  // Rebuild the record and own the message: structural typing, a DTO's toJSON
  // or a stray interpolated message cannot reintroduce private metadata.
  const emit = () => logger.info(safe, MESSAGES[name]);
  const requestId = currentRequestId();
  if (requestId === undefined) emit();
  else runWithRequestContext({ requestId }, emit);
}
