# Phantom Component Audit — Final

**Executed:** 2026-08-23 · **Scope:** `client/js/core`

## Summary

| Metric | Before | After |
|---|---:|---:|
| Core components | 131 | **59** |
| Phantom components | 86 | **14** |
| — unreachable | 76 | **4** |
| — reachable but hollow | 10 | **10** |
| Files removed | — | **153** |
| ESLint warnings (client) | 120 | **100** |
| `svelte-check` files scanned | 482 | **339** |

Nothing regressed: 1869 client tests, 3349 server tests, typecheck, `svelte-check`
(0 errors / 0 warnings), build and bundle budget all pass after the cleanup.

---

## What a "phantom" is here

A file that carries a feature's **name** and nothing else. Formally, all three
must hold:

1. ≤ 60 lines,
2. zero server calls (`apiFetch` / `/api/`),
3. the only registry keys it claims are `showX` / `hideX`.

These came from a mechanical conversion pass ("Sprint 116 — ADR-0008 Faz 3")
that created empty Svelte shells named after features and stopped. They are not
broken features — they were never features. `AuditLogPanel.svelte` was 51 empty
lines while the *real* audit log lived, working, inside the server-settings modal.

That is the danger these files pose: they mislead anyone reading the repository,
including an auditor. They caused exactly one wrong finding in the previous audit.

---

## Evidence gathered before any deletion

Every candidate was checked against **six independent signals**. A single hit
blocked deletion:

| Check | Method |
|---|---|
| Static import | `from '…/X.svelte'` or `import '…/X.svelte'` anywhere in `client/js`, `e2e/`, tests |
| Dynamic import | `import('…/X.svelte')` — added after the first pass proved the settings modal loads this way |
| Registry consumer | any file referencing a key the component registers |
| Event consumer | any file dispatching/listening to a `bridge:*` event it owns |
| HTML / global | `index.html` referencing its id, class or `data-bridge-action` |
| Test dependency | any test file mentioning it |

The analyzer wrote a machine-readable verdict so the deletion step could not
drift from the evidence.

**Result:** 86 candidates → 77 with zero hits, 9 blocked.

Each of the 9 was then inspected by hand:

| Component | Blocking evidence | Verdict |
|---|---|---|
| `StagePanel` | Static import from `channel-stage-svelte.ts` (reachable) | **KEEP** |
| `StickerPanel` | Static import from `stickers/StickerOpener.svelte` | **KEEP** |
| `SettingsManager` | Static import from `server-settings-svelte.ts` | **KEEP** |
| `SettingsModalBridge` | `tests/SettingsModalPhase9.test.ts` **imports its shim** | **KEEP** |
| `BoostPanel` | Mentioned in a comment only | DELETE |
| `WebPushManager` | Mentioned in a comment only | DELETE |
| `OfflineQueue` | Mentioned in a comment only | DELETE |
| `ReactionPicker` | Mentioned in a comment only | DELETE |
| `ModerationPanel` | Mentioned in a comment only | DELETE |

---

## The over-deletion, and how it was caught

The first deletion pass removed 88 files. **The build immediately failed** with
10 unresolved imports.

Cause: the 10 *reachable* phantoms have mount shims that do more than mount —
they also export real utilities the app depends on (`getAPI`,
`bindGroupDmSocketEvents`, `initStageVideoGrid`, `onNativePushLogin`). Deleting
the hollow component broke the shim; the shim could not be deleted because the
app imports it.

All 10 components were restored from the archive. This is why the
"reachable phantom" count stayed at 10: **the correct fix is a refactor —
separate the utilities from the mount shim — not a deletion.** That work is
listed as follow-up, not done here.

A second pass then removed 65 **orphan shims**: mount shims importing a
component that no longer existed. A shim in that state is broken by definition,
regardless of what mentions it (the only references were from
`_archived_legacy/`, itself dead code).

---

## Classification

### DELETE — 82 components + 71 shims (executed)

Empty shells, zero server calls, no reachable import path, no consumer:

