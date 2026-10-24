/** P7 D2 x B5 (migration 090): recorded channel visibility of gone channels' reports. */
import { PERMS } from '../lib/permissions';
import {
  MANAGE_MESSAGES_BIT, RECORD_REPORT_CHANNEL_VISIBILITY_SQL, REVIEW_DENY_MASK, VIEW_CHANNELS_BIT, recordReportChannelVisibility, reportChannelVisibility,
} from '../lib/reportChannelVisibility';

describe('reportChannelVisibility', () => {
  it('uses the real VIEW_CHANNELS and MANAGE_MESSAGES bits (kept local to avoid an import cycle)', () => {
    expect(VIEW_CHANNELS_BIT).toBe(PERMS.VIEW_CHANNELS);
    expect(MANAGE_MESSAGES_BIT).toBe(PERMS.MANAGE_MESSAGES);
    expect(REVIEW_DENY_MASK).toBe(PERMS.VIEW_CHANNELS | PERMS.MANAGE_MESSAGES);
  });

  it('records only unrecorded rows of that channel and tenant, restricted on any VIEW or MANAGE_MESSAGES deny in either override store', async () => {
    const query = jest.fn(async () => ({}));
    await recordReportChannelVisibility({ query }, 'c1', 's1');
    expect(query).toHaveBeenCalledWith(RECORD_REPORT_CHANNEL_VISIBILITY_SQL, ['c1', 's1', PERMS.VIEW_CHANNELS | PERMS.MANAGE_MESSAGES]);
    expect(RECORD_REPORT_CHANNEL_VISIBILITY_SQL).toMatch(/"channelVisibility" IS NULL/);
    expect(RECORD_REPORT_CHANNEL_VISIBILITY_SQL).toMatch(/r\."serverId" = \$2/);
    expect(RECORD_REPORT_CHANNEL_VISIBILITY_SQL).toMatch(/FROM channel_permissions p[\s\S]*\(p\.deny & \$3\) <> 0/);
    expect(RECORD_REPORT_CHANNEL_VISIBILITY_SQL).toMatch(/FROM channel_overrides o[\s\S]*\(o\.deny & \$3\) <> 0/);
  });

  it('treats anything but a recorded value as not open', () => {
    expect(reportChannelVisibility({ channelVisibility: 'open' })).toBe('open');
    expect(reportChannelVisibility({ channelVisibility: 'restricted' })).toBe('restricted');
    for (const value of [null, undefined, 'OPEN', 'public', 1, true]) {
      expect(reportChannelVisibility({ channelVisibility: value })).toBeNull();
    }
    expect(reportChannelVisibility(null)).toBeNull();
    expect(reportChannelVisibility(undefined)).toBeNull();
  });
});
