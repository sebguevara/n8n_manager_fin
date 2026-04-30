# Chefin v3 — Deploy

4 workflows + 1 schema. Pasos en orden, todo idempotente. Para deploy en una sola corrida: `npm run deploy`.

| Workflow | Archivo | Propósito |
|---|---|---|
| `chefin_agent_v3` | `workflows/chefin-agent-v3.json` | Webhook + Router + 3 sub-agents (Transaction / Config / Insights) + chitchat fast path |
| `chefin_tools_v3` | `workflows/chefin-tools-v3.json` | Sub-workflow con tools (lo invoca el agente) |
| `chefin_cron_v3` | `workflows/chefin-cron-v3.json` | Cron consolidado (resumen diario/semanal, recurrentes, cleanup, alertas, memory snapshot, session summary, stale review) |
| `chefin_error_v3` | `workflows/chefin-error-v3.json` | Error handler global — disparado por `settings.errorWorkflow` del agente y del cron |

Reemplaza estos workflows viejos:
- `Daily Summary Cron`, `Weekly Summary Cron`, `Recurring Transactions Processor`, `chefin` (clasificador rígido v1).

## Arquitectura v3 (resumen)

```
WhatsApp ─→ Webhook ─→ [media/audio/PDF/text] ─→ Bootstrap user ─→ Concat
        ─→ Detect Heavy ─→ "Aguardame" (heavy ops) ─→ Router LLM ─→ Switch by intent
        ─→ ┬─ Transaction Agent (19 tools)  ───┐
           ├─ Config Agent (41 tools)         ─┤─→ Parse Output ─→ Chunk Reply (multi-mensaje) ─→ Send WhatsApp
           ├─ Insights Agent (18 tools)       ─┤
           └─ Chitchat (sin agente)           ─┘

(cualquier nodo que reviente) ─→ chefin_error_v3 ─→ ┬─ JSONL log a /data/logs/errors-YYYY-MM-DD.jsonl
                                                    └─ reply amable al usuario por Evolution API
```

Highlights:
- **Sub-agents con prompt caching**: cada specialist tiene system prompt estático que OpenAI cachea automáticamente. Costo y latencia ~50% menos en mensajes 2+.
- **Memoria conversacional**: window de 20 turnos en `n8n_chat_histories` (subido de 12).
- **Memoria semántica (pgvector) robusta**:
  - Tools del agente: `remember_fact` / `recall_memory` / `update_memory` / `forget_memory` / `list_memories`.
  - Ranking híbrido en search: `similarity*0.7 + recency*0.2 + recall_count*0.1`.
  - `add_memory_chunk` detecta contradicciones (sim 0.85-0.94) y devuelve `contradicts_ids` para que el agente decida update/coexistir/preguntar.
  - Audit log en `memory_chunk_versions` para todo update/forget/reembed/stale.
  - Cron diario `session_summary` condensa los turnos del día en un fact (preserva contexto que sale del window de 20).
  - Cron diario `memory_snapshot` exporta JSONL a `./logs/memory-snapshots/` (backup independiente del volumen Postgres).
  - Cron semanal `memory_stale_review` marca facts viejos sin uso como `__stale__`.
  - Campo `embedding_model` en cada chunk + función `reembed_memory_chunk` para migración gradual a modelos futuros.
- **Conversation state versionado**: `set_conv_state_if_match` con optimistic lock para flujos críticos.
- **Error handler global**: cualquier falla del agente o del cron dispara `chefin_error_v3` que loggea a JSONL en `./logs/` y le manda un mensaje amable al usuario.
- **Multi-mensaje chunker**: respuestas largas con secciones distintas (`\n\n`) se mandan como mensajes WhatsApp separados con typing-indicator entre cada uno.
- **Asesor financiero**: tool `financial_advice` con 5 modos (time_to_goal, affordability, savings_capacity, runway, forecast_month).

## Pre-requisitos

Tu instancia de n8n (≥ 2.18) ya trae los nodos `@n8n/n8n-nodes-langchain.*` (Agent, Chat Model, Memory, Output Parser, Tools). No hay que instalar nada.

