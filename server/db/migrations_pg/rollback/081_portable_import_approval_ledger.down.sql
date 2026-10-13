-- Destructive rollback: all pending and consumed consent evidence is discarded.
-- Never run this rollback as part of a live migration/apply operation.
DROP TABLE IF EXISTS portable_import_approvals;
