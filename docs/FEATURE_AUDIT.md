# Bridge Feature Audit

**Date:** 2026-08-23 · **Method:** import-graph reachability (static + dynamic)
from the production entry points, cross-checked against server routes and tests.

A feature is only counted as **shipped** when it is reachable from
`client/js/app.ts`, has a user-facing entry point, and talks to a real backend.

---

## Shipped and reachable

| Feature | Client surface | Backend | Notes |
|---|---|---|---|
| Messaging | `MessageInputPanel`, `MessageListPanel`, `MessageRenderer` | Socket.IO `message:*` | Ack + outbox + offline replay |
| Threads | `MessageRenderer` → `threads.ts` | `/api/threads` | |
| Reactions | `MessageRenderer` quick set | `message:react` | Curated 6-emoji set by design |
| Message permalinks | `MessageRenderer` copy action + hash router | — | Phase K+ |
| DMs | `DmPanel` | `dm:*`, `/api/dm` | |
| Group DMs | `GroupDmPanel` | `gdm:*` | |
| Attachments | `MessageInputPanel` (drag/drop, paste) | `/api/upload` + `file:send` | |
| Emoji composer | `EmojiPickerPanel` | — (embedded data) | Phase K |
| Drafts | `DraftManager` | localStorage | Per channel |
| Slash commands | `slash.ts` | `/api/commands` | |
| Global search | `GlobalSearchPanel` | `/api/search/unified` | 4 stores, index-aligned; filters + **context previews** (Phase K+/5) |
| In-server search | `SearchPanel` | `/api/search` | Messages / channels / members |
| Notification prefs | `NotificationPrefsPanel` | `/api/notification-prefs` | Per-channel + server, snooze |
| Inbox | `InboxPanel` | `/api/inbox` | |
| Saved messages | `SavedPanel` | `/api/saved` | |
| Voice | `VoicePanel`, `shell-voice-controls` | `voice:*`, mediasoup w/ P2P fallback | **Unverified by humans** |
| Voice diagnostics | `VoiceCheckPanel` | — (local `getStats`) | No IP/ICE/credential exposure |
| Screen share | `VoicePanel` | `voice:*` | Video only — **system audio is ABSENT**, see below |
| Server settings | `ServerSettingsModal` (9 tabs) | `/api/servers/:id/*` | Incl. Audit Log, **Moderation** |
| Moderation | `ModerationTab` | `/api/servers/:id/bans`, `/members/:id/{kick,timeout}` | Phase K+ |
| Channel permissions | `channel-perms/` editor | `/api/channels/:id/permissions` | Per-channel overrides |
| Member profiles | `MemberProfilePopover` | `/api/users/:id` | |
| Friends | `FriendsPanel` | `/api/friends` | |
| Discover | `DiscoverPanel` | `/api/discover` | |
| Invites | `InvitePanel` | `/api/invites` | |
| Command palette | `CommandPalettePanel` | — | Ctrl/Cmd+K |
| Onboarding wizard | `OnboardingWizard` | — | Tour + flow were phantoms, deleted |
| Themes | `ThemeManager` | localStorage | Light / dark / high-contrast |
| i18n | `i18n-dom.ts` | — | 10 languages |
| Offline | `OfflineBanner` + outbox | — | Replay on reconnect |
| E2EE toggle | `E2EEToggle` | `/api/e2ee` | |
| Federation | `federation-ui.ts` | ActivityPub | |

---

## WIRE — real implementations, no entry point

| Feature | Evidence | Effort | Value |
|---|---|---|---|
| **DM calling** | `DmCallPanel` (387 lines), registers `startDmCall`/`hangUpDmCall` | Medium | High — Discord parity |
| **Unread counts** | `UnreadBadge` owns `setChannelUnread`/`getUnreadCount`/`getMentionCount`; **zero callers** | Medium | High — daily attention signal |
| **Slow mode indicator** | `SlowModeIndicator` owns `setSlowMode`; backend enforces, UI silent | Low | Medium |
| **Message translation** | `TranslateButton`, 4 API calls | Low | Medium |

---

## ARCHIVE

