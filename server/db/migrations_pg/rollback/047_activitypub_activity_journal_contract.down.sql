-- 047_activitypub_activity_journal_contract.down.sql
-- Conservative rollback. The actor/type/activity/note/published columns existed
-- in historical inline upgrades and can contain live ActivityPub data; dropping
-- them (or restoring targetUserId NOT NULL) would make outbound rows invalid and
-- destroy data. Older Bridge code safely ignores these additive columns.

DROP INDEX IF EXISTS idx_ap_activities_activity_id;
DROP INDEX IF EXISTS idx_ap_activities_target;
DROP INDEX IF EXISTS idx_ap_activities_type;
DROP INDEX IF EXISTS idx_ap_activities_actor;