Credenciales que el v3 referencia (verificá que estén en n8n con esos ids o cambialos en los build scripts):
- OpenAI: `0ErbOR5W4QIYaohV`
- Postgres: `f8CCpjEZRkcHEaJI`
- Redis: `igDqU9rqRBlmVQGc`
- Evolution: `FgeqqvxAqTER4oeD`

## Pasos de deploy

**Atajo recomendado**: `npm run deploy` (corre todo lo que sigue automáticamente — `bash scripts/deploy.sh`). Para deploy manual paso a paso:

### 1. Aplicar schema (una sola vez por sesión de cambios)

```bash
docker compose run --rm db-init
```

Idempotente. Crea/actualiza:
- Extensión `vector` (pgvector 0.8+) para memoria semántica.
- Tabla `memory_chunks` con índice HNSW cosine + columna `embedding_model`.
- Tabla `memory_chunk_versions` (audit log de updates/forgets/reembeds/stales).
- Columna `version` en `conversation_state` para optimistic locking.
- ~80 funciones SQL (CRUD de tx, categorías, grupos, presupuestos, recurrentes, tags, settings, memoria con scoring híbrido + audit + stale review + export, asesor financiero).
- Tablas: `n8n_chat_histories`, `cron_runs`, `budget_alert_log`, `monthly_digest_log`.

### 2. Importar los 4 workflows

⚠️ **Orden importa**: tools y error primero (los referencian los otros por id).

```bash
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-tools-v3.json
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-error-v3.json
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-cron-v3.json
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-agent-v3.json
```

### 3. Linkear el sub-workflow tools + error handler al agente

Los JSONs del agente y del cron traen placeholders `__TOOLS_WF_ID__` y `__ERROR_WF_ID__`. Después de importar tools y error handler, copiá sus workflow IDs y corré:

```bash
node apply-tools-id.js --tools <TOOLS_ID> --error <ERROR_ID>
```

Después re-importá `chefin-agent-v3.json` y `chefin-cron-v3.json` (sobreescriben por id).

### 3b. Crear carpeta de logs en el host

```bash
mkdir -p logs logs/memory-snapshots
```

El docker-compose bind-montea `./logs:/data/logs` para que el error handler y el cron de snapshot puedan persistir archivos al host.

### 4. Verificar credenciales

Después del import, abrí cada nodo que use credentials (Chat Model, Postgres, Redis, Evolution API, Embed HTTP) y confirmá que estén linkeadas. n8n a veces las pierde post-import.

### 5. Activar workflows nuevos, desactivar los viejos

1. Activá: `chefin_tools_v3`, `chefin_error_v3`, `chefin_cron_v3`, `chefin_agent_v3`.
2. Desactivá: `Daily Summary Cron`, `Weekly Summary Cron`, `Recurring Transactions Processor`, `chefin` (v1).
3. Asegurate que solo el v3 escuche en `/webhook/chefin`.

### 6. Apuntar Evolution API al webhook v3

```
URL: http://n8n:5678/webhook/chefin
```

⚠️ Si el v1 estaba activo en el mismo path, desactivalo PRIMERO para evitar conflictos.

## Validación pre-deploy

`npm test` corre todo lo que se puede testear sin API real (SQL + chunker + tool integration + edits + error handler + isolation). Los runs requieren postgres up.

```bash
npm test
```

Suites individuales:

```bash
npm run test:sql       # Suite SQL completa: schema + funciones + memoria + audit + optimistic lock
npm run test:chunker   # Splits del reply en mensajes WhatsApp
npm run test:tools     # Routing por tool_name
npm run test:edits     # update_transaction / bulk_update / delete_category
npm run test:errors    # Error handler: 14 escenarios de payload + 6 de file write
npm run test:isolation # Aislamiento multi-user
```

Tests que pegan a OpenAI (opcionales, requieren `OPENAI_API_KEY`):

```bash
export OPENAI_API_KEY=sk-...
node tests/agent/run-router.mjs   # Router classification (32 scenarios)
node tests/agent/run-tools.mjs    # Tool routing (30 scenarios)
```

Si pasan todos, deploy seguro.

## Smoke tests post-deploy (mensajes reales por WhatsApp)

