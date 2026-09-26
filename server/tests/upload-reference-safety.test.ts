import {
  hasLiveUploadReference,
  normalizeUploadKey,
  storageDeleteKey,
} from '../lib/uploadReferenceSafety';

describe('uploadReferenceSafety', () => {
  describe('normalizeUploadKey', () => {
    it('accepts canonical Bridge-generated upload keys', () => {
      expect(normalizeUploadKey('uploads/abc-123_file.png')).toBe('uploads/abc-123_file.png');
      expect(normalizeUploadKey('uploads/server-assets/abc123.webp')).toBe('uploads/server-assets/abc123.webp');
    });

    it.each([
      '',
      '/uploads/file.png',
      'other/file.png',
      'uploads/../secret.txt',
      'uploads/./file.png',
      'uploads//file.png',
      'uploads\\file.png',
      'uploads/file name.png',
      'uploads/stickers/historical.svg',
    ])('rejects non-canonical or protected key %p', (value) => {
      expect(normalizeUploadKey(value)).toBeNull();
    });
  });

  it('normalizes physical delete keys per provider root', () => {
    expect(storageDeleteKey('uploads/a/b.png', 'local')).toBe('a/b.png');
    expect(storageDeleteKey('uploads/a/b.png', 's3')).toBe('uploads/a/b.png');
    expect(storageDeleteKey('uploads/a/b.png', 'r2')).toBe('uploads/a/b.png');
  });

  it('checks canonical message/media reference tables before deletion', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ referenced: true }] });

    await expect(hasLiveUploadReference({ query }, 'uploads/file.png')).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('messages');
    expect(sql).toContain('dm_messages');
    expect(sql).toContain('group_dm_messages');
    expect(sql).toContain('server_gifs');
    expect(sql).toContain('server_emojis');
    expect(sql).toContain('soundboard');
    expect(sql).toContain('voice_messages');
    expect(sql).toContain('sticker_pack_items');
    expect(sql).toContain('podcast_settings');
    expect(sql).toContain('"audioUrl" FROM podcast_episodes');
    expect(sql).toContain("'/uploads/' || filename FROM podcast_episodes");
    expect(params).toEqual([
      'uploads/file.png',
      '/uploads/file.png',
      '%/uploads/file.png',
    ]);
  });

  it('returns false only when the database proves no live reference exists', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ referenced: false }] });
    await expect(hasLiveUploadReference({ query }, 'uploads/file.png')).resolves.toBe(false);
  });

  it('fails closed when the reference query fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(hasLiveUploadReference({ query }, 'uploads/file.png'))
      .rejects.toThrow('database unavailable');
  });
});