`ActivitiesPanel`, `ActivityPanel`, `AdvancedSearchPanel`, `AiPanel`,
`AiStreamingPanel`, `AnalyticsTracker`, `AriaManager`, `AuditLogPanel`,
`AuthManager`, `AuthRevokedNotice`, `AutomodPanel`, `AutomodUIPanel`,
`BadgeDisplay`, `BridgeButton`, `BridgeMisc`, `BridgeSelect`, `CalendarPicker`,
`CanvasEditor`, `ChannelPermSync`, `ClipsPanel`, `DiscordImportPanel`,
`DiscordImportStyles`, `DiscordUIKit`, `DmReadTracker`, `E2EVoicePanel`,
`EmbedRenderer`, `ForumPanel`, `GoLivePanel`, `GroupDmManagerPanel`,
`GroupDmVoicePanel`, `ImageViewerPanel`, `IpBanPanel`, `KeyboardNavManager`,
`LayoutPrefs`, `MentionAutocomplete`, `MessageScroll`, `MiscUI`, `MobileAdapter`,
`ModerationPanel`, `NoiseSuppressionControl`, `OfflineQueue`, `OnboardingFlow`,
`OnboardingTour`, `OutgoingWebhooksPanel`, `PartialsManager`, `ProfilePopup`,
`ReactionPicker`, `ScheduledEventsPanel`, `SearchHighlight`, `SentryClient`,
`ServerEventsPanel`, `ServerPanel`, `ServerProfilePanel`, `ServerSettingsManager`,
`ServerTemplatesAdmin`, `SocketEventBus`, `SoundboardPanel`, `SuperReactionPanel`,
`ThemeSelector`, `ThemeStyles`, `ThreadArchivePanel`, `UIManager`,
`UploadManager`, `UserConnectionsPanel`, `VideoQualitySelector`,
`VirtualScrollList`, `VoiceActivityIndicator`, `VoiceMessagePlayer`,
`VoiceRecorderPanel`, `VoiceVolumeControl`, `WcagAudit`, `WebPushManager`
(+ 10 temporarily removed and restored, see above).

> **Note on names that sound important.** `UploadManager`, `MentionAutocomplete`,
> `VirtualScrollList` and `NoiseSuppressionControl` were all empty shells. The
> real capabilities live elsewhere and are reachable: uploads in
> `MessageInputPanel`, mention autocomplete and virtual scrolling in the message
> list, noise suppression in `webrtc.ts` constraints. Deleting the shell removed
> a decoy, not a feature.

### KEEP — 4 (hollow but genuinely referenced)

`StagePanel`, `StickerPanel`, `SettingsManager`, `SettingsModalBridge` —
each has a live static import or an importing test. Removing them requires
untangling the importer first.

### KEEP (refactor needed) — 10 reachable phantoms

`AnalyticsDashboard`, `AnnouncementPanel`, `BoostPanel`, `BoostUIPanel`,
`DesktopVoiceBar`, `GlobalsProvider`, `GroupDmCore`, `MobileUXManager`,
`StageVideoGrid`, `VoiceSettingsTab`.

Action: move the real exports out of each `*-svelte.ts` shim into a plain
module, then delete the empty component and the mount call.

### WIRE — real implementations still unreachable

Not phantoms; deliberately untouched by this cleanup.

| Component | Lines | Registry contract | Why it matters |
|---|---:|---|---|
| `DmCallPanel` | 387 | `startDmCall`, `hangUpDmCall` | 1:1 DM calling is absent from the product |
| `TranslateButton` | 91 | — (4 API calls) | Message translation, backend exists |
| `UnreadBadge` | 78 | `setChannelUnread`, `getUnreadCount`, `getMentionCount` | Unread contract has **zero callers** |
| `SlowModeIndicator` | 78 | `setSlowMode`, `startSlowModeCooldown` | Slow mode is enforced server-side, invisible to users |

### ARCHIVE

`VoiceControlBar` (200 lines) — superseded by the reachable
`shell-voice-controls.ts`, which already delegates to `voicePanel:*`. Keeping
both would mean two owners for one control set.

---

## Recovery

Every removed file was copied to an archive directory **before** deletion
(this repository is not under version control, so deletion is otherwise
unrecoverable):

```
%TEMP%\claude\…\scratchpad\phantom-archive\js\core\
```

`deleted-files.json` and `deleted-shims.json` in the same directory list exactly
what was removed.

---

## Regression guard

`client/tests/no-phantom-features.test.ts` now enforces:

- unreachable phantoms ≤ **4** (was 76)
- reachable phantoms ≤ **10**
- a **ratchet**: if the real count drops well below the ceiling, the test fails
  until the ceiling is lowered — so cleanup cannot leave a loose gate behind
- the five surfaces wired in Phases K/K+ (global search, emoji picker,
  notification preferences, moderation tab, permalink router) stay both
  **reachable** and **non-hollow**

