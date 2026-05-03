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
#   bash scripts/deploy.sh --purge-db     # ⚠️  DROP + recreate 'expenses' DB
#                                         #     (borra todas las transacciones,
#                                         #     categorías, memoria, etc.)
#                                         #     Pide confirmación interactiva
#                                         #     escribiendo "expenses".
#   bash scripts/deploy.sh --purge-db --yes
#                                         # Skip confirmation prompt (CI use)
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_TESTS=0
NO_UP=0
BUILD_ONLY=0
PURGE_DB=0
YES=0
for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=1 ;;
        --no-up)      NO_UP=1 ;;
        --build-only) BUILD_ONLY=1 ;;
        --purge-db)   PURGE_DB=1 ;;
        --yes|-y)     YES=1 ;;
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
# 1. Clean previous JSONs and rebuild the 4 workflow files (tools, error,
#    agent, cron) desde cero. El clean-workflows borra los 4 outputs conocidos
#    para que un workflow eliminado no quede como JSON huérfano en el repo.
# ---------------------------------------------------------------------------
bold "[1/6] Cleaning + rebuilding workflow JSONs"
node scripts/clean-workflows.js
node build-tools-subworkflow.js > workflows/chefin-tools-v3.json
ok "chefin-tools-v3.json"
node build-error-workflow.js    > workflows/chefin-error-v3.json
ok "chefin-error-v3.json"
node build-agent-workflow.js    > workflows/chefin-agent-v3.json
ok "chefin-agent-v3.json"
node build-cron-workflow.js     > workflows/chefin-cron-v3.json
ok "chefin-cron-v3.json"

# Aseguramos que las carpetas de logs existan en el host (bind-mounted en n8n
# a /data/logs). Sin esto, docker las crea como root y el contenedor no puede
# escribir. memory-snapshots la usa el cron diario para backups JSONL.
mkdir -p logs logs/memory-snapshots
ok "logs/ + logs/memory-snapshots/ ready"

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
# 2.5. Purge expenses DB (only with --purge-db). DESTRUCTIVE.
#      Hace DROP + CREATE de la base 'expenses' y limpia los datos del usuario
#      (transacciones, categorías, presupuestos, memoria semántica, etc.).
#      No toca 'n8n' (workflows + credenciales) ni 'evolution' (sesiones de
#      WhatsApp). Después corre el step 3 normal y db-init reaplica el schema
#      sobre la base vacía.
# ---------------------------------------------------------------------------
if [ "$PURGE_DB" -eq 1 ]; then
    bold "⚠️  --purge-db: DROP + recreate 'expenses' database"
    echo "   Esto borra TODAS las transacciones, categorías, presupuestos,"
    echo "   recurrentes, grupos, tags, memoria semántica y settings del usuario."
    echo "   La base 'n8n' (workflows/credenciales) y 'evolution' (WhatsApp)"
    echo "   quedan intactas."
    if [ "$YES" -eq 0 ]; then
        printf "   Escribí 'expenses' (sin comillas) para confirmar: "
        read -r confirm
        if [ "$confirm" != "expenses" ]; then
            err "Confirmación inválida ('$confirm'). Aborting."
            exit 1
        fi
    else
        warn "skipping confirmation (--yes)"
    fi

    # Mata las conexiones abiertas a 'expenses' antes de DROP (si quedó algún
    # cliente colgado, DROP DATABASE falla con "is being accessed by other
    # users"). Luego drop + create. db-init reaplicará el schema en step 3.
    docker compose exec -T n8n_postgres sh -c \
        'PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d postgres -v ON_ERROR_STOP=1' \
        <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'expenses' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS expenses;
