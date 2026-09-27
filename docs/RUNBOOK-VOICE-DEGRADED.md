# RUNBOOK — VOICE DEGRADED

**Severity:** SEV-2 (text messaging unaffected).

Voice is an **optional** dependency. Its failure must never take down chat.

---

## Symptoms

- Users cannot join voice rooms, or join and hear nothing
- `bridge_voice_rooms` drops to 0 while users report trying to connect
- Clients report ICE failures or stuck "connecting"

## First check: is the blast radius contained?

```bash
curl -s /api/health                      # expect 200 — text must be unaffected
curl -s /metrics | grep bridge_voice_rooms
```

If `/api/health` is `503`, this is **not** a voice incident — see
`RUNBOOK-REDIS-OUTAGE.md` or `RUNBOOK-DATABASE-RESTORE.md`.

## Checks

1. **SFU (mediasoup) process** — running? consuming CPU? out of ports?
2. **TURN server** — reachable? Credentials valid and unexpired?
   Without TURN, users behind symmetric NAT cannot connect at all while users on
   open networks work fine — a confusing "works for some people" pattern.
3. **UDP path** — voice needs UDP; a firewall change that blocks it produces exactly
   this symptom while HTTP stays healthy.
4. **Client-side** — microphone permission denied looks identical to a server fault
   from the user's side. Confirm with a second client on a different network.

## Recovery

| Cause | Action |
|---|---|
| SFU worker or node down | The worker pool restarts a dead worker by itself. Clients re-establish their media session automatically (measured in the P2 media lab: ~19 s after a worker death or an owner-node restart, ~27 s after an owner-node crash — the 30 s owner lease must expire first). A client that cannot recover within 90 s leaves the call and is told so. Restart a node only if it does not come back. |
| TURN credentials expired | Rotate and redeploy (`TURN_*`, see `CONFIGURATION.md`). |
| TURN server restarted | Relayed calls re-establish by themselves (lab: ~15 s after TURN is back). |
| UDP blocked | Restore firewall rules. With TURN configured, SFU media relays through it (TURN over TCP when UDP is blocked; `FORCE_TURN=true` makes clients relay-only). |
| SFU resource exhaustion | Scale up, or cap concurrent rooms. |

Text, DMs, uploads and Soundboard metadata continue working throughout. Do **not**
restart the Bridge application to fix voice — that converts a SEV-2 into a SEV-1.

## Verify

- Two clients join the same voice room from different networks
- Both hear each other
- Mute / unmute / deafen behave
- Leave and rejoin cleanly; no stale peer remains in the room
- `bridge_voice_rooms` reflects reality

## Honest limitation

Bridge's voice stack has **not** been validated under real multi-network conditions
or on physical devices. The P2 media lab (`scripts/medialab`, `docs/MEDIA_RELIABILITY.md`)
proves real packets end to end — two nodes, real mediasoup, real coturn, real Chromium
clients behind synthetic WAN impairment — but it is one host, Chromium only, fake
capture devices and synthetic impairment; perceptual quality needs human validation.

For the controlled private beta, treat voice as **experimental**: expect to gather
first real evidence from beta users rather than to rely on it.

## Escalate when

- Voice failure coincides with elevated HTTP errors → not a voice-only incident
- Restarting the SFU does not restore service → suspect network/firewall
- Users report audio from the *wrong* room → stop voice entirely and investigate;
  a cross-room leak is a privacy incident, not a quality issue
