export type SoundboardScope = 'global' | 'server';

export interface BuiltinSoundboardSound {
  _id: string;
  name: string;
  emoji: string;
  category: string;
  url: `bridge-sound:${string}`;
  scope: 'global';
  createdAt: number;
  uploadedBy: null;
  durationSeconds: number;
  mimeType: 'audio/x-bridge-synth';
  fileSize: 0;
}

/**
 * Trusted, immutable sounds synthesized by the client. The `bridge-sound:`
 * scheme is never accepted from uploads or database rows; only exact IDs in
 * this catalog may be played through the socket handler.
 */
export const BUILTIN_SOUNDBOARD_SOUNDS: readonly BuiltinSoundboardSound[] = Object.freeze([
  Object.freeze({
    _id: 'global:chime', name: 'Chime', emoji: '🔔', category: 'Bridge',
    url: 'bridge-sound:chime', scope: 'global', createdAt: 0, uploadedBy: null,
    durationSeconds: 0.27, mimeType: 'audio/x-bridge-synth', fileSize: 0,
  }),
  Object.freeze({
    _id: 'global:pop', name: 'Pop', emoji: '🪩', category: 'Bridge',
    url: 'bridge-sound:pop', scope: 'global', createdAt: 0, uploadedBy: null,
    durationSeconds: 0.18, mimeType: 'audio/x-bridge-synth', fileSize: 0,
  }),
  Object.freeze({
    _id: 'global:drum', name: 'Drum Hit', emoji: '🥁', category: 'Bridge',
    url: 'bridge-sound:drum', scope: 'global', createdAt: 0, uploadedBy: null,
    durationSeconds: 0.18, mimeType: 'audio/x-bridge-synth', fileSize: 0,
  }),
  Object.freeze({
    _id: 'global:notify', name: 'Notify', emoji: '✨', category: 'Bridge',
    url: 'bridge-sound:notify', scope: 'global', createdAt: 0, uploadedBy: null,
    durationSeconds: 0.18, mimeType: 'audio/x-bridge-synth', fileSize: 0,
  }),
]);

const BY_ID = new Map(BUILTIN_SOUNDBOARD_SOUNDS.map(sound => [sound._id, sound]));

export function findBuiltinSoundboardSound(id: string): BuiltinSoundboardSound | null {
  return BY_ID.get(id) ?? null;
}
