// server/tests/pg-int8-parser.test.ts
//
// Final21 Faz 19 (19-27) — PostgreSQL BIGINT (int8) ayrıştırıcısı. node-pg BIGINT'i METİN
// döndürüyordu; tipler/OpenAPI/test deposu SAYI modelliyordu. Gerçek veritabanı kanıtı:
// tests/pg-integration/message-history-cursor.pgtest.ts (+ tüm test:pg paketi).

import { types } from 'pg';
import { parseInt8 } from '../db/postgres/pool';

describe('parseInt8', () => {
  it('pg modülüne int8 (OID 20) için KAYITLIDIR', () => {
    expect(types.getTypeParser(20, 'text')).toBe(parseInt8);
  });

  it('güvenli tamsayıları sayıya çevirir (epoch-ms zaman damgaları, sayaçlar)', () => {
    expect(parseInt8('1790328773133')).toBe(1_790_328_773_133);
    expect(parseInt8('0')).toBe(0);
    expect(parseInt8('-42')).toBe(-42);
    expect(parseInt8(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('2^53 üstünü METİN bırakır — hassasiyet ASLA kaybolmaz', () => {
    expect(parseInt8('9007199254740993')).toBe('9007199254740993');
    expect(parseInt8('-9223372036854775808')).toBe('-9223372036854775808');
  });
});
