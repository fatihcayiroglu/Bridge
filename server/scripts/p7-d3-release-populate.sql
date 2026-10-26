-- P7 D3: synthetic rows (no personal data) for a database built by release v1.122.0
-- (boot only). Used with scripts/p7-d3-release-upgrade-probe.ts. Disposable databases only.
INSERT INTO users (_id, username, "displayName", password, "createdAt")
  SELECT 'ru' || g, 'ru' || g, 'R user ' || g, 'x', 1 FROM generate_series(1, 20000) g;
INSERT INTO servers (_id, name, "ownerId", "createdAt")
  SELECT 'rs' || g, 'R server ' || g, 'ru' || g, 1 FROM generate_series(1, 100) g;
INSERT INTO members ("userId", "serverId", "joinedAt")
  SELECT 'ru' || g, 'rs' || (1 + g % 100), 1 FROM generate_series(1, 20000) g;
INSERT INTO channels (_id, "serverId", name, "createdAt")
  SELECT 'rc' || g, 'rs' || (1 + g % 100), 'c' || g, 1 FROM generate_series(1, 5000) g;
INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt", "replyTo")
  SELECT 'rm' || g, 'rc' || (1 + g % 5000), 'rs' || (1 + (g % 5000) % 100), 'ru' || (1 + g % 20000), 'u', 'U',
         'synthetic message ' || g || ' ' || md5(g::text), 1700000000000 + g,
         CASE WHEN g % 10 = 0 AND g > 1 THEN jsonb_build_object('_id', 'rm' || (g - 1), 'displayName', 'U', 'content', 'q') END
  FROM generate_series(1, 2000000) g;
INSERT INTO threads (_id, "channelId", "serverId", "parentMessageId", name, "createdBy", "createdAt", "lastMessageAt")
  SELECT 'rt' || g, 'rc' || (1 + g % 5000), 'rs' || (1 + (g % 5000) % 100), 'rm' || g, 't', 'ru' || (1 + g % 20000), 1, 1
  FROM generate_series(1, 20000) g;
INSERT INTO thread_messages (_id, "threadId", "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
  SELECT 'rtm' || g, 'rt' || (1 + g % 20000), 'rc' || (1 + (1 + g % 20000) % 5000), 'rs' || (1 + ((1 + g % 20000) % 5000) % 100),
         'ru' || (1 + g % 20000), 'u', 'U', 'reply ' || g, 1700000000000 + g
  FROM generate_series(1, 200000) g;
INSERT INTO dm_conversations (_id, participants, "createdAt", "lastMessageAt")
  SELECT 'rd' || g, jsonb_build_array('ru' || g, 'ru' || (g + 1)), 1, 1 FROM generate_series(1, 10000) g;
INSERT INTO dm_messages (_id, "dmId", "userId", "displayName", content, "createdAt")
  SELECT 'rdm' || g, 'rd' || (1 + g % 10000), 'ru' || (1 + g % 10000), 'U', 'dm ' || g, 1700000000000 + g
  FROM generate_series(1, 500000) g;
INSERT INTO notifications (_id, "userId", type, "createdAt")
  SELECT 'rn' || g, 'ru' || (1 + g % 20000), 'mention', 1700000000000 + g FROM generate_series(1, 500000) g;
ANALYZE;
