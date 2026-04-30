# Agent eval harness

Tests que validan que el **agente** se comporta como esperás (no la base de datos — eso lo cubren los tests SQL en `tests/sql/`).

## Arquitectura testada (post-refactor)

El harness valida la arquitectura de **sub-agents con prompt caching**:

```
Mensaje → Router (clasifica intent) → Switch ─┬→ Transaction Agent (14 tools)
                                              ├→ Config Agent (36 tools)
                                              ├→ Insights Agent (13 tools)
                                              └→ Chitchat (sin agente, lo arma el router)
```

System prompts estáticos (~1200-1500 tokens cada uno) cacheados por OpenAI. Contexto dinámico (fecha, convState, convContext) viaja en el user message como bloque `[CONTEXTO]...[/CONTEXTO]`.

## Por qué

Cada vez que tocás un prompt, podés romper algún flujo sin darte cuenta. Esta harness corre un set de scenarios contra el modelo real y compara contra expected outputs. Sirve como **smoke test** antes de subir cambios al VPS.

Hoy cubre el **Router** (la pieza más crítica del nuevo refactor a sub-agents). El router clasifica el mensaje en `transaction | config | insights | chitchat`. Si rompés esto, todo el sistema rutea mal.

## Cómo correr

```bash
# Desde el root del repo
export OPENAI_API_KEY=sk-...
node tests/agent/run-router.mjs

# Filtrar por nombre
node tests/agent/run-router.mjs --filter chitchat
```

Output esperado:

```
=== Router eval — 32 scenarios ===

✓ tx: gasto simple  →  transaction
✓ tx: gasto con método  →  transaction
...
✗ chitchat: como andas  →  expected=chitchat, got=transaction

=== Resultado: 31 pass · 1 fail · 18.3s ===
```

Costo aproximado: **~$0.005** por corrida completa (32 calls a `gpt-4o-mini`).
Tiempo: **15–25 segundos** secuencial.

## Cómo funciona

1. Lee `workflows/chefin-agent-v3.json` (el JSON construido) y extrae el `ROUTER_PROMPT` exacto.
2. Reemplaza los placeholders n8n (`{{ $now }}`, `{{ $json.convState }}`, etc.) con valores estáticos.
3. Por cada scenario, llama a OpenAI con `model: 'gpt-4o-mini'`, `response_format: json_object`, temperatura baja.
4. Parsea el `intent` y compara con `expected.intent`.

Como leemos el prompt desde el JSON construido, **siempre testeamos el prompt que va a producción**. Si cambiás `ROUTER_PROMPT` en el build script y rebuildeás, los tests usan la nueva versión automáticamente.

## Agregar scenarios

Editá `scenarios/router.json`. Cada entry:

```json
{
  "name": "tx: gasto simple",
  "message": "compré 2500 de café",
  "convState": "awaiting_category",        // opcional
  "convContext": { "amount": 3300 },       // opcional
  "expected": {
    "intent": "transaction"                // o config | insights | chitchat
  }
}
```

Buenas prácticas:
- Cubrí casos **borderline** (ambigüedad entre dos buckets).
- Cubrí cada `convState` que el router debe respetar.
- Si fixeás un bug del prompt, **agregá el scenario que lo expuso** acá para que no vuelva.

## Tier 2: tool-routing (`run-tools.mjs`)

Valida que cada **specialist agent** llama la tool correcta según el mensaje. No solo clasifica — testea que el Transaction Agent realmente invoca `log_transaction` cuando le decís "compré 2500 de café", que el Config Agent va a `create_category` cuando le decís "creá la categoría salidas", etc.

### Cómo corre

```bash
export OPENAI_API_KEY=sk-...
node tests/agent/run-tools.mjs
node tests/agent/run-tools.mjs --filter config       # solo Config agent
node tests/agent/run-tools.mjs --dry                 # sin llamar a OpenAI, valida extracción
```

Output esperado:

```
Agent "transaction" → 14 tools (14 con schema válido)
Agent "config" → 36 tools (36 con schema válido)
Agent "insights" → 13 tools (13 con schema válido)

=== Tool-routing eval — 30 scenarios ===
✓ [transaction] tx: gasto simple → log_transaction  →  log_transaction
✓ [config] config: crear categoría → create_category  →  create_category
✓ [insights] insights: total → get_total  →  get_total
...
=== Resultado: 28 pass · 2 fail · 38.2s ===
Tokens: 142103 prompt + 1820 completion
Costo aprox (gpt-4o-mini): $0.0224
```

### Cómo funciona (más en detalle que Tier 1)

1. **Carga el workflow JSON** y por cada specialist agent extrae:
   - Su system prompt (`parameters.options.systemMessage`).
   - Las tools conectadas a él (vía `ai_tool` connections).
   - El schema de cada tool, parseado del expression `$fromAI('name', \`desc\`, 'type')` que vive en `parameters.workflowInputs.value`.
2. **Convierte al formato function-calling de OpenAI**: cada tool se vuelve `{type:'function', function:{name, description, parameters:{type:'object', properties:{...}}}}`.
3. Por cada scenario llama a `chat/completions` con `tools: [...]` y `tool_choice: 'auto'`.
4. Captura `tool_calls[0].function.name` y compara contra `expected.first_tool` o `expected.tools_include`.

### Tipos de expectativa

```json
{ "expected": { "first_tool": "log_transaction" } }                       // primera tool exacta
{ "expected": { "tools_include": ["query_transactions", "find_transactions"] } }  // alguna de la lista
{ "expected": { "no_tool_calls": true } }                                 // debe responder texto sin llamar tools
```

Usá `tools_include` cuando hay flexibilidad legítima (ej. "borrá el último gasto" puede empezar por `query_transactions` o `find_transactions` — ambos válidos).

### Agregar scenarios

Editá `scenarios/tool-routing.json`. Cada entry **debe** tener `agent` (uno de `transaction|config|insights`):

```json
{
  "name": "config: cerrar viaje",
  "agent": "config",
  "message": "cerrá el viaje a Brasil",
  "expected": { "first_tool": "close_group" }
}
```

## Tier 3: end-to-end (no implementado)

Mandar un mensaje real al webhook del workflow y validar la respuesta de WhatsApp completa. Necesita n8n + Postgres + Redis corriendo. Para más adelante cuando haya CI.

## CI / cuando correr esto

- **Antes de deployar al VPS**: corré `run-router.mjs` y `run-tools.mjs`. Si pasan ≥95%, deployá. Si no, ajustá el prompt y volvé.
- **Después de cambiar un prompt**: idem.
- **Después de agregar/sacar una tool**: corré `run-tools.mjs` para detectar si la nueva tool sobrelapa con otra y confunde al agente.
