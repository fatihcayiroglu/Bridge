#!/usr/bin/env bash
# backup/scheduler.sh — runs backup.sh once a day at BACKUP_AT (HH:MM, container TZ).
#
# Final21 Faz 19: the image used to run `crond -f` (dcron) as PID 1. Under the production
# hardening (read-only root, cap_drop ALL, no-new-privileges) it looped on
# "setpgid: Operation not permitted" and never ran a job; a cron daemon also switches identity
# before each job, which needs CAP_SETGID. This loop needs no privilege change: it runs as the
# container user, logs to stdout (visible in `docker logs`) and writes only to /backups.
# PID 1 is the compose `init` (tini), which forwards signals and reaps children.
set -u

BACKUP_AT="${BACKUP_AT:-02:30}"
case "$BACKUP_AT" in
  [0-2][0-9]:[0-5][0-9]) ;;
  *) echo "[scheduler] invalid BACKUP_AT='$BACKUP_AT' (expected HH:MM)" >&2; exit 64 ;;
esac

run_backup() {
  local rc=0
  /usr/local/bin/backup.sh || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "[scheduler] $(date) backup finished"
  else
    # A failed run is reported loudly and retried at the next slot; the scheduler keeps running.
    # (rc is captured first: `$(date)` in the message would reset `$?`.)
    echo "[scheduler] $(date) BACKUP FAILED (exit $rc)" >&2
  fi
}

if [ "${BACKUP_RUN_ON_START:-false}" = "true" ]; then
  run_backup
fi

while true; do
  now=$(date +%s)
  target=$(date -d "$BACKUP_AT" +%s)
  [ "$target" -le "$now" ] && target=$((target + 86400))
  echo "[scheduler] next backup at $(date -d "@$target")"
  sleep $((target - now)) &
  wait $!
  run_backup
done
