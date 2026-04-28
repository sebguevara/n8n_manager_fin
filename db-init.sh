#!/bin/sh
# Idempotent DB bootstrap — runs on every `docker compose up`.
# Creates each database in POSTGRES_MULTIPLE_DATABASES if missing,
# and applies schema.sql to `expenses` only when it has no user tables yet.
set -eu

export PGPASSWORD="$POSTGRES_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h n8n_postgres -U $POSTGRES_USER"

echo "[db-init] waiting for postgres..."
until pg_isready -h n8n_postgres -U "$POSTGRES_USER" -d postgres >/dev/null 2>&1; do
    sleep 1
done

echo "[db-init] ensuring databases exist: $POSTGRES_MULTIPLE_DATABASES"
for db in $(echo "$POSTGRES_MULTIPLE_DATABASES" | tr ',' ' '); do
    exists=$($PSQL -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'")
    if [ "$exists" = "1" ]; then
        echo "  -> '$db' already exists, skipping"
    else
        echo "  -> creating '$db'"
        $PSQL -d postgres -c "CREATE DATABASE \"$db\""
        $PSQL -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE \"$db\" TO \"$POSTGRES_USER\""
    fi
done

echo "[db-init] applying schema.sql to expenses (idempotent)"
$PSQL -d expenses -f /schema.sql

# Apply migrations (idempotent — they all use IF NOT EXISTS / CREATE OR REPLACE)
if [ -d /migrations ]; then
    echo "[db-init] applying migrations from /migrations"
    for mig in $(ls /migrations/*.sql 2>/dev/null | sort); do
        echo "  -> $mig"
        $PSQL -d expenses -f "$mig" >/dev/null
    done
fi

echo "[db-init] done"
