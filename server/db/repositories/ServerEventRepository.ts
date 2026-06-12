// server/db/repositories/ServerEventRepository.ts
// Sprint 96 — server_events + server_event_rsvp repository katmanı.
// Sprint 97 — serverEvents route db.query() çağrıları bu repository'e taşındı.
//
// Tüm server_events / server_event_rsvp DB erişimi tek noktada toplanır.
// eventReminders job ve serverEvents route bu sınıfı kullanır.

import { pool } from '../postgres/pool';

// ── Tip tanımları ─────────────────────────────────────────────────────────────

export interface EventRow {
  id:          string;
  server_id:   string;
  creator_id:  string;
  title:       string;
  description: string | null;
  location:    string | null;
  channel_id:  string | null;
  starts_at:   Date;
  ends_at:     Date | null;
  status:      'scheduled' | 'active' | 'ended' | 'cancelled';
  cover_image: string | null;
  created_at:  Date;
  updated_at:  Date;
}

export interface EventWithCreatorRow extends EventRow {
  creator_username:     string | null;
  creator_display_name: string | null;
  creator_avatar:       string | null;
  rsvp_count?:          string; // COUNT() → string
  my_rsvp?:             string | null;
}

export interface RsvpRow {
  user_id: string;
}

export interface RsvpDetailRow {
  status:       string;
  created_at:   Date;
  user_id:      string;
  username:     string;
  display_name: string | null;
  avatar:       string | null;
}

export interface CreateEventInput {
  serverId:    string;
  creatorId:   string;
  title:       string;
  description: string | null;
  location:    string | null;
  channelId:   string | null;
  startsAt:    Date;
  endsAt:      Date | null;
  coverImage:  string | null;
}

export type EventStatus = 'scheduled' | 'active' | 'ended' | 'cancelled';

// ── Repository ────────────────────────────────────────────────────────────────

class ServerEventRepository {
  // ── LIST ───────────────────────────────────────────────────────────────────

