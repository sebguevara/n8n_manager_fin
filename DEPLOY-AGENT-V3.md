# Chefin v3 — Deploy

Toda la **versión 3** queda en 3 workflows:

| Workflow | Archivo | Propósito |
|---|---|---|
| `chefin_agent_v3` | `workflows/chefin-agent-v3.json` | Webhook + Agente conversacional con tool-calling |
| `chefin_tools_v3` | `workflows/chefin-tools-v3.json` | Sub-workflow con las 24 tools (lo invoca el agente) |
| `chefin_cron_v3` | `workflows/chefin-cron-v3.json` | **Todos** los cron jobs en uno (resumen diario/semanal, recurrentes, cleanup, alertas de presupuesto) |

Reemplaza estos workflows viejos (los podés desactivar/borrar después de validar):
- `Daily Summary Cron`
- `Weekly Summary Cron`
- `Recurring Transactions Processor`
- `chefin` (clasificador rígido v1)

## ¿LangChain? ¿Hay que instalar algo?

**No.** Los nodos `@n8n/n8n-nodes-langchain.*` (Agent, Chat Model, Memory, Tools, Output Parser) ya vienen incluidos en `n8nio/n8n:latest`. Tu instancia 2.18.4 los tiene listos. Lo único que el agente nuevo necesita es:

- **Credentials existentes**: OpenAI account (`0ErbOR5W4QIYaohV`), Postgres (`f8CCpjEZRkcHEaJI`), Redis (`igDqU9rqRBlmVQGc`), Evolution (`FgeqqvxAqTER4oeD`). Las mismas que ya usa el v1.
- **Tabla `n8n_chat_histories`** para la memoria conversacional. **Ya está en `schema.sql`** y se crea sola al aplicar el schema.

Para extensiones futuras (vector store con pgvector, embeddings, RAG sobre histórico) sí harían falta deps adicionales — hoy no.

## Pasos de deploy

### 1. Aplicar el schema actualizado

```bash
docker compose exec -T postgres sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d expenses' < schema.sql
```

Idempotente (todo `CREATE OR REPLACE` / `IF NOT EXISTS`). Agrega:
- 17 funciones SQL del agente (`find_matching_tx_v2`, `query_tx_dynamic`, `get_total_dynamic`, `get_breakdown_dynamic`, `compare_periods`, `find_potential_duplicates`, `bulk_delete_by_ids`, `bulk_update_by_ids`, `bulk_preview`, `remember_last_list`, `get_last_list`, `list_categories_with_counts`).
- Funciones de cron (`log_cron_start`, `log_cron_end`, `purge_old_chat_history`, `purge_expired_conv_states`, `pending_budget_alerts`, `mark_budget_alert_sent`).
- Tablas `n8n_chat_histories`, `cron_runs`, `budget_alert_log`.
- 3 índices nuevos sobre `transactions`.

### 2. Importar los 3 workflows

```bash
# Sub-workflow de tools (importar primero)
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-tools-v3.json

# Cron consolidado
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-cron-v3.json

# Agente principal
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-agent-v3.json
```

Los ids quedan fijos (`chefin_tools_v3`, `chefin_cron_v3`, `chefin_agent_v3`) así que el agente ya viene con la referencia correcta al sub-workflow — **no hace falta correr `apply-tools-id.js`** en esta deploy. Sólo si regenerás `chefin-agent-v3.json` desde el build script vas a necesitar:

```bash
node apply-tools-id.js chefin_tools_v3
```

### 3. Activar y configurar

En n8n:
1. **Activá** `chefin_tools_v3`, `chefin_cron_v3` y `chefin_agent_v3`.
2. **Desactivá** los 4 workflows viejos (`Daily Summary Cron`, `Weekly Summary Cron`, `Recurring Transactions Processor`, `chefin`).
3. En el v3, abrí cada nodo de credentials y verificá que estén bien linkeadas (a veces n8n las pierde después del import).

### 4. Apuntar Evolution API al webhook v3

El agente nuevo escucha en `/webhook/expense-bot-v3`. En tu config de Evolution API, cambiá la URL del webhook hacia el path nuevo. Si querés A/B, podés dejar el viejo activo: solo los teléfonos en `ALLOWED_PHONES` reciben respuesta.

