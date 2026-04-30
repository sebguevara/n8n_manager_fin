#!/usr/bin/env bash
# Chefin v3 — full deploy orchestrator.
# Build JSONs → run tests → start stack → apply schema → import workflows →
# auto-link sub-workflow ID → re-import agent → activate.
#
# Usage:
#   bash scripts/deploy.sh                # full deploy
#   bash scripts/deploy.sh --skip-tests   # skip tests (faster local iteration)
#   bash scripts/deploy.sh --no-up        # don't touch docker compose state
#   bash scripts/deploy.sh --build-only   # just regenerate JSONs and exit
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_TESTS=0
NO_UP=0
BUILD_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=1 ;;
        --no-up)      NO_UP=1 ;;
        --build-only) BUILD_ONLY=1 ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1. Build the 3 workflow JSONs
# ---------------------------------------------------------------------------
bold "[1/6] Building workflow JSONs"
node build-tools-subworkflow.js > workflows/chefin-tools-v3.json
ok "chefin-tools-v3.json"
node build-error-workflow.js    > workflows/chefin-error-v3.json
ok "chefin-error-v3.json"
node build-agent-workflow.js    > workflows/chefin-agent-v3.json
ok "chefin-agent-v3.json"
node build-cron-workflow.js     > workflows/chefin-cron-v3.json
ok "chefin-cron-v3.json"

# Aseguramos que la carpeta de logs exista en el host (bind-mounted en n8n a
# /data/logs). Sin esto, docker la crearía como root y el contenedor no podría
# escribir.
mkdir -p logs
ok "logs/ ready"

if [ "$BUILD_ONLY" -eq 1 ]; then
    bold "Build complete. Exiting (--build-only)."
    exit 0
fi

# ---------------------------------------------------------------------------
# 2. Bring up the docker stack (postgres → n8n → evolution → ...)
# ---------------------------------------------------------------------------
if [ "$NO_UP" -eq 0 ]; then
    bold "[2/6] Starting docker stack"
    docker compose up -d
    ok "docker compose up -d"

    # Wait for n8n_postgres to be healthy (db-init depends on it)
    echo -n "Waiting for postgres..."
    for i in $(seq 1 30); do
        if docker compose exec -T n8n_postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d postgres' >/dev/null 2>&1; then
            echo " ready."
            break
        fi
        echo -n "."
        sleep 1
    done
else
    bold "[2/6] Skipping docker compose (--no-up)"
fi

# ---------------------------------------------------------------------------
# 3. Apply schema (idempotent)
# ---------------------------------------------------------------------------
bold "[3/6] Applying SQL schema"
docker compose run --rm db-init
ok "schema applied"

# ---------------------------------------------------------------------------
# 4. Run all tests (against the live container)
# ---------------------------------------------------------------------------
if [ "$SKIP_TESTS" -eq 0 ]; then
    bold "[4/6] Running test suites"
    bash tests/run.sh > /tmp/chefin-deploy-sql.log 2>&1
    grep -E "^RESULTS:" /tmp/chefin-deploy-sql.log || (cat /tmp/chefin-deploy-sql.log; err "SQL suite failed"; exit 1)
    ok "SQL suite (31 tests)"

    node tests/agent/test-chunker.mjs > /tmp/chefin-deploy-chunker.log 2>&1
    grep -E "pass · 0 fail" /tmp/chefin-deploy-chunker.log || (cat /tmp/chefin-deploy-chunker.log; err "Chunker tests failed"; exit 1)
    ok "Chunker (10 tests)"

    node tests/sql/test-tool-integration.mjs > /tmp/chefin-deploy-tools.log 2>&1
    grep -E "pass · 0 fail" /tmp/chefin-deploy-tools.log || (cat /tmp/chefin-deploy-tools.log; err "Tool integration failed"; exit 1)
    ok "Tool integration (51 tests)"

    node tests/sql/test-edits.mjs > /tmp/chefin-deploy-edits.log 2>&1
    grep -E "pass · 0 fail" /tmp/chefin-deploy-edits.log || (cat /tmp/chefin-deploy-edits.log; err "Edit operations failed"; exit 1)
    ok "Edit operations (29 tests)"

    node tests/agent/test-error-handler.mjs > /tmp/chefin-deploy-errors.log 2>&1
    grep -E "pass · 0 fail" /tmp/chefin-deploy-errors.log || (cat /tmp/chefin-deploy-errors.log; err "Error handler tests failed"; exit 1)
    ok "Error handler (20 tests)"
