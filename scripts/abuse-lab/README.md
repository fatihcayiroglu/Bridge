# Abuse lab (P7 B1)

Controlled abuse **and** the legitimate behaviour that looks like it, run against
a disposable cluster of real processes, so every anti-abuse control is judged
by both what it stops and what it costs.

Topology (reuses `scripts/multinode/lib`): two Bridge nodes
(`node server/dist/index.js`, `NODE_ENV=production`, `BRIDGE_MULTI_NODE=true`)
sharing one PostgreSQL and one Redis. Every simulated person has a stable
client address and alternates between the two nodes, so any counter that is
not cluster-wide shows up as a leak.

```sh
cd server && npm ci && npm run build && cd ..
python -m pip install 'moto[server]==5.2.3'
MN_MOTO_SERVER=moto_server node scripts/abuse-lab/run.mjs                    # everything
MN_MOTO_SERVER=moto_server node scripts/abuse-lab/run.mjs --scenarios raid,legit_surge
MN_MOTO_SERVER=moto_server node scripts/abuse-lab/run.mjs --gate             # enforce expectations.json
```

Options: `--scenarios a,b`, `--out DIR`, `--label NAME`, `--work DIR`,
`--base-port N`, `--keep`, `--client-replay paced|burst` (`burst` reproduces the
pre-P7 client that replayed its whole outbox at once).

Output: `report.json` / `report.md` — every scenario's outcome, the numbers
behind it, and node CPU time / RSS and Redis key/memory deltas per scenario.

## Outcomes

| Kind | Outcome | Meaning |
|---|---|---|
| attack | `BLOCKED` | the abusive effect did not land (bounded, small accepted count) |
| attack | `LIMITED` | a per-actor limit slowed it, but the effect still landed |
| attack | `OPEN` | no control engaged |
| control | `OK` | every legitimate action succeeded without a warning or delay |
| control | `FRICTION` | everything succeeded, with a warning or a short automatic delay (≤ 10 s) |
| control | `FALSE_POSITIVE` | a legitimate action failed, was muted, or waited > 10 s |
| — | `INFO` | environment facts |

Without `--gate` the exit code is 0: a baseline run *reports* gaps. With
`--gate` the run fails when a control is `FALSE_POSITIVE` (unless
`expectations.json` names it as a documented, accepted trade-off) or an attack
is weaker than the floor recorded there — so a mitigation cannot silently
regress.

## Scenarios

| Id | Scenario | Kind |
|---|---|---|
| ATK-01 | one account fires 40 unique messages at once | attack |
| ATK-02 | identical text every 1.4 s (under the 4 s duplicate window) | attack |
| ATK-03 | varied spam to one site every 900 ms (under the burst window) | attack |
| ATK-04a / b | one message mentioning 26 members; one victim pinged every 900 ms | attack |
| ATK-05 | one account opens 40 new DM conversations | attack |
| ATK-06 | join/leave one community 15 times | attack |
| ATK-07 | one member creates 25 invites | attack |
| ATK-08 | 60 fresh accounts from 60 addresses join one community (invite + public) and post | attack |
| ATK-09 | 20 ackIds replayed 5× within 1 s | attack |
| LEG-01 | 4 short messages in 3 s | control |
| LEG-02.* | a fast typist: 8 short lines every 700 / 1000 / 1500 ms (production client model) | control |
| LEG-03 | 12-person active chat for 45 s | control |
| LEG-04.* | reconnect replays 5 / 10 / 25 messages typed offline | control |
| LEG-05 | 25 already-delivered messages whose ACK was lost are replayed | control |
| LEG-06 | a slow client resends one message 4× | control |
| LEG-07 | one person joins 3 communities in ~10 s | control |
| LEG-08 | 25 established accounts join within 15 s | control |
| LEG-09 | an owner bans 40 raid accounts back-to-back | control |
| LEG-10 | 40 established accounts join within 10 s (crosses the raid threshold) and post | control |
| LEG-11 | 40 brand-new accounts join within 10 s and post; a moderator ends raid mode; they post again | control |
| LEG-12 | one explicit mention of one member: the message lands and exactly one mention notification arrives (ported from #127 LEG-03) | control |
| LEG-13 | 5 DMs in an existing conversation, 1.1 s apart (ported from #127 LEG-04) | control |
| LEG-14 | DMs to 3 new recipients, 1.5 s apart (ported from #127 LEG-05) | control |

The client model mirrors `MessageInputPanel`: a burst/link refusal holds the
message and everything typed after it until the server's retry time, then
releases one per second; a reconnect replays its backlog through the same 1 s
release. Established accounts are fixture accounts whose `createdAt` is moved
30 days back with SQL (fixture shaping only).

## What this is and is not evidence of

It is real-process, real-database, two-node evidence of how the shipped limits
behave against the scripted patterns above, with numbers. It is not production
traffic, not an adversary adapting to the limits, not a multi-host network, and
not proof that unlisted abuse patterns are covered. Measured results and their
limitations are recorded in `docs/P7_TRUST_SOCIAL_FOUNDATION.md` (§ B1 evidence).
