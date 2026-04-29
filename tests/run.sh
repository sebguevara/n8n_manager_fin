#!/bin/sh
# Runs the SQL test suite against the local Postgres container.
# Usage: ./tests/run.sh
#
# Each test file gets the test user UUID via the `uid` psql variable.
# Tests fail fast: any RAISE EXCEPTION aborts the run with non-zero exit.

set -e
cd "$(dirname "$0")"

PG_CONTAINER="${PG_CONTAINER:-n8n_postgres}"
DB="${DB:-expenses}"
PSQL="docker compose -f ../docker-compose.yml exec -T $PG_CONTAINER sh -c 'PGPASSWORD=\$POSTGRES_PASSWORD psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d $DB'"

echo "=== Running setup ==="
SETUP_OUT=$(eval "$PSQL" < sql/00_setup.sql 2>&1)
echo "$SETUP_OUT"
UID_VAL=$(echo "$SETUP_OUT" | grep -oE 'SETUP_UID=[a-f0-9-]+' | head -1 | cut -d= -f2)
if [ -z "$UID_VAL" ]; then
    echo "ERROR: setup did not emit UUID"
    exit 1
fi
echo "Test user UID: $UID_VAL"

PASS=0
FAIL=0
FAILED=""

for f in sql/[0-9][0-9]_*.sql; do
    case "$f" in
        sql/00_setup.sql|sql/99_cleanup.sql) continue ;;
    esac
    echo "--- $f ---"
    # Pass UID as psql variable
    if eval "docker compose -f ../docker-compose.yml exec -T $PG_CONTAINER sh -c 'PGPASSWORD=\$POSTGRES_PASSWORD psql -v ON_ERROR_STOP=1 -v uid=$UID_VAL -U \$POSTGRES_USER -d $DB'" < "$f" 2>&1 | tee /tmp/chefin_test.log; then
        if grep -q "PASS " /tmp/chefin_test.log; then
            PASS=$((PASS + 1))
        else
            FAIL=$((FAIL + 1))
            FAILED="$FAILED $f"
        fi
    else
        FAIL=$((FAIL + 1))
        FAILED="$FAILED $f"
    fi
done

echo ""
echo "=== Cleanup ==="
eval "$PSQL" < sql/99_cleanup.sql

echo ""
echo "==========================================="
echo "RESULTS: $PASS passed, $FAIL failed"
if [ -n "$FAILED" ]; then
    echo "Failed tests:$FAILED"
    exit 1
fi
echo "ALL TESTS PASSED ✅"
