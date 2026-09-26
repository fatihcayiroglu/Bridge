-- Rollback 055 — remove only constraints owned by the numbered convergence
-- migration.  The E2EE/X3DH columns are also part of the canonical base schema
-- (db/postgres/schema.ts). A rollback must therefore never destroy live key material
-- in those columns or their data. Re-applying 055 restores the
-- named constraints after validating/repairing the retained values.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_otpks_array_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2e_algorithm_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2e_key_version_check;
