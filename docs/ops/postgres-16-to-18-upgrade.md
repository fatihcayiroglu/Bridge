# PostgreSQL 16 to 18 Production Upgrade Runbook

## Important

Do not attach an existing PostgreSQL 16 data volume directly to a PostgreSQL 18 container.

For production, use a maintenance window and use dump/restore into a fresh PostgreSQL 18 volume.

## Pre-checks

    docker compose ps
    docker compose exec postgres pg_isready
    docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select version();"
    docker compose images postgres

## Backup

Create a backup directory and dump the PostgreSQL 16 database:

    mkdir -p backups/postgres
    BACKUP_FILE="backups/postgres/bridge_pg16_$(date +%Y%m%d_%H%M%S).dump"

    docker compose exec -T postgres pg_dump \
      -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" \
      -Fc \
      --no-owner \
      --no-acl \
      > "$BACKUP_FILE"

    ls -lh "$BACKUP_FILE"

## Stop application writes

Stop application containers that write to the database:

    docker compose stop server

Take a final backup:

    FINAL_BACKUP_FILE="backups/postgres/bridge_pg16_final_$(date +%Y%m%d_%H%M%S).dump"

    docker compose exec -T postgres pg_dump \
      -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" \
      -Fc \
      --no-owner \
      --no-acl \
      > "$FINAL_BACKUP_FILE"

    ls -lh "$FINAL_BACKUP_FILE"

## Preserve old PostgreSQL 16 volume

Do not delete the old PostgreSQL 16 volume.

    docker volume ls | grep bridge
    docker compose stop postgres

Keep the old volume until PostgreSQL 18 has been fully verified.

## Start PostgreSQL 18 with a fresh volume

Update compose images from:

    postgres:16-alpine

to:

    postgres:18-alpine

Start PostgreSQL only:

    docker compose up -d postgres
    docker compose exec postgres pg_isready
    docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select version();"

Confirm the version is PostgreSQL 18 before restore.

## Restore

Restore the final backup into the PostgreSQL 18 database:

    docker compose exec -T postgres pg_restore \
      -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" \
      --clean \
      --if-exists \
      --no-owner \
      --no-acl \
      < "$FINAL_BACKUP_FILE"

## Post-upgrade maintenance

Run analyze:

    docker compose exec postgres psql \
      -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" \
      -c "VACUUM ANALYZE;"

Bridge uses full-text search. During the maintenance window, run a controlled reindex:

    docker compose exec postgres psql \
      -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" \
      -c "REINDEX DATABASE \"$POSTGRES_DB\";"

## Start application

    docker compose up -d
    docker compose ps

Check health and logs:

    curl -fsS http://localhost:3000/health || true
    docker compose logs --tail=200 server

## Rollback

If restore or validation fails:

1. Stop app and PostgreSQL 18.
2. Restore compose image to postgres:16-alpine.
3. Reattach the preserved PostgreSQL 16 volume.
4. Start PostgreSQL 16 and the app.
5. Verify application health.

Never delete the PostgreSQL 16 volume until PostgreSQL 18 has been verified in production.