The guard follows static *and* dynamic imports. The first version missed
`ModerationTab` because the settings modal loads through two levels of
`await import(...)` — measuring reachability with only static imports produces
false phantoms.

---

# Phase K+/7 — reachable phantoms 10 → 0

The previous round left ten *reachable* phantoms in place with this reasoning:

> the component itself is empty, but its mount shim **also exports real
> utilities** (`getAPI`, `bindGroupDmSocketEvents`, `initStageVideoGrid`,
> `onNativePushLogin`…). Deleting the component breaks the shim, deleting the
> shim breaks the app.

That reasoning did not survive contact with the evidence. Each "utility" was
opened and traced:

| Export | What it actually did | Verdict |
| --- | --- | --- |
| `getAPI` | byte-identical copy of the canonical `globals.ts` export (already used by 8+ modules) | duplicate — `app.ts` repointed to the canonical one |
| `bindGroupDmSocketEvents` | looked up `BridgeRegistry.get('bindGroupDmSocketEvents')`; **nothing registers that key**. Group-DM events are bound by `GroupDmPanel.syncSocketBinding()` | no-op |
| `onNativePushLogin` | called `mountMobileUXManager()` → mounts the empty shell | no-op |
| `initStageVideoGrid` | called `mountStageVideoGrid()` → mounts the empty shell | no-op |
| `applyBoostFeatures` | called `mountBoostPanel()` → mounts the empty shell; **zero consumers** | no-op |

Four of the five "utilities" did nothing at all. The fifth was a duplicate.

## What was removed

Ten empty components and their ten mount shims. Before deleting, the
`showX` registration of every one was counted across `js/` and the HTML shell:

```
showAnalyticsDashboard 0   showGlobalsProvider  0
showAnnouncementPanel  0   showGroupDmCore      0
showBoostPanel         0   showMobileUXManager  0
showBoostUIPanel       0   showStageVideoGrid   0
showDesktopVoiceBar    0   showVoiceSettingsTab 0
```

**Zero callers for all ten.** Each shell registered a visibility toggle nobody
invoked and rendered `{@render children?.()}` — nothing.

Verification after removal: `svelte-check` 0 errors (324 files, was 344),
production build succeeds, client suite 1986 passing, Playwright **259 passed /
0 failed**.

## The real finding: these were not "unfinished", they were *undone*

All ten carry the same header — `Sprint 116 — <name>.ts → Svelte 5 Runes
(ADR-0008 Faz 3)` — and all ten are the same 50-line template. The original
implementations still exist, in `client/_archived_legacy/js_core_legacy/`:

| Feature | Archived implementation | Status |
| --- | --- | --- |
| Analytics dashboard | `analytics-dashboard.ts` (433 lines) | **ABSENT** |
| Announcement / crosspost UI | `announcement-ui.ts` | **ABSENT** |
| Server boost | `boost.ts` (298 lines) + `boost-ui.ts` | **ABSENT** |
| Desktop voice bar | `desktop-voice-bar.ts` (179 lines) | **ABSENT** |
| Stage video grid | `stage-video-grid.ts` | **ABSENT** |
| Native push registration | via `mobile-ux` | **ABSENT** |
| Voice settings tab | `settings-modal-voice.ts` | **SUPERSEDED** — real voice settings live in `settings/tabs/DevicesTab.svelte` (device pickers + input sensitivity) |

The migration replaced working code with a shell that kept the *name* and the
`showX` entry point, so the product read as "feature present" from every angle
except actually opening it. That is the most expensive failure mode in this
repository, and it is why the guard counts shells rather than files.

Deleting the shells does **not** delete these features — they were already gone.
It removes the *pretence*, so the gap is visible and tracked here instead of
being hidden behind a mounted empty div.

`boost-current-owner.test.ts` was removed with its subject: it asserted that
`applyBoostFeatures()` mounts `BoostPanel` — i.e. it pinned the contract of the
no-op. Nothing it covered exists any more.

## Guard, ratcheted

- reachable phantoms ≤ **0** (was 10)
- unreachable phantoms ≤ **4** (unchanged: `SettingsManager`,
  `SettingsModalBridge`, `StagePanel`, `StickerPanel`)
- the inventory floor moved 50 → 40 because the real component count dropped
  49 after deletion. That check exists to prove the *scan works* (if path
  resolution breaks, `components` empties and every phantom assertion passes
  vacuously) — it was lowered because the count fell, not to weaken the gate.