| Component | Reason |
|---|---|
| `VoiceControlBar` | Superseded by reachable `shell-voice-controls.ts` |
| `_archived_legacy/` | Pre-Svelte sources, retained for reference, not built |

---

## DELETE — done

82 hollow components + 71 mount shims removed. See
[PHANTOM_COMPONENT_FINAL_AUDIT.md](PHANTOM_COMPONENT_FINAL_AUDIT.md).

---

## Known incomplete surfaces

| Area | Gap |
|---|---|
| Server settings | Members tab shipped; **no Analytics tab** (see ABSENT below) |
| ~~Search~~ | ~~Filters not surfaced; no context preview~~ — **CLOSED**: filters surfaced in `GlobalSearchPanel`, context previews shipped via `/api/search/context` (permission-enforced, plain text) |
| Composer | No GIF search |
| Social | No blocking UI; presence states beyond online/offline not selectable |
| Voice | **No human verification** — see [VOICE_HUMAN_VERIFICATION.md](VOICE_HUMAN_VERIFICATION.md) |
| ~~Scale~~ | ~~Redis not provisioned → single instance only~~ — **CLOSED**: two instances verified against shared Redis/Postgres, 6/6 (`e2e/multi-instance-check.mjs`) |
| Mobile | Capacitor kabuğu VAR (iOS + Android projeleri, native push, deep link, kamera, biyometri). Final20'de kabuk ÜRETİM yolundan yeniden kuruldu ve tarayıcıda mobil görünümde AÇILDIĞI doğrulandı; **gerçek cihazda doğrulanmadı** (iOS için macOS gerekir). Ayrıntı: FINDINGS F20-004 |
| ~~E2E~~ | ~~Playwright cannot run — no database~~ — **CLOSED**: 263 passing, 0 failing, deterministic across 5 consecutive runs |


---

## ABSENT — named in code, never actually present (Phase K+/7)

These are **not** "unfinished": working implementations existed and were replaced
during the *Sprint 116 → Svelte 5* migration with identical 50-line empty shells
that kept the feature's name and its `showX` entry point. The originals sit in
`client/_archived_legacy/js_core_legacy/`. Every shell had **zero callers**, so
nothing regressed when they were deleted — the product simply stopped *claiming*
these features.

| Feature | Archived source | Status |
|---|---|---|
| Analytics dashboard | `analytics-dashboard.ts` (433 lines) | ABSENT |
| Announcements / crosspost | `announcement-ui.ts` | ABSENT |
| Server boost | `boost.ts` (298) + `boost-ui.ts` | ABSENT |
| Desktop voice bar | `desktop-voice-bar.ts` (179) | ABSENT |
| Stage video grid | `stage-video-grid.ts` | ABSENT |
| Native push registration | via `mobile-ux` | ABSENT |
| Screen-share **system audio** | never implemented in either engine | ABSENT — the UI offered it (`Ses Dahil`, checked by default) but neither `webrtc.ts` nor `webrtc-sfu.ts` ever attached the audio track to a peer or producer. The capture is no longer requested; the control is disabled and labelled honestly. Implementing it properly requires separating screen audio from microphone audio in the remote-audio map (keying it per source), otherwise the sharer's microphone would be replaced by their system audio. |

`VoiceSettingsTab` was in the same set but is **superseded, not absent**: real
voice settings (device pickers + input sensitivity) live in
`settings/tabs/DevicesTab.svelte`.

Full evidence: [PHANTOM_COMPONENT_FINAL_AUDIT.md](PHANTOM_COMPONENT_FINAL_AUDIT.md).

---

## Duplicate implementations

| Concern | Canonical owner | Note |
|---|---|---|
| Channel selection | `ChannelListManager.navigateToChannel` | Search results and permalinks both delegate here — no second navigator |
| Voice controls | `VoicePanel` (`voicePanel:*`) | `shell-voice-controls.ts` mirrors, does not own |
| Search | Two surfaces by design | Global (4 stores) vs in-server (channels/members). Candidate for merge with a scope filter |
| Settings | `SettingsModal` (user) vs `ServerSettingsModal` (server) | Distinct scopes, correct |
