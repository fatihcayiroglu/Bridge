import {
  humanSize,
  localDateTimeValue,
  safeMutationError,
  safeScheduledRow,
  uploadErrorText,
} from '../js/core/message-input-utils.ts';

describe('message input pure helpers', () => {
  it('validates scheduled rows fail-closed', () => {
    expect(safeScheduledRow(null)).toBeNull();
    expect(safeScheduledRow({ _id: 's1', channelId: 'c1', content: 'x', sendAt: '1000' }))
      .toEqual({ _id: 's1', channelId: 'c1', content: 'x', sendAt: 1000 });
    expect(safeScheduledRow({ _id: 's1', channelId: '', content: 'x', sendAt: 1000 })).toBeNull();
  });

  it('keeps mutation and upload copy bounded by product-owned mappings', () => {
    expect(safeMutationError('AUTOMOD_BLOCKED')).toContain('moderasyon');
    expect(safeMutationError('INTERNAL_STACK_TRACE')).not.toContain('INTERNAL_STACK_TRACE');
    expect(uploadErrorText(413)).toBe('Dosya çok büyük.');
    expect(uploadErrorText(599)).toBe('Yükleme başarısız. Lütfen tekrar dene.');
  });

  it('formats deterministic size buckets and local datetime controls', () => {
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(2048)).toBe('2 KB');
    expect(humanSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(localDateTimeValue(Date.UTC(2026, 0, 2, 3, 4))).toMatch(/^2026-01-02T/);
  });
});
