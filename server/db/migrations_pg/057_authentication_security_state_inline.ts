/** Startup mirror for strict persisted TOTP secret/backup-code state. */
export const TWO_FACTOR_SECURITY_FUNCTIONS: string[] = [
  `CREATE OR REPLACE FUNCTION bridge_valid_totp_secret(value text)
   RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
     SELECT char_length(value) BETWEEN 16 AND 134
        AND value ~ '^[A-Za-z2-7]{16,128}={0,6}$'
   $$`,
  `CREATE OR REPLACE FUNCTION bridge_valid_two_factor_backup(value jsonb)
   RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
   DECLARE item jsonb; code text;
   BEGIN
     IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 32 THEN RETURN FALSE; END IF;
     FOR item IN
       SELECT value_item
       FROM jsonb_array_elements(value) AS items(value_item)
     LOOP
       IF jsonb_typeof(item) <> 'string' THEN RETURN FALSE; END IF;
       code := item #>> '{}';
       IF char_length(code) NOT BETWEEN 8 AND 128 THEN RETURN FALSE; END IF;
     END LOOP;
     RETURN TRUE;
   END $$`,
];

/** Startup/clean-install mirror for the structured X3DH JSONB invariants. */
export const X3DH_SECURITY_INVARIANTS: string[] = [
  `CREATE OR REPLACE FUNCTION bridge_valid_x3dh_signed_prekey(value jsonb)
   RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
   DECLARE key_id_text text;
   BEGIN
     IF jsonb_typeof(value) <> 'object'
        OR value - 'keyId' - 'publicKey' - 'signature' <> '{}'::jsonb
        OR jsonb_typeof(value->'keyId') <> 'number'
        OR jsonb_typeof(value->'publicKey') <> 'string'
        OR jsonb_typeof(value->'signature') <> 'string' THEN RETURN FALSE; END IF;
     key_id_text := value->>'keyId';
     RETURN key_id_text ~ '^(0|[1-9][0-9]{0,9})$'
        AND key_id_text::bigint <= 2147483647
        AND char_length(value->>'publicKey') BETWEEN 1 AND 256
        AND char_length(value->>'signature') BETWEEN 1 AND 512;
   END $$`,
  `CREATE OR REPLACE FUNCTION bridge_valid_x3dh_otpks(value jsonb)
   RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
   DECLARE
     item jsonb; key_id_text text; key_id bigint; public_key text;
     seen_ids bigint[] := ARRAY[]::bigint[]; seen_keys text[] := ARRAY[]::text[];
   BEGIN
     IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 100 THEN RETURN FALSE; END IF;
     FOR item IN
       SELECT value_item
       FROM jsonb_array_elements(value) AS items(value_item)
     LOOP
       IF jsonb_typeof(item) <> 'object'
          OR item - 'keyId' - 'publicKey' <> '{}'::jsonb
          OR jsonb_typeof(item->'keyId') <> 'number'
          OR jsonb_typeof(item->'publicKey') <> 'string' THEN RETURN FALSE; END IF;
       key_id_text := item->>'keyId';
       IF key_id_text !~ '^(0|[1-9][0-9]{0,9})$' THEN RETURN FALSE; END IF;
       key_id := key_id_text::bigint; public_key := item->>'publicKey';
       IF key_id > 2147483647 OR char_length(public_key) NOT BETWEEN 1 AND 256
          OR key_id = ANY(seen_ids) OR public_key = ANY(seen_keys) THEN RETURN FALSE; END IF;
       seen_ids := array_append(seen_ids, key_id); seen_keys := array_append(seen_keys, public_key);
     END LOOP;
     RETURN TRUE;
   END $$`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_otpks_array_check`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_bundle_valid`,
  `ALTER TABLE users ADD CONSTRAINT users_x3dh_bundle_valid CHECK (
     bridge_valid_x3dh_otpks("x3dhOneTimePreKeys") IS TRUE
     AND ("x3dhSignedPreKey" IS NULL OR bridge_valid_x3dh_signed_prekey("x3dhSignedPreKey"))
     AND ("x3dhIdentityKey" IS NULL OR char_length("x3dhIdentityKey") BETWEEN 1 AND 256)
   )`,
];