### Transacciones
| # | Mensaje | Esperado |
|---|---|---|
| 1 | `Tomé 2500 de café` | log directo + ✅ |
| 2 | `Cuánto gasté este mes?` | total simple |
| 3 | `Mostrame los últimos 5 movs` | lista numerada |
| 4 | `Borrá el primero` (tras #3) | resuelve via last_list → confirmación |
| 5 | `Eliminá los gastos repetidos` | find_duplicates → preview → confirma |
| 6 | `El último gasto era comida no salidas` | update_transaction con new_category_hint |

### Configuración
| # | Mensaje | Esperado |
|---|---|---|
| 7 | `Creá una categoría llamada salidas` | create_category, no pregunta tipo |
| 8 | `Borrá la categoría salidas` | si tiene tx pregunta merge_into; si vacía la borra |
| 9 | `Pausá Netflix` | list_recurring → pause_recurring |
| 10 | `Ponéle un presupuesto de 50k a comida` | set_budget |
| 11 | `Etiquetá los últimos 3 cafés como trabajo` | find_transactions + tag_transactions |
| 12 | `Creá un viaje a Brasil` | create_group(kind=trip) |
| 13 | `El resumen mandámelo a las 8 de la noche` | update_settings |

### Insights
| # | Mensaje | Esperado |
|---|---|---|
| 14 | `Comparame con el mes pasado` | compare_periods con delta |
| 15 | `En qué gasté más?` | breakdown con % |
| 16 | `Haceme un gráfico` | "aguardame" → imagen + caption |
| 17 | `En cuánto tiempo junto 500 mil` | financial_advice(time_to_goal) |
| 18 | `Cuánto ahorro al mes?` | financial_advice(savings_capacity) |

### Memoria
| # | Mensaje | Esperado |
|---|---|---|
| 19 | `Anotá que estoy ahorrando para una moto de 4 millones` | remember_fact, kind=goal |
| 20 | `Cómo voy con la meta de la moto?` | recall_memory + financial_advice combinado |
| 21 | `Ahora la meta es 5 millones` | update_memory (preserva id) — NO duplica |
| 22 | `Qué recordás de mí?` | list_memories legible |
| 23 | `Olvidate de la moto` | forget_memory |

### Chitchat (no llama agente, responde el router)
| # | Mensaje | Esperado |
|---|---|---|
| 24 | `Hola` | reply breve, sin reaction |
| 25 | `Qué fecha es hoy?` | fecha desde el contexto |
| 26 | `Gracias` | reply corto |

### Multi-mensaje
| # | Mensaje | Esperado |
|---|---|---|
| 27 | `Comparame con el mes pasado y dame contexto` | 2-3 mensajes secuenciales con typing entre cada uno |

## Cron — smoke test

Desde n8n abrí `chefin_cron_v3`:
1. Editá `Pick Job` y poné el job:
   - User-facing: `daily_summary` | `weekly_summary` | `recurring` | `budget_alerts`
   - Mantenimiento (no manda WhatsApp): `cleanup` | `memory_snapshot` | `session_summary` | `memory_stale_review`
2. Click `Manual Test`.
3. Verificá:

```sql
SELECT job_name, started_at, finished_at, items_processed, items_sent, success, error_msg, metadata
FROM cron_runs ORDER BY started_at DESC LIMIT 10;
```

Para los jobs nuevos:

```bash
# memory_snapshot escribe acá:
ls -la logs/memory-snapshots/

# cron_runs.metadata trae stats útiles:
# - memory_snapshot: { users_written, users_failed, file }
# - session_summary: { summaries_written, users_processed }
# - memory_stale_review: { facts_marked_stale }
```

## Error handler — smoke test

Cuando un nodo del agente o del cron revienta, `chefin_error_v3` se dispara automáticamente. Para verificar:

```bash
# Provocá un error apagando Postgres por unos segundos
docker compose stop n8n_postgres
# (mandá un mensaje WhatsApp ahora — debería fallar el agente)
docker compose start n8n_postgres

# Verificá el log:
tail -5 logs/errors-$(date +%Y-%m-%d).jsonl | jq .
```

Cada línea tiene `timestamp`, `workflow.name`, `execution.id`, `execution.url`, `error.message`, `error.stack`, `user.phone`, `replied: true/false`.

## Métricas a vigilar

```sql
-- Salud cron últimas 24h
SELECT job_name, COUNT(*) AS runs,
       AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))::INT AS avg_seconds,
       SUM(items_sent) AS sent,
       SUM(CASE WHEN success THEN 0 ELSE 1 END) AS failures
FROM cron_runs WHERE started_at > NOW() - INTERVAL '1 day'
GROUP BY job_name ORDER BY job_name;

-- Memoria conversacional (chat history) — ahora window de 20 turnos
SELECT session_id, COUNT(*) AS msgs, MAX(created_at) AS last
FROM n8n_chat_histories GROUP BY session_id ORDER BY msgs DESC LIMIT 10;

-- Estados conv pendientes (con version para detectar races)
SELECT user_id, state, version, expires_at FROM conversation_state
WHERE expires_at > NOW() ORDER BY expires_at;

-- Memoria semántica: estado de salud por usuario
SELECT user_id,
       COUNT(*) FILTER (WHERE kind NOT IN ('__forgotten__','__stale__')) AS active,
       COUNT(*) FILTER (WHERE kind = 'session_summary') AS summaries,
       COUNT(*) FILTER (WHERE kind = '__stale__') AS stale,
       COUNT(*) FILTER (WHERE kind = '__forgotten__') AS forgotten,
       SUM(recall_count) AS total_recalls,
       COUNT(DISTINCT embedding_model) AS models_in_use
FROM memory_chunks GROUP BY user_id;

-- Audit log de memoria (qué cambió últimamente)
SELECT user_id, operation, operation_source, COUNT(*) AS events,
       MAX(archived_at) AS last
FROM memory_chunk_versions
WHERE archived_at > NOW() - INTERVAL '7 days'
GROUP BY user_id, operation, operation_source
ORDER BY last DESC;

-- Tamaño total del storage de memoria por user (texto, no embeddings)
SELECT user_id, pg_size_pretty(SUM(length(content))::bigint) AS content_size
FROM memory_chunks WHERE kind <> '__forgotten__'
GROUP BY user_id;
```

## Tuning

Editá los build scripts y regenerá (o `npm run build` para hacer los 4 de una):

```bash
node build-tools-subworkflow.js > workflows/chefin-tools-v3.json
node build-error-workflow.js    > workflows/chefin-error-v3.json
node build-agent-workflow.js    > workflows/chefin-agent-v3.json
node build-cron-workflow.js     > workflows/chefin-cron-v3.json
node apply-tools-id.js --tools <TOOLS_ID> --error <ERROR_ID>   # tras importar tools y error
```

Re-importar en n8n (sobreescribe por id).

## Rollback

1. Desactivá los 4 workflows v3 (incluido `chefin_error_v3`).
2. Reactivá los viejos (`Daily Summary Cron`, `Weekly Summary Cron`, `Recurring Transactions Processor`, `chefin`).
3. Apuntá Evolution al path viejo.
4. La data en DB queda intacta — schema.sql es aditivo. Las nuevas tablas (`memory_chunk_versions`) y columnas (`embedding_model`, `version`) no rompen los workflows viejos.

## Observabilidad runtime

**Logs en disco** (bind-mounted al host vía `./logs:/data/logs`):

```
logs/
├── errors-YYYY-MM-DD.jsonl       # error handler (1 line por error con execution.url)
└── memory-snapshots/
    └── YYYY-MM-DD.jsonl          # snapshot diario, 1 line por user con todos sus chunks
```

**Inspección rápida:**

```bash
# Errores de hoy
tail -5 logs/errors-$(date +%Y-%m-%d).jsonl | jq .

# Resumen de errores por nodo en los últimos 7 días
cat logs/errors-*.jsonl | jq -r '.execution.lastNodeExecuted' | sort | uniq -c | sort -rn

# Cuántos chunks tiene cada user (último snapshot)
cat logs/memory-snapshots/$(ls -t logs/memory-snapshots/ | head -1) | jq '{phone, chunk_count}'
```

## Notas sobre el archivo legacy

`build-workflow.js` (sin sufijos) corresponde a la **v1/v2** monolítica. Lo dejamos en el repo para referencia histórica y rollback. **No lo uses en deploys nuevos** — todo v3 va por los 3 build scripts con sufijo (`-agent-`, `-tools-subworkflow`, `-cron-`).
