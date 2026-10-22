/**
 * P7 D2 x B5 (migration 090): record, when a channel is claimed by the expiry
 * worker or deleted, whether any permission override hid it (denied
 * VIEW_CHANNELS). The overrides are deleted with the channel; afterwards the
 * moderation routes read only this value:
 *   'open'       — server-level VIEW_CHANNELS + MANAGE_MESSAGES may review
 *                  the gone channel's reports;
 *   'restricted' / NULL — ADMIN only (a private channel never becomes
 *                  readable to moderators it hid from).
 * Only NULL rows are written, so the value reflects the channel at the moment
 * it went away. Any deny row counts, whatever its tenant, so a corrupt row
 * errs towards 'restricted'. Cost is bounded by that channel's report count
 * (idx_message_reports_channel_open).
 */
/**
 * PERMS.VIEW_CHANNELS. Not imported: lib/permissions loads the repositories, and
 * ChannelRepository loads this module. tests/report-channel-visibility.test.ts pins the value.
 */
export const VIEW_CHANNELS_BIT = 1 << 0;

export type ReportChannelVisibility = 'open' | 'restricted';

export const RECORD_REPORT_CHANNEL_VISIBILITY_SQL = `
  UPDATE message_reports r
     SET "channelVisibility" = CASE WHEN EXISTS (
           SELECT 1 FROM channel_permissions p
            WHERE p."channelId" = $1 AND (p.deny & $3) <> 0)
         THEN 'restricted' ELSE 'open' END
   WHERE r."channelId" = $1 AND r."serverId" = $2 AND r."channelVisibility" IS NULL`;

export interface VisibilityQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Run inside the transaction that claims or deletes the channel, before its overrides go. */
export async function recordReportChannelVisibility(db: VisibilityQueryable, channelId: string, serverId: string): Promise<void> {
  await db.query(RECORD_REPORT_CHANNEL_VISIBILITY_SQL, [channelId, serverId, VIEW_CHANNELS_BIT]);
}

/** Read the recorded value; anything else (NULL, legacy, corrupt) is not 'open'. */
export function reportChannelVisibility(row: Record<string, unknown> | null | undefined): ReportChannelVisibility | null {
  const value = row?.channelVisibility;
  return value === 'open' || value === 'restricted' ? value : null;
}