else
    bold "[4/6] Skipping tests (--skip-tests)"
fi

# ---------------------------------------------------------------------------
# 5. Wait for n8n container, then import workflows
# ---------------------------------------------------------------------------
bold "[5/6] Importing workflows into n8n"

if ! docker compose ps n8n --format json 2>/dev/null | grep -q '"State":"running"'; then
    err "n8n container is not running. Run: docker compose up -d n8n"
    exit 1
fi

echo -n "Waiting for n8n CLI..."
for i in $(seq 1 60); do
    if docker compose exec -T n8n n8n --version >/dev/null 2>&1; then
        echo " ready."
        break
    fi
    echo -n "."
    sleep 1
done

# Importamos primero los dos "satélites" (tools sub-workflow + error handler)
# porque el agente y el cron los referencian por id.
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-tools-v3.json
ok "imported chefin-tools-v3"

docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-error-v3.json
ok "imported chefin-error-v3"

# Look up workflow ids from n8n's own postgres
lookup_wf_id() {
    local name="$1"
    docker compose exec -T n8n_postgres sh -c "PGPASSWORD=\$POSTGRES_PASSWORD psql -t -A -U \$POSTGRES_USER -d n8n -c \"SELECT id FROM workflow_entity WHERE name = '$name' ORDER BY \\\"updatedAt\\\" DESC LIMIT 1\"" | tr -d '\r\n'
}

TOOLS_ID=$(lookup_wf_id 'Chefin Agent Tools v3')
ERROR_ID=$(lookup_wf_id 'Chefin Error Handler v3')

if [ -z "$TOOLS_ID" ]; then
    err "Could not find imported tools sub-workflow id. Check n8n manually."
    exit 1
fi
if [ -z "$ERROR_ID" ]; then
    err "Could not find imported error handler workflow id. Check n8n manually."
    exit 1
fi
ok "tools sub-workflow id: $TOOLS_ID"
ok "error handler id:      $ERROR_ID"

# Splice ids into agent + cron JSONs, then import them
node apply-tools-id.js --tools "$TOOLS_ID" --error "$ERROR_ID"
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-agent-v3.json
ok "imported chefin-agent-v3 with ids linked"

docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-cron-v3.json
ok "imported chefin-cron-v3 with error id linked"

# ---------------------------------------------------------------------------
# 6. Activate the 4 workflows
# ---------------------------------------------------------------------------
# IMPORTANTE: en n8n 2.18 `update:workflow` está deprecado y NO acepta --name.
# Solo acepta --id o --all. Por eso usamos los IDs estables que ponemos en los
# JSONs (`id` field de cada wf). Después de activar hay que reiniciar n8n
# porque el CLI advierte: "Changes will not take effect if n8n is running."
bold "[6/6] Activating workflows"
ANY_ACTIVATED=0
for wf_id in chefin_tools_v3 chefin_error_v3 chefin_cron_v3 chefin_agent_v3; do
    if docker compose exec -T n8n n8n update:workflow --id="$wf_id" --active=true >/tmp/chefin-activate.log 2>&1; then
        ok "activated: $wf_id"
        ANY_ACTIVATED=1
    else
        cat /tmp/chefin-activate.log
        warn "could not auto-activate '$wf_id' — toggle it in the n8n UI"
    fi
done

# Reiniciar n8n para que los cambios de active=true tomen efecto
if [ "$ANY_ACTIVATED" -eq 1 ]; then
    bold "Restarting n8n so activations take effect"
    docker compose restart n8n
    echo -n "Waiting for n8n to come back..."
    for i in $(seq 1 60); do
        if docker compose exec -T n8n n8n --version >/dev/null 2>&1; then
            echo " ready."
            break
        fi
        echo -n "."
        sleep 1
    done
    ok "n8n restarted"
fi

bold "Done."
echo ""
echo "Next steps (manual, one-time):"
echo "  1. Open n8n UI and verify credentials are linked on each node"
echo "     (Postgres / OpenAI / Redis / Evolution)"
echo "  2. Deactivate any old v1/v2 workflows on the same webhook path"
echo "  3. Point Evolution API to: http://n8n:5678/webhook/chefin"
