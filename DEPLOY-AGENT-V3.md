# Chefin v3 — Deploy

3 workflows + 1 schema. Pasos en orden, todo idempotente.

| Workflow | Archivo | Propósito |
|---|---|---|
| `chefin_agent_v3` | `workflows/chefin-agent-v3.json` | Webhook + Router + 3 sub-agents (Transaction / Config / Insights) + chitchat fast path |
| `chefin_tools_v3` | `workflows/chefin-tools-v3.json` | Sub-workflow con **54 tools** (lo invoca el agente) |
| `chefin_cron_v3` | `workflows/chefin-cron-v3.json` | Cron consolidado (resumen diario/semanal, recurrentes, cleanup, alertas) |

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
```

Highlights:
- **Sub-agents con prompt caching**: cada specialist tiene system prompt de ~2.2k tokens (estático, OpenAI cachea automáticamente). Costo y latencia ~50% menos en mensajes 2+.
- **Memoria semántica (pgvector)**: el agente puede `remember_fact` / `recall_memory` / `update_memory` / `forget_memory` / `list_memories` para persistir hechos del usuario más allá del chat history.
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

### 1. Aplicar schema (una sola vez por sesión de cambios)

```bash
docker compose run --rm db-init
```

Idempotente. Crea/actualiza:
- Extensión `vector` (pgvector 0.8+) para memoria semántica.
- Tabla `memory_chunks` con índice HNSW cosine.
- ~70 funciones SQL (CRUD de tx, categorías, grupos, presupuestos, recurrentes, tags, settings, memoria, asesor financiero).
- Tablas: `n8n_chat_histories`, `cron_runs`, `budget_alert_log`, `monthly_digest_log`.

### 2. Importar los 3 workflows

```bash
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-tools-v3.json
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-cron-v3.json
docker compose exec -T n8n sh -c 'n8n import:workflow --input=/dev/stdin' < workflows/chefin-agent-v3.json
```

### 3. Linkear el sub-workflow al agente

El JSON del agente trae `__TOOLS_WF_ID__` como placeholder en los 54 nodos `tool: ...`. Después de importar `chefin-tools-v3.json`, copiá su workflow ID (de la URL: `/workflow/<ID>`) y corré:

```bash
node apply-tools-id.js <SUBWORKFLOW_ID>
```

Después re-importá `chefin-agent-v3.json` (sobreescribe por nombre) o editá el agente en n8n y guarda.

### 4. Verificar credenciales

Después del import, abrí cada nodo que use credentials (Chat Model, Postgres, Redis, Evolution API, Embed HTTP) y confirmá que estén linkeadas. n8n a veces las pierde post-import.

### 5. Activar workflows nuevos, desactivar los viejos

1. Activá: `chefin_tools_v3`, `chefin_cron_v3`, `chefin_agent_v3`.
2. Desactivá: `Daily Summary Cron`, `Weekly Summary Cron`, `Recurring Transactions Processor`, `chefin` (v1).
3. Asegurate que solo el v3 escuche en `/webhook/chefin`.

### 6. Apuntar Evolution API al webhook v3

```
URL: http://n8n:5678/webhook/chefin
```

⚠️ Si el v1 estaba activo en el mismo path, desactivalo PRIMERO para evitar conflictos.

## Validación pre-deploy (correr antes del paso 1)

```bash
# 1. SQL test suite (31 tests, ~30s contra Postgres local)
cd tests && bash run.sh

# 2. Chunker unit tests (10 casos, sin API)
cd .. && node tests/agent/test-chunker.mjs

# 3. Router classification (32 scenarios, ~30s, requiere OPENAI_API_KEY)
export OPENAI_API_KEY=sk-...
node tests/agent/run-router.mjs

# 4. Tool routing (30 scenarios, ~40s, requiere OPENAI_API_KEY)
node tests/agent/run-tools.mjs
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
1. Editá `Pick Job` y poné el job (`daily_summary` | `weekly_summary` | `recurring` | `cleanup` | `budget_alerts`).
2. Click `Manual Test`.
3. Verificá:

```sql
SELECT job_name, started_at, finished_at, items_processed, items_sent, success, error_msg
FROM cron_runs ORDER BY started_at DESC LIMIT 10;
```

## Métricas a vigilar

```sql
-- Salud cron últimas 24h
SELECT job_name, COUNT(*) AS runs,
       AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))::INT AS avg_seconds,
       SUM(items_sent) AS sent,
       SUM(CASE WHEN success THEN 0 ELSE 1 END) AS failures
FROM cron_runs WHERE started_at > NOW() - INTERVAL '1 day'
GROUP BY job_name ORDER BY job_name;

-- Memoria conversacional (chat history)
SELECT session_id, COUNT(*) AS msgs, MAX(created_at) AS last
FROM n8n_chat_histories GROUP BY session_id ORDER BY msgs DESC LIMIT 10;

-- Estados conv pendientes
SELECT user_id, state, expires_at FROM conversation_state
WHERE expires_at > NOW() ORDER BY expires_at;

-- Memoria semántica (pgvector)
SELECT user_id, COUNT(*) FILTER (WHERE kind <> '__forgotten__') AS active,
       COUNT(*) FILTER (WHERE kind = '__forgotten__') AS forgotten,
       SUM(recall_count) AS total_recalls
FROM memory_chunks GROUP BY user_id;
```

## Tuning

Editá los build scripts y regenerá:

```bash
node build-tools-subworkflow.js > workflows/chefin-tools-v3.json
node build-agent-workflow.js    > workflows/chefin-agent-v3.json
node build-cron-workflow.js     > workflows/chefin-cron-v3.json
node apply-tools-id.js <SUB_ID>     # solo si recreaste agent JSON
```

Re-importar en n8n (sobreescribe por nombre).

## Rollback

1. Desactivá los 3 workflows v3.
2. Reactivá los viejos (`Daily Summary Cron`, `Weekly Summary Cron`, `Recurring Transactions Processor`, `chefin`).
3. Apuntá Evolution al path viejo.
4. La data en DB queda intacta — schema.sql es aditivo.

## Notas sobre el archivo legacy

`build-workflow.js` (sin sufijos) corresponde a la **v1/v2** monolítica. Lo dejamos en el repo para referencia histórica y rollback. **No lo uses en deploys nuevos** — todo v3 va por los 3 build scripts con sufijo (`-agent-`, `-tools-subworkflow`, `-cron-`).
