process.env.NODE_ENV = 'test';

const query = jest.fn();
const mockDb = { _pool: { query } };
jest.mock('../db/loader', () => mockDb);

import Messages from '../db/repositories/MessageRepository';

describe('PostgreSQL reaction unique-emoji cap', () => {
  beforeEach(() => query.mockReset());

  it('enforces the 20-key decision inside the atomic UPDATE', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(Messages.toggleReactionAtomic('m1', 'new-emoji', 'u1')).resolves.toBe(false);

    // ── İDDİA YORUMLARI DEĞİL, ÇALIŞTIRILAN SQL'İ ÖLÇMELİ ────────────────
    // Bu test eskiden `jsonb_object_length(` aranmasını istiyordu. O ad
    // PostgreSQL'de YOKTUR — gerçek veritabanı her reaksiyon değişiminde
    //     error: function jsonb_object_length(jsonb) does not exist
    // fırlatıyordu. Yani mock'lanmış "SQL sözleşmesi", PostgreSQL'in
    // REDDETTİĞİ bir sorguyu "doğru" olarak kilitliyordu ve REST + Socket.IO
    // reaksiyon yollarının ikisi de üretimde tamamen bozuktu.
    //
    // Ders: SQL metni üzerinden kurulan bir sözleşme, o SQL'in gerçekten
    // ÇALIŞTIĞINI kanıtlamaz. Bu dosya kontrol akışını ölçmeye devam eder;
    // sorgunun gerçekten geçerli olduğu `tests/pg-integration/` altındaki
    // GERÇEK PostgreSQL süiti ile kanıtlanır.
    const sql = String(query.mock.calls[0][0]);
    // Yorum satırları çıkarılır: iddia PROSA'ya değil ÇALIŞAN SQL'e bakmalı.
    const kod = sql
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');

    expect(kod).not.toMatch(/jsonb_object_length/i);          // var olmayan fonksiyon
    expect(kod).toMatch(/jsonb_object_keys\s*\(/i);            // gerçek fonksiyon
    expect(kod).toMatch(/<\s*20/);
    expect(kod).toMatch(/COALESCE\(reactions,[\s\S]*\?\s*\$2/i);
  });
});
