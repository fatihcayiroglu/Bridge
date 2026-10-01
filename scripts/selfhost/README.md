# Self-host evidence harness (P5)

Proves that Bridge installs and operates the documented way — with evidence from
real processes, not from reading the deployment docs.

| Runner | What it runs | Where |
|---|---|---|
| `run.mjs` | the production build (`node server/dist/index.js`, `NODE_ENV=production`) against its **own** PostgreSQL (initdb) and Redis | locally and in CI |
| `compose.mjs` | the real images (`Dockerfile`, `backup/Dockerfile`) and `docker-compose.yml` with a generated `.env` | CI (needs Docker + registry access) |

## Scenarios (`run.mjs`)

| Scenario | Proves |
|---|---|
| `fresh` | empty database → ready; the whole versioned migration chain applied by boot (SH-01); no warn/error about a missing table |
| `smoke` | two users, server, channel, invite, channel message (socket), DM (socket), protected upload — created through the API and read back |
| `restart` | `SIGTERM` → exit 0; restart → ready; every item of the dataset still readable with fresh logins |
| `config` | production refuses to start (exit ≠ 0, never listens, names the variable) on missing/weak secrets, missing Redis, bad URLs, unreachable PostgreSQL |
| `upgrade` | the previous build (`--previous DIR`) installed both ways operators had it — with its documented `migrate-postgres up`, and boot-only as its image did — data created through its API, then this build boots on that database, completes the chain and serves the data |
| `backup` | `backup/backup.sh` (as shipped) → database dropped and recreated empty, uploads deleted → `backup/restore.sh` → uploads copied back → app ready → original logins and data |
| `egress` | every app process ran with `lib/egress-guard.cjs` preloaded; no TCP/TLS connection left the machine during all of the above (with a positive control proving the observer records one) |

```sh
cd server && npm ci && npm run build && cd .. && npm ci && npm run build
# a built checkout of the previous build, e.g. via git worktree
node scripts/selfhost/run.mjs --previous ../bridge-prev
node scripts/selfhost/run.mjs --scenarios fresh,smoke,restart
node scripts/selfhost/compose.mjs            # Docker host only
```

Statuses: `PASS`, `FAIL`, `BLOCKED`, `SKIPPED`, `MEASURED`. Only PASS passes;
`upgrade` without `--previous` is BLOCKED, never PASS; the egress check is
BLOCKED unless the smoke dataset was actually created. Reports: `report.json`,
`report.md` under `--out`; app logs under `<work>/logs`.

Harness-only settings: `RL_REGISTER_MAX`, `MAX_REG_PER_HOUR`, `RL_LOGIN_MAX`
raised for fixture creation from one IP. Everything else is the production
default. CI: `.github/workflows/selfhost-evidence.yml`.

What this is not: a multi-host deployment, TLS termination, object storage
providers, or production data volume.