  /**
   * Sunucudaki etkinlikleri filtre + sayfalama ile döner.
   * @param filter  'upcoming' | 'past' | 'all'
   */
  async findByServer(
    serverId: string,
    userId:   string,
    filter:   'upcoming' | 'past' | 'all',
    limit:    number,
    offset:   number,
  ): Promise<{ events: EventWithCreatorRow[]; total: number }> {
    // Sprint 98: Sabit $1-$7 indeks — whereExtra dinamik parametre kırılganlığı giderildi.
    // Filter durumu null/not-null ile yönetiliyor; PostgreSQL $N::timestamptz IS NULL
    // short-circuit ile verimli çalışır.
    const now = new Date();
    const filterStart = filter === 'upcoming' ? now : null;
    const filterEnd   = filter === 'past'     ? now : null;

    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM server_events e
        WHERE e.server_id = $1
          AND e.status    != 'cancelled'
          AND ($3::timestamptz IS NULL OR e.starts_at >= $3)
          AND ($4::timestamptz IS NULL OR e.starts_at <  $4)`,
      [serverId, 'cancelled', filterStart, filterEnd],
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const eventsRes = await pool.query<EventWithCreatorRow>(
      `SELECT e.*,
              u.username     AS creator_username,
              u.display_name AS creator_display_name,
              u.avatar       AS creator_avatar,
              (SELECT COUNT(*)
                 FROM server_event_rsvp r
                WHERE r.event_id = e.id
                  AND r.status IN ('going','interested')) AS rsvp_count,
              (SELECT r2.status
                 FROM server_event_rsvp r2
                WHERE r2.event_id = e.id AND r2.user_id = $5) AS my_rsvp
         FROM server_events e
         LEFT JOIN users u ON u.id = e.creator_id
        WHERE e.server_id = $1
          AND e.status    != 'cancelled'
          AND ($3::timestamptz IS NULL OR e.starts_at >= $3)
          AND ($4::timestamptz IS NULL OR e.starts_at <  $4)
        ORDER BY e.starts_at ASC
        LIMIT $6 OFFSET $7`,
      [serverId, 'cancelled', filterStart, filterEnd, userId, limit, offset],
    );

    return { events: eventsRes.rows, total };
  }

  // ── FIND ONE ───────────────────────────────────────────────────────────────

  /**
   * Tek etkinlik — creator bilgileriyle birlikte.
   */
  async findOne(eventId: string, serverId: string): Promise<EventWithCreatorRow | null> {
    const res = await pool.query<EventWithCreatorRow>(
      `SELECT e.*,
              u.username     AS creator_username,
              u.display_name AS creator_display_name,
              u.avatar       AS creator_avatar
         FROM server_events e
         LEFT JOIN users u ON u.id = e.creator_id
        WHERE e.id = $1 AND e.server_id = $2`,
      [eventId, serverId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Etkinlik var mı kontrol (sadece id gerektiğinde).
   */
  async exists(eventId: string, serverId: string): Promise<boolean> {
    const res = await pool.query<{ id: string }>(
      'SELECT id FROM server_events WHERE id=$1 AND server_id=$2',
      [eventId, serverId],
    );
    return res.rows.length > 0;
  }

  // ── RSVP ──────────────────────────────────────────────────────────────────

  /**
   * Etkinliğin RSVP listesi — kullanıcı detaylarıyla (max 50).
   */
  async findRsvpList(eventId: string): Promise<RsvpDetailRow[]> {
    const res = await pool.query<RsvpDetailRow>(
      `SELECT r.status, r.created_at,
              u.id AS user_id, u.username, u.display_name, u.avatar
         FROM server_event_rsvp r
         JOIN users u ON u.id = r.user_id
        WHERE r.event_id = $1
        ORDER BY r.created_at ASC
        LIMIT 50`,
      [eventId],
    );
    return res.rows;
  }

  /**
   * Tek kullanıcının RSVP durumu.
   */
  async findMyRsvp(eventId: string, userId: string): Promise<string | null> {
    const res = await pool.query<{ status: string }>(
      'SELECT status FROM server_event_rsvp WHERE event_id=$1 AND user_id=$2',
      [eventId, userId],
    );
    return res.rows[0]?.status ?? null;
  }

  /**
   * RSVP upsert.
   */
  async upsertRsvp(eventId: string, userId: string, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO server_event_rsvp (event_id, user_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, user_id) DO UPDATE SET status=$3, updated_at=NOW()`,
      [eventId, userId, status],
    );
  }

  /**
   * RSVP sil.
   */
  async deleteRsvp(eventId: string, userId: string): Promise<void> {
    await pool.query(
      'DELETE FROM server_event_rsvp WHERE event_id=$1 AND user_id=$2',
      [eventId, userId],
    );
  }

  /**
   * RSVP'si olan kullanıcı sayısı (going + interested).
   */
  async countAttendees(eventId: string): Promise<number> {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM server_event_rsvp
        WHERE event_id=$1 AND status IN ('going','interested')`,
      [eventId],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }

  // ── CREATE / UPDATE / DELETE ───────────────────────────────────────────────

  async create(input: CreateEventInput): Promise<EventRow> {
    const res = await pool.query<EventRow>(
      `INSERT INTO server_events
         (server_id, creator_id, title, description, location,
          channel_id, starts_at, ends_at, cover_image, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled')
       RETURNING *`,
      [
        input.serverId, input.creatorId, input.title,
        input.description, input.location, input.channelId,
        input.startsAt, input.endsAt, input.coverImage,
      ],
    );
    return res.rows[0];
  }

  /**
   * Kısmi güncelleme — sadece verilen alanlar SET edilir.
   * fieldMap: { camelCase key → snake_case DB column }
   */
  async update(
    eventId:  string,
    serverId: string,
    fields:   Record<string, unknown>,
  ): Promise<EventRow | null> {
    const FIELD_MAP: Record<string, string> = {
      title:       'title',
      description: 'description',
      location:    'location',
      channelId:   'channel_id',
      startsAt:    'starts_at',
      endsAt:      'ends_at',
      coverImage:  'cover_image',
      status:      'status',
    };

    const sets: string[] = [];
    const vals: unknown[] = [];

    for (const [key, col] of Object.entries(FIELD_MAP)) {
      if (key in fields) {
        sets.push(`${col} = $${vals.length + 1}`);
        vals.push(fields[key]);
      }
    }
    if (!sets.length) return null; // hiç alan yok

    sets.push('updated_at = NOW()');
    vals.push(eventId, serverId);

    const res = await pool.query<EventRow>(
      `UPDATE server_events
          SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND server_id = $${vals.length}
        RETURNING *`,
      vals,
    );
    return res.rows[0] ?? null;
  }

  async delete(eventId: string, serverId: string): Promise<void> {
    await pool.query(
      'DELETE FROM server_events WHERE id=$1 AND server_id=$2',
      [eventId, serverId],
    );
  }

  // ── JOB (Sprint 96) ───────────────────────────────────────────────────────

  /**
   * Cursor-based sayfalı tarama: belirtilen zaman aralığında başlayacak
   * 'scheduled' etkinlikleri döner. eventReminders job'u kullanır.
   */
  async findScheduledInWindow(
    windowStart: Date,
    windowEnd:   Date,
    afterId?:    string,
    limit = 100,
  ): Promise<EventRow[]> {
    const params: unknown[] = [
      windowStart.toISOString(),
      windowEnd.toISOString(),
    ];

    let cursorClause = '';
    if (afterId !== undefined) {
      params.push(afterId);
      cursorClause = `AND id > $${params.length}`;
    }

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;

    const result = await pool.query<EventRow>(
      `SELECT id, server_id, title, starts_at, channel_id
         FROM server_events
        WHERE status    = 'scheduled'
          AND starts_at BETWEEN $1 AND $2
          ${cursorClause}
        ORDER BY id
        LIMIT ${limitPlaceholder}`,
      params,
    );

    return result.rows;
  }

  /**
   * Bir etkinliğe 'going' veya 'interested' RSVP'si olan kullanıcıları döner.
   * eventReminders job'u kullanır.
   */
  async findAttendees(eventId: string): Promise<RsvpRow[]> {
    const result = await pool.query<RsvpRow>(
      `SELECT user_id
         FROM server_event_rsvp
        WHERE event_id = $1
          AND status IN ('going', 'interested')`,
      [eventId],
    );
    return result.rows;
  }
}

export const ServerEvents = new ServerEventRepository();