CREATE DATABASE expenses;
SQL
    ok "'expenses' database dropped and recreated (empty)"
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

    # Helper: corre un test redirigiendo a un log; si falla (exit code O ausencia
    # del marker esperado), DUMP del log + error. Antes esto estaba en líneas
    # sueltas y `set -e` mataba el script ANTES de poder volcar el log, dejando
    # al usuario sin pista de qué se rompió.
    run_test() {
        local label="$1" cmd="$2" log="$3" marker="$4"
        if ! eval "$cmd" >"$log" 2>&1; then
            echo "----- $label log -----"
            cat "$log"
            echo "----- end log -----"
            err "$label failed (non-zero exit). See full log at $log"
            exit 1
        fi
        if ! grep -qE "$marker" "$log"; then
            echo "----- $label log -----"
            cat "$log"
            echo "----- end log -----"
            err "$label finished but marker '$marker' not found. See $log"
            exit 1
        fi
    }

    run_test "SQL suite"             "bash tests/run.sh"                       /tmp/chefin-deploy-sql.log       "^RESULTS:"
    SQL_RESULT=$(grep -E "^RESULTS:" /tmp/chefin-deploy-sql.log | head -1)
    ok "SQL suite ($SQL_RESULT)"

    run_test "Chunker tests"         "node tests/agent/test-chunker.mjs"       /tmp/chefin-deploy-chunker.log   "pass · 0 fail"
    ok "Chunker tests"

    run_test "Tool integration"      "node tests/sql/test-tool-integration.mjs" /tmp/chefin-deploy-tools.log    "pass · 0 fail"
    ok "Tool integration (51 tests)"

    run_test "Edit operations"       "node tests/sql/test-edits.mjs"           /tmp/chefin-deploy-edits.log     "pass · 0 fail"
    ok "Edit operations (29 tests)"

    run_test "Error handler tests"   "node tests/agent/test-error-handler.mjs" /tmp/chefin-deploy-errors.log    "pass · 0 fail"
    ok "Error handler (20 tests)"

    run_test "Multi-user isolation"  "node tests/sql/test-isolation.mjs"       /tmp/chefin-deploy-isolation.log "pass · 0 fail"
    ok "Multi-user isolation (23 tests)"
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

# Borramos los workflows previos antes de re-importar para garantizar estado
# limpio. Sin esto, los runs anteriores pueden dejar duplicados con el mismo
# NOMBRE pero ids autogenerados distintos, y los triggers viejos siguen
# disparando en paralelo con los nuevos. Estrategia: lookup por nombre →
# desactivar vía CLI → DELETE crudo en workflow_entity. n8n declara
# ON DELETE CASCADE en webhook_entity, shared_workflow, workflow_statistics,
# workflow_history y execution_entity → execution_data, así que un solo
# DELETE limpia todas las dependencias. Los triggers en memoria del proceso
# n8n se sueltan en el restart del paso 6.
# (No usamos `n8n delete:workflow`: ese subcomando no existe en la CLI.)
bold "Purging previous Chefin workflows from n8n"
lookup_ids_by_name() {
    local name="$1"
    docker compose exec -T n8n_postgres sh -c \
        "PGPASSWORD=\$POSTGRES_PASSWORD psql -t -A -U \$POSTGRES_USER -d n8n -c \"\
            SELECT id FROM workflow_entity WHERE name = '$name'\"" \
        | tr -d '\r' | grep -v '^$' || true
}
delete_workflow_by_id() {
    local wid="$1"
    docker compose exec -T n8n_postgres sh -c \
        "PGPASSWORD=\$POSTGRES_PASSWORD psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d n8n -c \"\
            DELETE FROM workflow_entity WHERE id = '$wid'\""
}
for wf_name in 'Chefin Agent Tools v3' 'Chefin Error Handler v3' 'Chefin Agent v3' 'Chefin Cron v3 (consolidated)'; do
    ids=$(lookup_ids_by_name "$wf_name")
    if [ -z "$ids" ]; then
        ok "no previous '$wf_name' to delete"
        continue
    fi
    while IFS= read -r wid; do
        [ -z "$wid" ] && continue
        # Desactivar primero para que el trigger se baje antes del delete.
        docker compose exec -T n8n n8n update:workflow --id="$wid" --active=false >/dev/null 2>&1 || true
        if delete_workflow_by_id "$wid" >/tmp/chefin-purge.log 2>&1; then
            ok "deleted '$wf_name' (id: $wid)"
        else
            cat /tmp/chefin-purge.log
            err "failed to delete '$wf_name' (id: $wid)"
            exit 1
        fi
    done <<< "$ids"
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
