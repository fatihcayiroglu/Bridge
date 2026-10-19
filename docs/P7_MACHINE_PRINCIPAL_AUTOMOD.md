# P7 — machine principal AutoMod link exemptions (#300)

Status: **implementation in draft PR #307; not accepted or merged until exact-head CI and security tests pass.**

## Principals and moderation

Human sends use `checkMessageContent` (P7 spam/link-host, mention limits, AutoMod roles and timeouts).
Machine sends use `machineContentRefused`: `bot:<id>` replies, `webhook:<id>` incoming webhook text and bounded embeds, and `plugin:<id>` posts. Machines have no member roles or member timeout. Any matched AutoMod rule rejects before persistence; configured moderation events are logged. Bridge's own system/audit posts are outside this policy to avoid recursion. E2EE ciphertext is not inspected.

Cross-server relays are machine principals of the **receiving** server (2026-10-19): a channel bridge copy is `bridge:<bridgeId>` and an announcement crosspost is `crosspost:<sourceChannelId>`. Before, the copy passed only the source server's AutoMod, although creating a bridge or follow needs only channel-management permissions while AutoMod is managed with `MANAGE_SERVER`. A match refuses that copy only (the source message stays, other followers are unaffected); a rule-store failure skips the copy (fail closed); the crosspost result reports a bounded per-follower reason. The bridge relays the stored text, never the raw payload. No integration exemption can name a relay principal. Evidence: `server/tests/cross-server-relay-automod.test.ts`.

All AutoMod rules and the P7 content limits match the **visible** text: the C0/C1 control characters storage strips and Unicode format characters (zero-width space/joiners, soft hyphen, bidi controls, BOM) are removed before matching, without changing what is stored. Before, `forbidden\u0001word` passed AutoMod on the channel send and edit paths and was stored and shown as `forbiddenword`. Evidence: `server/tests/automod-invisible-character-evasion.test.ts`.

## Exact-installation exemptions

Only enabled `link_filter` rules can exempt named bots or incoming webhooks, never all bots, plugins, roles, channels, other rules or a server globally. An authorized member holding `MANAGE_SERVER` sends a *principal list*, never an installation ID. The server looks up current live installations before saving a record `{principal, installationId}`.

- Server-owned bot identity: active bot's own immutable ID.
- Cross-server installed bot: current `serverBots` link row ID; remove/reinstall creates a different ID.
- Incoming webhook: current webhook ID, provided its stored server ID matches the channel's live server ID.
- A moved channel, removed bot, removed server-bot link, stale webhook, unknown ID or plugin cannot gain a grant.
- At message ingress the trusted server resolves the current installation again. A link rule is skipped only on exact principal **and** installation ID equality. No human role or other rule is skipped.
- Rules are loaded from the shared AutoMod store for each message; no instance-local exemption cache.
- Invalid persisted entries make policy enforcement throw (fail closed). A moderator cannot submit forged binding objects.
- Rule changes write bounded audit entries containing rule type and added/removed principal IDs, never credentials or words.

The API `GET /api/servers/:sid/automod/integrations` returns a credential-free current roster for managers. The Automation settings picker appears only on link filter rules and saves principal IDs only.

## Evidence gates before merge

The new backend and HTTP tests and the six new Svelte picker tests must pass with existing suites, TypeScript checking, i18n parity, coverage gates and no hidden skips. Exercise failed/raced webhook scope checks, install rotation, cross-server denial, revocation, unauthorized manager writes and denied persistence. Do not report exact-head success before GitHub checks conclude.

**Remaining release boundaries:** #209 Android root cause and real hardware, P7 #205 portability product/release acceptance, and remaining P7 B3/B4/B5/D1–D3 closure gates are independent; merging this PR does not close P7.