### 5. Smoke tests del agente

Mensajes a tu WhatsApp y respuesta esperada:

| # | Mensaje | Esperado |
|---|---|---|
| 1 | `Mostrame todos mis movimientos` | Lista TODOS los movs (period=all) |
| 2 | `Cuanto gasté este mes?` | Total simple |
| 3 | `En qué gasté más?` | Breakdown por categoría con % |
| 4 | `Comparame este mes vs el pasado` | Comparativa con delta |
| 5 | `Mostrame los gastos de 3300` | Lista numerada con todos los matches |
| 6 | `Borrá el primero` (después de #5) | Resuelve via last_list → delete |
| 7 | `Eliminá los gastos repetidos` | find_duplicates → preview → confirma |
| 8 | `Borrá todos los café del mes pasado` | bulk_preview → confirma |
| 9 | `Tomé 2500 de café` | log + ✅ reaction |
| 10 | `Hola` | Reply breve, sin reacción |
| 11 | `Qué fecha es hoy?` | Fecha directa, sin tools |
| 12 | `Gráfico por categoría del mes` | Imagen con caption |

### 6. Smoke tests del cron

Desde la UI de n8n abrí `chefin_cron_v3`:
1. Editá el nodo `Pick Job` y poné el job a probar (`daily_summary` | `weekly_summary` | `recurring` | `cleanup` | `budget_alerts`).
2. Ejecutá el `Manual Test` trigger.
3. Verificá que se ejecutó:

```sql
SELECT job_name, started_at, finished_at, items_processed, items_sent, success, error_msg
FROM cron_runs ORDER BY started_at DESC LIMIT 10;
```

## Estructura del cron consolidado

```
Cron 22:00 ART        ──┐
Cron Sunday 21:00 ART ──┤
Cron 06:00 ART        ──┤── (cada uno con su Postgres + Format propio)
Cron 03:30 ART        ──┤
Cron cada 4h 09-21    ──┤
Manual Trigger        ──┘── Pick Job → Dispatch (5 ramas)

Daily Summary Query    ─→ Format Daily Summary    ──┐
Weekly Summary Query   ─→ Format Weekly Summary   ──┤
Process Due Recurring  ─→ Format Recurring        ──├─→ Merge ─→ Filter Sendable ─→ Loop Batches ─→ Send WhatsApp ─→ Mark Sent ─→ Wait 400ms ─→ (loop)
Pending Alerts Query   ─→ Format Alerts           ──┘                                              │
Cleanup Postgres       ─→ Format Cleanup ─→ Log End Cleanup                                       └─→ Aggregate Stats ─→ Log End
```

Cada job loguea start/end en `cron_runs` para que tengas trazabilidad.

## Rollback

Si algo se rompe:
1. Desactivá los 3 workflows v3.
2. Reactivá los 4 viejos (`Daily Summary Cron`, `Weekly Summary Cron`, `Recurring Transactions Processor`, `chefin`).
3. Apuntá Evolution al webhook `/expense-bot` (viejo).
4. La data en DB queda intacta — no se borra nada.

## Métricas a vigilar

```sql
-- Últimas 24h de cron
SELECT job_name, COUNT(*) AS runs,
       AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))::INT AS avg_seconds,
       SUM(items_sent) AS total_sent,
       SUM(CASE WHEN success THEN 0 ELSE 1 END) AS failures
FROM cron_runs
WHERE started_at > NOW() - INTERVAL '1 day'
GROUP BY job_name ORDER BY job_name;

-- Tamaño de la memoria conversacional
SELECT session_id, COUNT(*) AS msgs, MAX(created_at) AS last
FROM n8n_chat_histories GROUP BY session_id ORDER BY msgs DESC LIMIT 10;

-- Conv states activos
SELECT user_id, state, expires_at FROM conversation_state
WHERE expires_at > NOW() ORDER BY expires_at;
```

## Tuning

Editá los build scripts y regenerá:
```bash
node build-tools-subworkflow.js > workflows/chefin-tools-v3.json
node build-agent-workflow.js   > workflows/chefin-agent-v3.json
node build-cron-workflow.js    > workflows/chefin-cron-v3.json
```

Re-importar en n8n (sobreescribe por id).
