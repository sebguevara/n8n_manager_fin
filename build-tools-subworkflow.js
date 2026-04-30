// Builds the Chefin Agent Tools sub-workflow.
// Run with: node build-tools-subworkflow.js > workflows/chefin-tools-v3.json
//
// This sub-workflow is invoked by the main agent workflow once per tool call.
// Input shape (from `Execute Workflow Trigger`):
//   { tool_name: string, user_id: uuid, params: object }
// Output: { ok: boolean, data?: any, error?: string }

const PG = { id: 'f8CCpjEZRkcHEaJI', name: 'Postgres account' };
const OPENAI = { id: '0ErbOR5W4QIYaohV', name: 'OpenAI account' };
const EMBED_MODEL = 'text-embedding-3-small';  // 1536 dim, $0.02/1M tokens

let idCounter = 1;
const newId = () => `t${(idCounter++).toString().padStart(3,'0')}`;
const nodes = [];
const connections = {};

const addNode = (name, type, params, x, y, extras = {}) => {
    nodes.push({
        parameters: params, id: newId(), name, type,
        typeVersion: extras.tv || 2, position: [x, y],
        ...(extras.creds && { credentials: extras.creds }),
        ...(extras.always && { alwaysOutputData: true })
    });
    return name;
};
const connect = (from, to, fromIdx = 0) => {
    if (!connections[from]) connections[from] = { main: [] };
    while (connections[from].main.length <= fromIdx) connections[from].main.push([]);
    connections[from].main[fromIdx].push({ node: to, type: 'main', index: 0 });
};
const cond = (combinator, conds) => ({
    options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
    combinator, conditions: conds
});
const eqStr = (id, lv, rv) => ({
    id, operator: { type: 'string', operation: 'equals' },
    leftValue: lv, rightValue: rv
});

// =========================================================================
// 1. ENTRY POINT
// =========================================================================
// Trigger uses passthrough mode so any field shape is accepted.
// Tool nodes pass tool_name, user_id, and one field per tool parameter.
addNode('When Called', 'n8n-nodes-base.executeWorkflowTrigger', {
    inputSource: 'passthrough'
}, 0, 0, { tv: 1.1 });

// Normalize input — accepts:
//   (a) tool_name + user_id + per-field flat params (new design — preferred)
//   (b) tool_name + user_id + params (object)
//   (c) tool_name + user_id + params_json (stringified) — legacy
// Reconstructs params object regardless. Drops empty strings / zero defaults
// for fields the LLM didn't fill (so SQL handlers see undefined and skip them).
addNode('Normalize Input', 'n8n-nodes-base.code', {
    jsCode: `const inp = $input.first().json;
const q = inp.query || {};
const merged = { ...q, ...inp };

const tool_name = merged.tool_name || '';
const user_id = merged.user_id || '';
if (!user_id) throw new Error('Missing user_id');
if (!tool_name) throw new Error('Missing tool_name');

// 1) Try blob-style first
let params = merged.params;
if (typeof params === 'string') {
  try { params = JSON.parse(params); } catch { params = null; }
}
if (params && typeof params !== 'object') params = null;

// 2) params_json legacy
if (!params && typeof merged.params_json === 'string') {
  try { params = JSON.parse(merged.params_json || '{}'); } catch { params = {}; }
}

// 3) Per-field flat (new design): collect everything except control fields
if (!params) {
  params = {};
  const ctrl = new Set(['tool_name', 'user_id', 'query', 'params', 'params_json']);
  for (const [k, v] of Object.entries(merged)) {
    if (ctrl.has(k)) continue;
    // Skip empty strings and 0 numbers (treated as "field not provided" defaults)
    if (v === '' || v === null || v === undefined) continue;
    if (typeof v === 'number' && v === 0 && k !== 'amount_delta' && k !== 'top_n') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    params[k] = v;
  }
}

if (!params || typeof params !== 'object') params = {};

// Strip placeholder fields
['_', 'dummy', 'action'].forEach(k => {
  if (Object.prototype.hasOwnProperty.call(params, k) && (params[k] === true || params[k] === 'run' || params[k] === 'execute')) {
    delete params[k];
  }
});

return [{ json: { tool_name, user_id, params, params_json: JSON.stringify(params) } }];`
}, 220, 0);
connect('When Called', 'Normalize Input');

// =========================================================================
// 2. ROUTER (Switch by tool_name)
// =========================================================================
const TOOLS = [
    'query_transactions', 'get_total', 'get_breakdown', 'compare_periods',
    'find_transactions', 'find_duplicates',
    'bulk_preview', 'bulk_delete', 'bulk_update',
    'log_transaction', 'update_transaction', 'delete_transaction',
    'list_categories', 'list_groups', 'list_budgets',
    'set_budget', 'create_group', 'toggle_category_exclusion', 'set_recurring',
    'remember_last_list', 'get_last_list',
    'set_conv_state', 'clear_conv_state',
    'generate_chart',
    // Categorías (CRUD)
    'create_category', 'rename_category', 'delete_category',
    // Recurrentes (CRUD + búsqueda por hint para identificar rápido)
    'list_recurring', 'find_recurring_by_hint', 'update_recurring', 'pause_recurring', 'resume_recurring', 'cancel_recurring',
    // Grupos (CRUD)
    'update_group', 'rename_group', 'close_group', 'delete_group',
    // Presupuestos (D + pause)
    'delete_budget', 'pause_budget', 'resume_budget',
    // Tags (CRUD + smart suggest + tag/untag tx)
    'create_tag', 'rename_tag', 'delete_tag', 'list_tags', 'tag_transactions', 'untag_transactions', 'suggest_tags',
    // Settings del usuario
    'get_settings', 'update_settings',
    // Asesor financiero
    'financial_advice',
    // Memoria semántica (pgvector) — incluye update para hechos que evolucionan
    'remember_fact', 'recall_memory', 'update_memory', 'forget_memory', 'list_memories'
];

addNode('Tool Router', 'n8n-nodes-base.switch', {
    rules: {
        values: TOOLS.map((t, i) => ({
            conditions: cond('and', [eqStr('r' + i, '={{ $json.tool_name }}', t)]),
            renameOutput: true, outputKey: t
        }))
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'unknown' }
}, 440, 0, { tv: 3 });
connect('Normalize Input', 'Tool Router');

// =========================================================================
// 3. TOOL HANDLERS
// =========================================================================
// Each handler: Postgres → Format Result → Merge to "Wrap Output"
// Format Result wraps query rows as { ok: true, data: [...] }

let xT = 660, yT = -800;
const Y_STEP = 120;

const addPgTool = (idx, toolName, sqlQuery, replacementExpr, formatJs) => {
    yT = -800 + idx * Y_STEP;
    const pgName = `PG ${toolName}`;
    const fmtName = `Fmt ${toolName}`;
    addNode(pgName, 'n8n-nodes-base.postgres', {
        operation: 'executeQuery',
        query: sqlQuery,
        options: { queryReplacement: replacementExpr }
    }, xT, yT, { tv: 2.5, creds: { postgres: PG }, always: true, cof: true });
    connect('Tool Router', pgName, idx);

    // Wrap user-provided formatJs with a try/catch so SQL errors return
    // structured { ok: false, error } to the agent instead of crashing.
    const inner = formatJs || `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: '${toolName}', data: rows } }];`;
    const wrapped = `try {
  const first = $input.first()?.json || {};
  if (first.error || first.message?.includes?.('error')) {
    return [{ json: { ok: false, tool: '${toolName}', error: String(first.error || first.message || 'SQL error') } }];
  }
${inner}
} catch (e) {
  return [{ json: { ok: false, tool: '${toolName}', error: 'Format error: ' + (e?.message || String(e)) } }];
}`;
    addNode(fmtName, 'n8n-nodes-base.code', { jsCode: wrapped }, xT + 220, yT);
    connect(pgName, fmtName);
    return fmtName;
};

const formatNames = [];

// 0. query_transactions → query_tx_dynamic
formatNames.push(addPgTool(0, 'query_transactions',
    `SELECT * FROM query_tx_dynamic(
        $1::uuid,
        $2::jsonb,
        COALESCE(NULLIF($2::jsonb->>'limit','')::int, 20),
        COALESCE(NULLIF($2::jsonb->>'offset','')::int, 0)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
const total = rows[0]?.total_count || 0;
const items = rows.map(r => ({
  id: r.id, date: r.transaction_date, amount: Number(r.amount),
  description: r.description, category: r.category_name, emoji: r.category_emoji,
  type: r.type, payment_method: r.payment_method_name, group: r.group_name
}));
return [{ json: { ok: true, tool: 'query_transactions',
  data: { items, total_count: Number(total), returned: items.length, has_more: items.length < Number(total) } } }];`
));

// 1. get_total
formatNames.push(addPgTool(1, 'get_total',
    'SELECT * FROM get_total_dynamic($1::uuid, $2::jsonb);',
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'get_total', data: {
  total: Number(r.total||0), count: Number(r.count||0),
  period_start: r.period_start, period_end: r.period_end
} } }];`
));

// 2. get_breakdown
formatNames.push(addPgTool(2, 'get_breakdown',
    `SELECT * FROM get_breakdown_dynamic(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'dimension',''), 'category'),
        $2::jsonb,
        COALESCE(NULLIF($2::jsonb->>'top_n','')::int, 10)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'get_breakdown', data: {
  rows: rows.map(r => ({ label: r.label, emoji: r.emoji, total: Number(r.total),
    count: Number(r.count), pct: Number(r.pct_of_total) })),
  total_rows: rows.length
} } }];`
));

// 3. compare_periods
formatNames.push(addPgTool(3, 'compare_periods',
    `SELECT * FROM compare_periods(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'period_a',''), 'this_month'),
        COALESCE(NULLIF($2::jsonb->>'period_b',''), 'last_month'),
        COALESCE(NULLIF($2::jsonb->>'type',''), 'expense')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'compare_periods', data: {
  a: { label: r.label_a, total: Number(r.total_a), count: Number(r.count_a) },
  b: { label: r.label_b, total: Number(r.total_b), count: Number(r.count_b) },
  delta_abs: Number(r.delta_abs||0), delta_pct: r.delta_pct === null ? null : Number(r.delta_pct)
} } }];`
));

// 4. find_transactions → find_matching_tx_v2
formatNames.push(addPgTool(4, 'find_transactions',
    `SELECT * FROM find_matching_tx_v2(
        $1::uuid,
        NULLIF($2::jsonb->>'description_contains','')::text,
        NULLIF($2::jsonb->>'date','')::date,
        NULLIF($2::jsonb->>'date_from','')::date,
        NULLIF($2::jsonb->>'date_to','')::date,
        NULLIF($2::jsonb->>'exact_amount','')::numeric,
        NULLIF($2::jsonb->>'min_amount','')::numeric,
        NULLIF($2::jsonb->>'max_amount','')::numeric,
        NULLIF($2::jsonb->>'category','')::text,
        NULLIF($2::jsonb->>'type','')::text,
        NULLIF($2::jsonb->>'group_name','')::text,
        COALESCE(NULLIF($2::jsonb->>'limit','')::int, 20)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
const items = rows.map(r => ({
  id: r.id, date: r.transaction_date, amount: Number(r.amount),
  description: r.description, category: r.category_name, emoji: r.category_emoji,
  type: r.type, group: r.group_name,
  score: Number(r.score), match_reasons: r.match_reasons
}));
return [{ json: { ok: true, tool: 'find_transactions',
  data: { matches: items, count: items.length, ambiguous: items.length > 1 && items.every(x => x.score >= (items[0].score - 0.05)) } } }];`
));

// 5. find_duplicates
formatNames.push(addPgTool(5, 'find_duplicates',
    `SELECT * FROM find_potential_duplicates(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'window_days','')::int, 7),
        COALESCE(NULLIF($2::jsonb->>'min_repetitions','')::int, 2)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'find_duplicates', data: {
  clusters: rows.map(r => ({
    cluster_id: r.cluster_id, count: Number(r.tx_count),
    total_amount: Number(r.total_amount), sample_amount: Number(r.sample_amount),
    sample_category: r.sample_category, sample_description: r.sample_description,
    earliest_date: r.earliest_date, latest_date: r.latest_date,
    transaction_ids: r.transaction_ids
  })), cluster_count: rows.length
} } }];`
));

// 6. bulk_preview
formatNames.push(addPgTool(6, 'bulk_preview',
    "SELECT * FROM bulk_preview($1::uuid, $2::jsonb);",
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'bulk_preview', data: {
  count: Number(r.would_match_count||0),
  total: Number(r.would_match_total||0),
  ids: r.sample_ids || [],
  preview: r.preview || []
} } }];`
));

// 7. bulk_delete → bulk_delete_by_ids
formatNames.push(addPgTool(7, 'bulk_delete',
    `SELECT * FROM bulk_delete_by_ids(
        $1::uuid,
        ARRAY(SELECT jsonb_array_elements_text($2::jsonb->'ids'))::uuid[]
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'bulk_delete', data: {
  deleted_count: Number(r.deleted_count||0),
  deleted_total: Number(r.deleted_total||0),
  deleted_ids: r.deleted_ids || []
} } }];`
));

// 8. bulk_update → bulk_update_by_ids
//    Acepta UUID o nombre (new_category_hint). Si create_category_if_missing=true, crea la
//    categoria si no existe; si no, hace fuzzy match contra existentes.
formatNames.push(addPgTool(8, 'bulk_update',
    `SELECT * FROM bulk_update_by_ids(
        $1::uuid,
        ARRAY(SELECT jsonb_array_elements_text($2::jsonb->'ids'))::uuid[],
        NULLIF($2::jsonb->>'new_category_id','')::uuid,
        NULLIF($2::jsonb->>'new_date','')::date,
        NULLIF($2::jsonb->>'new_group_id','')::uuid,
        NULLIF($2::jsonb->>'amount_delta','')::numeric,
        NULLIF($2::jsonb->>'set_excluded','')::boolean,
        NULLIF($2::jsonb->>'new_category_hint',''),
        COALESCE(($2::jsonb->>'create_category_if_missing')::boolean, false)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'bulk_update', data: {
  updated_count: Number(r.updated_count||0), updated_ids: r.updated_ids || []
} } }];`
));

// 9. log_transaction (full insert with category match + duplicate check)
// If create_category_if_missing=true, uses resolve_or_create_category instead
// of find_best_category — guarantees a category (creates new if needed).
formatNames.push(addPgTool(9, 'log_transaction',
    `WITH p AS (SELECT $2::jsonb AS j),
    cat AS (
        SELECT
            CASE
                WHEN COALESCE(((SELECT j->>'create_category_if_missing' FROM p))::boolean, false)
                THEN (SELECT category_id FROM resolve_or_create_category(
                    $1::uuid,
                    COALESCE(NULLIF((SELECT j->>'category_hint' FROM p),''), 'Otros'),
                    COALESCE(NULLIF((SELECT j->>'type' FROM p),''), 'expense')
                ))
                ELSE (SELECT category_id FROM find_best_category(
                    $1::uuid,
                    COALESCE(NULLIF((SELECT j->>'category_hint' FROM p),''), NULLIF((SELECT j->>'description' FROM p),'')),
                    COALESCE(NULLIF((SELECT j->>'type' FROM p),''), 'expense')
                ))
            END AS category_id,
            CASE
                WHEN COALESCE(((SELECT j->>'create_category_if_missing' FROM p))::boolean, false)
                THEN (SELECT category_name FROM resolve_or_create_category(
                    $1::uuid,
                    COALESCE(NULLIF((SELECT j->>'category_hint' FROM p),''), 'Otros'),
                    COALESCE(NULLIF((SELECT j->>'type' FROM p),''), 'expense')
                ))
                ELSE (SELECT category_name FROM find_best_category(
                    $1::uuid,
                    COALESCE(NULLIF((SELECT j->>'category_hint' FROM p),''), NULLIF((SELECT j->>'description' FROM p),'')),
                    COALESCE(NULLIF((SELECT j->>'type' FROM p),''), 'expense')
                ))
            END AS category_name,
            1::numeric AS score
    ),
    dup AS (
        SELECT id, amount, description, transaction_date
        FROM check_duplicate_tx(
            $1::uuid,
            ((SELECT j->>'amount' FROM p))::numeric,
            COALESCE(NULLIF((SELECT j->>'date' FROM p),'')::date, CURRENT_DATE),
            60
        )
        WHERE NOT COALESCE(((SELECT j->>'skip_dup_check' FROM p))::boolean, false)
    ),
    grp AS (
        SELECT CASE
            WHEN NULLIF((SELECT j->>'group_hint' FROM p),'') IS NULL THEN NULL
            ELSE upsert_group($1::uuid, (SELECT j->>'group_hint' FROM p), 'event')
        END AS gid
    ),
    pm AS (
        SELECT id FROM payment_methods
        WHERE user_id=$1::uuid
          AND normalize_text(name) % normalize_text(COALESCE((SELECT j->>'payment_method_hint' FROM p), ''))
        ORDER BY similarity(normalize_text(name), normalize_text(COALESCE((SELECT j->>'payment_method_hint' FROM p),''))) DESC
        LIMIT 1
    ),
    ins AS (
        INSERT INTO transactions (user_id, type, amount, description, category_id,
            payment_method_id, group_id, transaction_date)
        SELECT
            $1::uuid,
            COALESCE(NULLIF((SELECT j->>'type' FROM p),''),'expense'),
            ((SELECT j->>'amount' FROM p))::numeric,
            NULLIF((SELECT j->>'description' FROM p),''),
            (SELECT category_id FROM cat),
            (SELECT id FROM pm),
            (SELECT gid FROM grp),
            COALESCE(NULLIF((SELECT j->>'date' FROM p),'')::date, CURRENT_DATE)
        WHERE NOT EXISTS (SELECT 1 FROM dup)
        RETURNING id, amount, description, transaction_date, category_id
    )
    SELECT
        (SELECT id FROM ins) AS id,
        (SELECT amount FROM ins) AS amount,
        (SELECT description FROM ins) AS description,
        (SELECT transaction_date FROM ins) AS transaction_date,
        (SELECT c.name FROM categories c WHERE c.id=(SELECT category_id FROM ins)) AS category_name,
        (SELECT c.emoji FROM categories c WHERE c.id=(SELECT category_id FROM ins)) AS category_emoji,
        (SELECT category_id FROM cat) AS matched_category_id,
        (SELECT category_name FROM cat) AS matched_category_name,
        (SELECT score FROM cat) AS match_score,
        (SELECT id FROM dup) AS duplicate_of_id,
        (SELECT amount FROM dup) AS duplicate_of_amount,
        (SELECT description FROM dup) AS duplicate_of_description;`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (r.duplicate_of_id) {
  return [{ json: { ok: true, tool: 'log_transaction', data: {
    needs_confirmation: 'duplicate',
    duplicate_of: { id: r.duplicate_of_id, amount: Number(r.duplicate_of_amount),
      description: r.duplicate_of_description }
  } } }];
}
return [{ json: { ok: true, tool: 'log_transaction', data: {
  inserted: true,
  transaction: { id: r.id, amount: Number(r.amount), description: r.description,
    date: r.transaction_date, category: r.category_name, emoji: r.category_emoji },
  category_match_score: Number(r.match_score || 0)
} } }];`
));

// 10. update_transaction
//     Acepta UUID o nombre (new_category_hint). Si create_category_if_missing=true,
//     crea la categoria si no existe; si no, hace fuzzy match contra existentes.
formatNames.push(addPgTool(10, 'update_transaction',
    `SELECT * FROM update_tx(
        $1::uuid,
        ($2::jsonb->>'transaction_id')::uuid,
        NULLIF($2::jsonb->>'new_date','')::date,
        NULLIF($2::jsonb->>'new_amount','')::numeric,
        NULLIF($2::jsonb->>'new_description',''),
        NULLIF($2::jsonb->>'new_category_id','')::uuid,
        NULLIF($2::jsonb->>'new_category_hint',''),
        COALESCE(($2::jsonb->>'create_category_if_missing')::boolean, false)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.id) {
  return [{ json: { ok: false, tool: 'update_transaction', error: 'Transaction not found or not owned by user' } }];
}
return [{ json: { ok: true, tool: 'update_transaction', data: {
  id: r.id, amount: Number(r.amount), description: r.description,
  date: r.transaction_date, category: r.category_name
} } }];`
));

// 11. delete_transaction (single id via bulk_delete_by_ids)
formatNames.push(addPgTool(11, 'delete_transaction',
    `SELECT * FROM bulk_delete_by_ids(
        $1::uuid,
        ARRAY[($2::jsonb->>'transaction_id')::uuid]::uuid[]
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
const cnt = Number(r.deleted_count||0);
if (!cnt) return [{ json: { ok: false, tool: 'delete_transaction', error: 'Transaction not found' } }];
return [{ json: { ok: true, tool: 'delete_transaction', data: {
  deleted_id: (r.deleted_ids||[])[0], deleted_total: Number(r.deleted_total||0)
} } }];`
));

// 12. list_categories
formatNames.push(addPgTool(12, 'list_categories',
    `SELECT * FROM list_categories_with_counts(
        $1::uuid,
        NULLIF($2::jsonb->>'type',''),
        COALESCE(NULLIF($2::jsonb->>'include_excluded','')::boolean, false)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'list_categories', data: {
  categories: rows.map(r => ({ id: r.id, name: r.name, emoji: r.emoji, type: r.type,
    excluded: r.excluded, tx_count: Number(r.tx_count), total: Number(r.total_amount) }))
} } }];`
));

// 13. list_groups
formatNames.push(addPgTool(13, 'list_groups',
    "SELECT * FROM list_groups($1::uuid, TRUE);",
    "={{ $json.user_id }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'list_groups', data: {
  groups: rows.map(r => ({ id: r.id, name: r.name, kind: r.kind, emoji: r.emoji,
    total: Number(r.total||0), count: Number(r.n||0), excluded: r.excluded }))
} } }];`
));

// 14. list_budgets
formatNames.push(addPgTool(14, 'list_budgets',
    // OJO: la columna budgets.period guarda 'weekly'|'monthly'|'yearly', pero
    // DATE_TRUNC necesita 'week'|'month'|'year'. Mapeamos antes de usar.
    `SELECT b.id, b.amount, b.period, c.name AS category_name, c.emoji AS category_emoji,
            COALESCE(s.spent, 0) AS spent, b.is_active
     FROM budgets b
     LEFT JOIN categories c ON c.id = b.category_id
     LEFT JOIN LATERAL (
         SELECT SUM(t.amount) AS spent
         FROM v_reportable_transactions t
         WHERE t.user_id = b.user_id AND t.type = 'expense'
           AND t.category_id = b.category_id
           AND t.transaction_date >= DATE_TRUNC(
               CASE b.period
                   WHEN 'weekly'  THEN 'week'
                   WHEN 'monthly' THEN 'month'
                   WHEN 'yearly'  THEN 'year'
                   ELSE 'month'
               END,
               CURRENT_DATE
           )
     ) s ON TRUE
     WHERE b.user_id = $1::uuid AND b.is_active = TRUE;`,
    "={{ $json.user_id }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'list_budgets', data: {
  budgets: rows.map(r => ({ id: r.id, category: r.category_name, emoji: r.category_emoji,
    amount: Number(r.amount), period: r.period, spent: Number(r.spent||0),
    pct: r.amount > 0 ? Math.round(Number(r.spent||0) / Number(r.amount) * 100) : 0 }))
} } }];`
));

// 15. set_budget
formatNames.push(addPgTool(15, 'set_budget',
    `SELECT * FROM set_budget(
        $1::uuid,
        NULLIF($2::jsonb->>'category_hint',''),
        ($2::jsonb->>'amount')::numeric,
        COALESCE(NULLIF($2::jsonb->>'period',''), 'monthly')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'set_budget', data: {
  category: r.category_name || null, amount: Number(r.amount||0), period: r.period
} } }];`
));

// 16. create_group
formatNames.push(addPgTool(16, 'create_group',
    `SELECT name, kind FROM expense_groups WHERE id = upsert_group(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), 'Sin nombre'),
        COALESCE(NULLIF($2::jsonb->>'kind',''), 'event')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'create_group', data: { name: r.name, kind: r.kind } } }];`
));

// 17. toggle_category_exclusion
formatNames.push(addPgTool(17, 'toggle_category_exclusion',
    `SELECT * FROM toggle_category_exclusion(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'category_hint',''), '')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.name) return [{ json: { ok: false, tool: 'toggle_category_exclusion', error: 'Category not found' } }];
return [{ json: { ok: true, tool: 'toggle_category_exclusion', data: {
  category: r.name, excluded: r.excluded
} } }];`
));

// 18. set_recurring
// IMPORTANTE: la tabla recurring_transactions usa `next_occurrence`, no `start_date`.
// El agente sigue mandando `start_date` como param semántico (más natural para el LLM)
// pero acá lo mapeamos a la columna real. También derivamos `day_of_period` cuando
// la frecuencia es monthly/yearly (lo usa process_due_recurring para fechas estables).
formatNames.push(addPgTool(18, 'set_recurring',
    `WITH p AS (SELECT $2::jsonb AS j),
     vals AS (
        SELECT
            COALESCE(NULLIF((SELECT j->>'type' FROM p),''),'expense') AS type,
            ((SELECT j->>'amount' FROM p))::numeric AS amount,
            NULLIF((SELECT j->>'description' FROM p),'') AS description,
            COALESCE(NULLIF((SELECT j->>'frequency' FROM p),''), 'monthly') AS frequency,
            COALESCE(NULLIF((SELECT j->>'start_date' FROM p),'')::date, CURRENT_DATE) AS next_occurrence
     )
     INSERT INTO recurring_transactions (user_id, type, amount, description, category_id,
        frequency, next_occurrence, day_of_period, is_active)
     SELECT $1::uuid,
            v.type,
            v.amount,
            v.description,
            (SELECT category_id FROM find_best_category(
                $1::uuid,
                COALESCE(v.description, NULLIF((SELECT j->>'category_hint' FROM p),'')),
                v.type
            )),
            v.frequency,
            v.next_occurrence,
            CASE WHEN v.frequency IN ('monthly','yearly') THEN EXTRACT(DAY FROM v.next_occurrence)::int ELSE NULL END,
            TRUE
     FROM vals v, p
     RETURNING id, amount, description, frequency, next_occurrence, day_of_period;`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'set_recurring', data: {
  id: r.id, amount: Number(r.amount), description: r.description,
  frequency: r.frequency,
  next_occurrence: r.next_occurrence,
  day_of_period: r.day_of_period
} } }];`
));

// 19. remember_last_list
formatNames.push(addPgTool(19, 'remember_last_list',
    `SELECT remember_last_list(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'kind',''), 'transactions'),
        COALESCE($2::jsonb->'items', '[]'::jsonb),
        COALESCE($2::jsonb->'filters_applied', '{}'::jsonb),
        COALESCE(NULLIF($2::jsonb->>'ttl_seconds','')::int, 600)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `return [{ json: { ok: true, tool: 'remember_last_list', data: { saved: true } } }];`
));

// 20. get_last_list
formatNames.push(addPgTool(20, 'get_last_list',
    "SELECT * FROM get_last_list($1::uuid);",
    "={{ $json.user_id }}",
    `const r = $input.first().json;
if (!r || !r.kind) return [{ json: { ok: true, tool: 'get_last_list', data: { exists: false } } }];
return [{ json: { ok: true, tool: 'get_last_list', data: {
  exists: true, kind: r.kind, items: r.items || [],
  shown_at: r.shown_at, filters: r.filters_applied, fresh: r.is_fresh
} } }];`
));

// 21. set_conv_state
formatNames.push(addPgTool(21, 'set_conv_state',
    `SELECT set_conv_state(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'state',''), ''),
        COALESCE($2::jsonb->'context', '{}'::jsonb),
        COALESCE(NULLIF($2::jsonb->>'ttl_seconds','')::int, 600)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `return [{ json: { ok: true, tool: 'set_conv_state', data: { saved: true } } }];`
));

// 22. clear_conv_state
formatNames.push(addPgTool(22, 'clear_conv_state',
    "DELETE FROM conversation_state WHERE user_id = $1::uuid;",
    "={{ $json.user_id }}",
    `return [{ json: { ok: true, tool: 'clear_conv_state', data: { cleared: true } } }];`
));

// 23. generate_chart (no SQL — just QuickChart URL builder, but uses Postgres for data)
//     OJO: si agregas tools antes de generate_chart, mantene chartIdx alineado con TOOLS.
const chartIdx = TOOLS.indexOf('generate_chart');
yT = -800 + chartIdx * Y_STEP;
addNode('PG generate_chart', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `SELECT * FROM get_breakdown_dynamic(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'dimension',''), 'category'),
        $2::jsonb,
        COALESCE(NULLIF($2::jsonb->>'top_n','')::int, 10)
    );`,
    options: {
        queryReplacement: "={{ $json.user_id }},={{ $json.params_json }}"
    }
}, xT, yT, { tv: 2.5, creds: { postgres: PG }, always: true, cof: true });
connect('Tool Router', 'PG generate_chart', chartIdx);

addNode('Fmt generate_chart', 'n8n-nodes-base.code', {
    jsCode: `const rawRows = $input.all().map(i => i.json);
const params = $('Normalize Input').first().json.params || {};
const kind = params.kind || params.dimension || 'by_category';
const period = params.period || 'this_month';
const periodLabel = ({this_month:'este mes',last_month:'el mes pasado',this_week:'esta semana',this_year:'este año',today:'hoy',yesterday:'ayer',all:'en total'})[period] || period;
// Filter rows with null/empty label or zero/null value — happens when there are no transactions
const rows = rawRows.filter(r => r && r.label && Number(r.total) > 0);
if (!rows.length) {
  return [{ json: { ok: true, tool: 'generate_chart', data: { has_data: false, caption: '📭 No tengo datos para graficar ' + periodLabel + '. Cargá algunos gastos primero.' } } }];
}
const labels = rows.map(r => r.label);
const values = rows.map(r => Number(r.total));
const total = values.reduce((s,v) => s+v, 0);
const palette = ['#FF6B6B','#4ECDC4','#FFD93D','#6BCB77','#4D96FF','#9D4EDD','#FF9F1C','#2EC4B6','#E71D36','#7209B7','#3A86FF','#FB5607'];
const titleByKind = ({by_category:'Gastos por categoría',category:'Gastos por categoría',by_payment_method:'Gastos por método de pago',payment_method:'Gastos por método de pago',by_day:'Gastos diarios',day:'Gastos diarios',trend:'Tendencia mensual'})[kind] || 'Gastos';
const isPie = ['by_category','category','by_payment_method','payment_method'].includes(kind);
const chart = isPie
  ? { type:'doughnut', data:{ labels, datasets:[{ data: values, backgroundColor: palette }] }, options:{ plugins:{ title:{display:true, text: titleByKind+' — '+periodLabel}, legend:{position:'right'} } } }
  : { type:'bar', data:{ labels, datasets:[{ label:'Gasto', data: values, backgroundColor: palette[0] }] }, options:{ plugins:{ title:{display:true, text: titleByKind+' — '+periodLabel}, legend:{display:false} }, scales:{ y:{beginAtZero:true} } } };
const url = 'https://quickchart.io/chart?bkg=white&w=900&h=600&c=' + encodeURIComponent(JSON.stringify(chart));
const fmt = n => Number(n||0).toLocaleString('es-AR');
return [{ json: { ok: true, tool: 'generate_chart', data: {
  has_data: true, image_url: url,
  caption: titleByKind + ' — ' + periodLabel + '\\nTotal: $' + fmt(total)
} } }];`
}, xT + 220, yT);
connect('PG generate_chart', 'Fmt generate_chart');
formatNames.push('Fmt generate_chart');

// 24. create_category — crea o devuelve una categoria del usuario.
//     Si ya existe (exact o fuzzy match), no la duplica: la devuelve con was_created=false.
formatNames.push(addPgTool(TOOLS.indexOf('create_category'), 'create_category',
    `SELECT * FROM resolve_or_create_category(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), 'Otros'),
        COALESCE(NULLIF($2::jsonb->>'type',''), 'expense')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.category_id) {
  return [{ json: { ok: false, tool: 'create_category', error: 'No se pudo crear la categoría' } }];
}
return [{ json: { ok: true, tool: 'create_category', data: {
  id: r.category_id, name: r.category_name, was_created: !!r.was_created
} } }];`
));

// 25. rename_category — cambia el nombre de una categoria existente del usuario.
formatNames.push(addPgTool(TOOLS.indexOf('rename_category'), 'rename_category',
    `SELECT * FROM rename_category(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'old_name',''), ''),
        COALESCE(NULLIF($2::jsonb->>'new_name',''), '')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.renamed) {
  return [{ json: { ok: false, tool: 'rename_category',
    error: 'No encontré la categoría "' + (r?.old_name || '') + '". Mirá list_categories.' } }];
}
return [{ json: { ok: true, tool: 'rename_category', data: {
  id: r.category_id, old_name: r.old_name, new_name: r.new_name
} } }];`
));

// 26. delete_category — soft-delete (desactiva). Si tiene transacciones u otras
//     dependencias y no se pasa merge_into, falla con un error claro.
formatNames.push(addPgTool(TOOLS.indexOf('delete_category'), 'delete_category',
    `SELECT * FROM delete_category(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), ''),
        NULLIF($2::jsonb->>'merge_into','')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.deactivated) {
  return [{ json: { ok: false, tool: 'delete_category',
    error: 'No encontré la categoría. Mirá list_categories.' } }];
}
return [{ json: { ok: true, tool: 'delete_category', data: {
  id: r.category_id, name: r.category_name, merged_into: r.merged_into || null,
  moved_transactions: Number(r.moved_transactions || 0)
} } }];`
));

// ---------- Recurrentes (CRUD) ----------

// list_recurring
formatNames.push(addPgTool(TOOLS.indexOf('list_recurring'), 'list_recurring',
    `SELECT * FROM list_recurring(
        $1::uuid,
        COALESCE(($2::jsonb->>'active_only')::boolean, true)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'list_recurring', data: {
  recurring: rows.map(r => ({
    id: r.id, type: r.type, amount: Number(r.amount), description: r.description,
    frequency: r.frequency, next_occurrence: r.next_occurrence,
    last_occurrence: r.last_occurrence, end_date: r.end_date, is_active: r.is_active,
    category: r.category_name, emoji: r.category_emoji,
    payment_method: r.payment_method_name
  }))
} } }];`
));

// find_recurring_by_hint — búsqueda dirigida por nombre. Mucho más rápido y
// preciso que dumpear todas las recurrentes para que el LLM elija. Devuelve
// hasta 5 candidatos rankeados por similaridad. Si data.matches.length === 0
// el agente reporta "no encontré X" sin dar por cierto que existe.
formatNames.push(addPgTool(TOOLS.indexOf('find_recurring_by_hint'), 'find_recurring_by_hint',
    `SELECT * FROM find_recurring_by_hint(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'hint',''), '')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
const matches = rows.map(r => ({
  id: r.id, description: r.description, amount: Number(r.amount),
  frequency: r.frequency, is_active: r.is_active
}));
return [{ json: { ok: true, tool: 'find_recurring_by_hint', data: {
  matches,
  count: matches.length,
  ambiguous: matches.length > 1
} } }];`
));

// update_recurring
formatNames.push(addPgTool(TOOLS.indexOf('update_recurring'), 'update_recurring',
    `SELECT * FROM update_recurring(
        $1::uuid,
        ($2::jsonb->>'recurring_id')::uuid,
        NULLIF($2::jsonb->>'new_amount','')::numeric,
        NULLIF($2::jsonb->>'new_description',''),
        NULLIF($2::jsonb->>'new_frequency',''),
        NULLIF($2::jsonb->>'new_category_hint',''),
        NULLIF($2::jsonb->>'new_next_occurrence','')::date,
        NULLIF($2::jsonb->>'new_end_date','')::date,
        COALESCE(($2::jsonb->>'create_category_if_missing')::boolean, false)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.id) return [{ json: { ok: false, tool: 'update_recurring',
  error: 'No encontré la recurrente o no es tuya' } }];
return [{ json: { ok: true, tool: 'update_recurring', data: {
  id: r.id, amount: Number(r.amount), description: r.description, frequency: r.frequency,
  next_occurrence: r.next_occurrence, end_date: r.end_date, is_active: r.is_active,
  category: r.category_name
} } }];`
));

// pause_recurring
formatNames.push(addPgTool(TOOLS.indexOf('pause_recurring'), 'pause_recurring',
    `SELECT * FROM pause_recurring($1::uuid, ($2::jsonb->>'recurring_id')::uuid);`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.paused) return [{ json: { ok: false, tool: 'pause_recurring',
  error: 'No encontré la recurrente o no es tuya' } }];
return [{ json: { ok: true, tool: 'pause_recurring', data: {
  id: r.id, description: r.description, was_active: !!r.was_active
} } }];`
));

// resume_recurring
formatNames.push(addPgTool(TOOLS.indexOf('resume_recurring'), 'resume_recurring',
    `SELECT * FROM resume_recurring($1::uuid, ($2::jsonb->>'recurring_id')::uuid);`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.resumed) return [{ json: { ok: false, tool: 'resume_recurring',
  error: 'No encontré la recurrente o no es tuya' } }];
return [{ json: { ok: true, tool: 'resume_recurring', data: {
  id: r.id, description: r.description
} } }];`
));

// cancel_recurring
formatNames.push(addPgTool(TOOLS.indexOf('cancel_recurring'), 'cancel_recurring',
    `SELECT * FROM cancel_recurring($1::uuid, ($2::jsonb->>'recurring_id')::uuid);`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.cancelled) return [{ json: { ok: false, tool: 'cancel_recurring',
  error: 'No encontré la recurrente o no es tuya' } }];
return [{ json: { ok: true, tool: 'cancel_recurring', data: {
  id: r.id, description: r.description
} } }];`
));

// ---------- Grupos (CRUD) ----------

// update_group
formatNames.push(addPgTool(TOOLS.indexOf('update_group'), 'update_group',
    `SELECT * FROM update_group(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), ''),
        NULLIF($2::jsonb->>'new_name',''),
        NULLIF($2::jsonb->>'new_kind',''),
        NULLIF($2::jsonb->>'new_emoji',''),
        NULLIF($2::jsonb->>'new_starts_at','')::date,
        NULLIF($2::jsonb->>'new_ends_at','')::date
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.id) return [{ json: { ok: false, tool: 'update_group',
  error: 'No encontré el grupo' } }];
return [{ json: { ok: true, tool: 'update_group', data: {
  id: r.id, name: r.name, kind: r.kind, emoji: r.emoji,
  starts_at: r.starts_at, ends_at: r.ends_at, is_active: r.is_active
} } }];`
));

// rename_group
formatNames.push(addPgTool(TOOLS.indexOf('rename_group'), 'rename_group',
    `SELECT * FROM rename_group(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'old_name',''), ''),
        COALESCE(NULLIF($2::jsonb->>'new_name',''), '')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.renamed) return [{ json: { ok: false, tool: 'rename_group',
  error: 'No encontré el grupo "' + (r?.old_name || '') + '"' } }];
return [{ json: { ok: true, tool: 'rename_group', data: {
  id: r.id, old_name: r.old_name, new_name: r.new_name
} } }];`
));

// close_group
formatNames.push(addPgTool(TOOLS.indexOf('close_group'), 'close_group',
    `SELECT * FROM close_group(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), '')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.closed) return [{ json: { ok: false, tool: 'close_group',
  error: 'No encontré el grupo' } }];
return [{ json: { ok: true, tool: 'close_group', data: {
  id: r.id, name: r.name, ends_at: r.ends_at
} } }];`
));

// delete_group
formatNames.push(addPgTool(TOOLS.indexOf('delete_group'), 'delete_group',
    `SELECT * FROM delete_group(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), ''),
        NULLIF($2::jsonb->>'reassign_to_name',''),
        COALESCE(($2::jsonb->>'unassign')::boolean, false)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.deleted) return [{ json: { ok: false, tool: 'delete_group',
  error: 'No encontré el grupo' } }];
return [{ json: { ok: true, tool: 'delete_group', data: {
  id: r.id, name: r.name, moved_transactions: Number(r.moved_transactions || 0),
  reassigned_to: r.reassigned_to || null
} } }];`
));

// ---------- Presupuestos (delete/pause/resume) ----------

formatNames.push(addPgTool(TOOLS.indexOf('delete_budget'), 'delete_budget',
    `SELECT * FROM delete_budget(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'category_hint',''), ''),
        NULLIF($2::jsonb->>'period','')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
const cnt = Number(r?.deleted_count || 0);
if (!cnt) return [{ json: { ok: false, tool: 'delete_budget',
  error: 'No encontré un presupuesto activo para esa categoría' } }];
return [{ json: { ok: true, tool: 'delete_budget', data: {
  deleted_count: cnt, category: r.category_name
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('pause_budget'), 'pause_budget',
    `SELECT * FROM pause_budget(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'category_hint',''), ''),
        NULLIF($2::jsonb->>'period','')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
const cnt = Number(r?.paused_count || 0);
if (!cnt) return [{ json: { ok: false, tool: 'pause_budget',
  error: 'No encontré un presupuesto activo para esa categoría' } }];
return [{ json: { ok: true, tool: 'pause_budget', data: {
  paused_count: cnt, category: r.category_name
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('resume_budget'), 'resume_budget',
    `SELECT * FROM resume_budget(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'category_hint',''), ''),
        NULLIF($2::jsonb->>'period','')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
const cnt = Number(r?.resumed_count || 0);
if (!cnt) return [{ json: { ok: false, tool: 'resume_budget',
  error: 'No encontré un presupuesto pausado para esa categoría' } }];
return [{ json: { ok: true, tool: 'resume_budget', data: {
  resumed_count: cnt, category: r.category_name
} } }];`
));

// ---------- Tags (CRUD + tag/untag + sugerencias) ----------

formatNames.push(addPgTool(TOOLS.indexOf('create_tag'), 'create_tag',
    `SELECT * FROM create_tag(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), ''),
        NULLIF($2::jsonb->>'color','')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.tag_id) return [{ json: { ok: false, tool: 'create_tag',
  error: 'No se pudo crear el tag' } }];
return [{ json: { ok: true, tool: 'create_tag', data: {
  id: r.tag_id, name: r.tag_name, was_created: !!r.was_created
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('rename_tag'), 'rename_tag',
    `SELECT * FROM rename_tag(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'old_name',''), ''),
        COALESCE(NULLIF($2::jsonb->>'new_name',''), '')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.renamed) return [{ json: { ok: false, tool: 'rename_tag',
  error: 'No encontré el tag "' + (r?.old_name || '') + '"' } }];
return [{ json: { ok: true, tool: 'rename_tag', data: {
  id: r.tag_id, old_name: r.old_name, new_name: r.new_name
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('delete_tag'), 'delete_tag',
    `SELECT * FROM delete_tag(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'name',''), '')
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.deleted) return [{ json: { ok: false, tool: 'delete_tag',
  error: 'No encontré el tag' } }];
return [{ json: { ok: true, tool: 'delete_tag', data: {
  id: r.tag_id, name: r.tag_name,
  untagged_transactions: Number(r.untagged_transactions || 0)
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('list_tags'), 'list_tags',
    `SELECT * FROM list_tags($1::uuid);`,
    "={{ $json.user_id }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'list_tags', data: {
  tags: rows.map(r => ({ id: r.id, name: r.name, color: r.color,
    tx_count: Number(r.tx_count || 0), total: Number(r.total_amount || 0) }))
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('tag_transactions'), 'tag_transactions',
    `SELECT * FROM tag_transactions(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'tag_name',''), ''),
        ARRAY(SELECT jsonb_array_elements_text($2::jsonb->'tx_ids'))::uuid[],
        COALESCE(($2::jsonb->>'create_if_missing')::boolean, true)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'tag_transactions', data: {
  id: r.tag_id, name: r.tag_name,
  tagged_count: Number(r.tagged_count || 0),
  was_created: !!r.was_created
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('untag_transactions'), 'untag_transactions',
    `SELECT * FROM untag_transactions(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'tag_name',''), ''),
        ARRAY(SELECT jsonb_array_elements_text($2::jsonb->'tx_ids'))::uuid[]
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'untag_transactions', data: {
  untagged_count: Number(r.untagged_count || 0)
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('suggest_tags'), 'suggest_tags',
    `SELECT * FROM suggest_tags(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'description',''), ''),
        NULLIF($2::jsonb->>'amount','')::numeric,
        COALESCE(NULLIF($2::jsonb->>'limit','')::int, 5)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'suggest_tags', data: {
  suggestions: rows.map(r => ({ id: r.tag_id, name: r.tag_name,
    score: Number(r.score || 0), uses: Number(r.sample_uses || 0) }))
} } }];`
));

// ---------- Settings del usuario ----------

formatNames.push(addPgTool(TOOLS.indexOf('get_settings'), 'get_settings',
    `SELECT * FROM get_user_settings($1::uuid);`,
    "={{ $json.user_id }}",
    `const r = $input.first().json;
if (!r) return [{ json: { ok: false, tool: 'get_settings', error: 'Usuario no encontrado' } }];
return [{ json: { ok: true, tool: 'get_settings', data: {
  name: r.name, phone: r.phone_number, currency: r.preferred_currency,
  daily_summary_enabled: !!r.daily_summary_enabled,
  daily_summary_hour: Number(r.daily_summary_hour || 0),
  weekly_summary_enabled: !!r.weekly_summary_enabled,
  onboarded: !!r.onboarded
} } }];`
));

formatNames.push(addPgTool(TOOLS.indexOf('update_settings'), 'update_settings',
    `SELECT * FROM update_user_settings(
        $1::uuid,
        NULLIF($2::jsonb->>'name',''),
        NULLIF($2::jsonb->>'preferred_currency',''),
        NULLIF($2::jsonb->>'daily_summary_enabled','')::boolean,
        NULLIF($2::jsonb->>'daily_summary_hour','')::int,
        NULLIF($2::jsonb->>'weekly_summary_enabled','')::boolean
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'update_settings', data: {
  name: r.name, currency: r.preferred_currency,
  daily_summary_enabled: !!r.daily_summary_enabled,
  daily_summary_hour: Number(r.daily_summary_hour || 0),
  weekly_summary_enabled: !!r.weekly_summary_enabled
} } }];`
));

// ---------- Asesor financiero ----------
// 5 modos: time_to_goal | affordability | savings_capacity | runway | forecast_month
formatNames.push(addPgTool(TOOLS.indexOf('financial_advice'), 'financial_advice',
    `SELECT * FROM compute_financial_advice(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'mode',''), 'savings_capacity'),
        NULLIF($2::jsonb->>'goal_amount','')::numeric,
        NULLIF($2::jsonb->>'monthly_saving_override','')::numeric,
        NULLIF($2::jsonb->>'monthly_income_override','')::numeric,
        NULLIF($2::jsonb->>'monthly_expense_override','')::numeric,
        COALESCE(NULLIF($2::jsonb->>'lookback_months','')::int, 3),
        COALESCE(NULLIF($2::jsonb->>'extra_monthly_saving','')::numeric, 0)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r) return [{ json: { ok: false, tool: 'financial_advice', error: 'sin resultado' } }];
const numOrNull = v => (v === null || v === undefined || v === '') ? null : Number(v);
return [{ json: { ok: true, tool: 'financial_advice', data: {
  mode: r.mode,
  avg_monthly_income: numOrNull(r.avg_monthly_income),
  avg_monthly_expense: numOrNull(r.avg_monthly_expense),
  monthly_saving: numOrNull(r.monthly_saving),
  savings_rate_pct: numOrNull(r.savings_rate_pct),
  months_used: numOrNull(r.months_used),
  months_to_goal: numOrNull(r.months_to_goal),
  target_date: r.target_date || null,
  affordable: (r.affordable === null || r.affordable === undefined) ? null : !!r.affordable,
  runway_months: numOrNull(r.runway_months),
  projected_month_total_expense: numOrNull(r.projected_month_total_expense),
  projected_month_total_income: numOrNull(r.projected_month_total_income),
  note: r.note || ''
} } }];`
));

// ---------- Memoria semántica (pgvector + OpenAI embeddings) ----------
//
// Pattern para tools que requieren un embedding antes del SQL:
//   Router → Embed Input (Code: arma el body) → Embed HTTP (POST OpenAI) →
//     Pack Embedding (Code: extrae .data[0].embedding y lo formatea como
//     '[a,b,c]' literal de pgvector) → PG <tool> → Fmt <tool>.
//
// El input al Embed HTTP es el campo `query` o `content` que mandó el agente
// (vía Normalize Input → params). El output del Pack queda en json.embedding
// y se inyecta a la query SQL como tercer queryReplacement.
//
// `forget_memory` y `list_memories` no requieren embedding → handler estándar.
const addEmbeddingPgTool = (idx, toolName, embedTextExpr, sqlQuery, formatJs) => {
    const yT0 = -800 + idx * Y_STEP;
    const xPack = xT;
    const xPg   = xT + 220;
    const xFmt  = xT + 440;

    const embedNodeName = `Embed ${toolName}`;
    const packNodeName  = `Pack Embedding ${toolName}`;
    const pgName        = `PG ${toolName}`;
    const fmtName       = `Fmt ${toolName}`;

    addNode(embedNodeName, 'n8n-nodes-base.httpRequest', {
        method: 'POST',
        url: 'https://api.openai.com/v1/embeddings',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'openAiApi',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
        sendBody: true, specifyBody: 'json',
        jsonBody: `={\n  "model": "${EMBED_MODEL}",\n  "input": ${embedTextExpr},\n  "encoding_format": "float"\n}`,
        options: {}
    }, xT - 220, yT0, { tv: 4.2, creds: { openAiApi: OPENAI } });
    connect('Tool Router', embedNodeName, idx);

    addNode(packNodeName, 'n8n-nodes-base.code', {
        jsCode: `const resp = $input.first().json;
const inp = $('Normalize Input').first().json;
const emb = resp?.data?.[0]?.embedding;
if (!Array.isArray(emb)) {
  return [{ json: { ok: false, tool: '${toolName}', error: 'embedding API failed: ' + JSON.stringify(resp).slice(0, 200) } }];
}
// Formato literal de pgvector: '[1.2,3.4,...]' (sin espacios para no inflar SQL)
const embStr = '[' + emb.join(',') + ']';
return [{ json: { ...inp, embedding: embStr } }];`
    }, xPack, yT0);
    connect(embedNodeName, packNodeName);

    addNode(pgName, 'n8n-nodes-base.postgres', {
        operation: 'executeQuery',
        query: sqlQuery,
        options: { queryReplacement: '={{ $json.user_id }},={{ $json.params_json }},={{ $json.embedding }}' }
    }, xPg, yT0, { tv: 2.5, creds: { postgres: PG }, always: true, cof: true });
    connect(packNodeName, pgName);

    const inner = formatJs;
    const wrapped = `try {
  const first = $input.first()?.json || {};
  if (first.ok === false && first.error) return [{ json: first }];
  if (first.error || first.message?.includes?.('error')) {
    return [{ json: { ok: false, tool: '${toolName}', error: String(first.error || first.message || 'SQL error') } }];
  }
${inner}
} catch (e) {
  return [{ json: { ok: false, tool: '${toolName}', error: 'Format error: ' + (e?.message || String(e)) } }];
}`;
    addNode(fmtName, 'n8n-nodes-base.code', { jsCode: wrapped }, xFmt, yT0);
    connect(pgName, fmtName);
    // Si el Pack devuelve {ok:false,error}, también lo dejamos pasar al Fmt
    connect(packNodeName, fmtName);
    return fmtName;
};

// remember_fact: agente pasa {content, kind?, metadata?}
// metadata viene como JSON-STRING (no objeto), se castea con NULLIF→jsonb. Si no parsea o vacío, default {}.
formatNames.push(addEmbeddingPgTool(
    TOOLS.indexOf('remember_fact'),
    'remember_fact',
    `{{ JSON.stringify($json.params.content || '') }}`,
    `SELECT * FROM add_memory_chunk(
        $1::uuid,
        COALESCE(NULLIF($2::jsonb->>'kind',''), 'fact'),
        $2::jsonb->>'content',
        $3::vector(1536),
        COALESCE(
            CASE WHEN ($2::jsonb->>'metadata') IS NOT NULL
                 AND length(trim($2::jsonb->>'metadata')) > 0
                 AND ($2::jsonb->>'metadata') <> '{}'
            THEN ($2::jsonb->>'metadata')::jsonb
            ELSE '{}'::jsonb END,
            '{}'::jsonb
        )
    );`,
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'remember_fact', data: {
  id: r.id, was_created: !!r.was_created, content: r.content, kind: r.kind
} } }];`
));

// update_memory: agente pasa {memory_id, new_content, kind?, metadata?}
// metadata como JSON-STRING; se castea a jsonb si no está vacío.
formatNames.push(addEmbeddingPgTool(
    TOOLS.indexOf('update_memory'),
    'update_memory',
    `{{ JSON.stringify($json.params.new_content || '') }}`,
    `SELECT * FROM update_memory_chunk(
        $1::uuid,
        ($2::jsonb->>'memory_id')::uuid,
        $2::jsonb->>'new_content',
        $3::vector(1536),
        NULLIF($2::jsonb->>'kind',''),
        CASE WHEN ($2::jsonb->>'metadata') IS NOT NULL
             AND length(trim($2::jsonb->>'metadata')) > 0
             AND ($2::jsonb->>'metadata') <> '{}'
        THEN ($2::jsonb->>'metadata')::jsonb
        ELSE NULL END
    );`,
    `const r = $input.first().json;
if (!r || !r.updated) {
  return [{ json: { ok: false, tool: 'update_memory', error: 'No encontré ese recuerdo o no es tuyo' } }];
}
return [{ json: { ok: true, tool: 'update_memory', data: {
  id: r.id, content: r.content, kind: r.kind
} } }];`
));

// recall_memory: agente pasa {query, k?, kind?, min_score?}
formatNames.push(addEmbeddingPgTool(
    TOOLS.indexOf('recall_memory'),
    'recall_memory',
    `{{ JSON.stringify($json.params.query || '') }}`,
    `SELECT * FROM search_memory_chunks(
        $1::uuid,
        $3::vector(1536),
        COALESCE(NULLIF($2::jsonb->>'k','')::int, 5),
        NULLIF($2::jsonb->>'kind',''),
        COALESCE(NULLIF($2::jsonb->>'min_score','')::real, 0.5)
    );`,
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'recall_memory', data: {
  matches: rows.map(r => ({
    id: r.id, kind: r.kind, content: r.content,
    metadata: r.metadata, similarity: Number(r.similarity || 0),
    created_at: r.created_at, recall_count: Number(r.recall_count || 0)
  })),
  count: rows.length
} } }];`
));

// forget_memory: agente pasa {memory_id} — soft-delete por id
formatNames.push(addPgTool(TOOLS.indexOf('forget_memory'), 'forget_memory',
    `SELECT * FROM forget_memory_chunk(
        $1::uuid,
        ($2::jsonb->>'memory_id')::uuid
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const r = $input.first().json;
if (!r || !r.forgot) {
  return [{ json: { ok: false, tool: 'forget_memory', error: 'No encontré ese recuerdo o no es tuyo' } }];
}
return [{ json: { ok: true, tool: 'forget_memory', data: { id: r.id, forgot: !!r.forgot } } }];`
));

// list_memories: agente pasa {kind?, limit?}
formatNames.push(addPgTool(TOOLS.indexOf('list_memories'), 'list_memories',
    `SELECT * FROM list_memory_chunks(
        $1::uuid,
        NULLIF($2::jsonb->>'kind',''),
        COALESCE(NULLIF($2::jsonb->>'limit','')::int, 20)
    );`,
    "={{ $json.user_id }},={{ $json.params_json }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'list_memories', data: {
  memories: rows.map(r => ({
    id: r.id, kind: r.kind, content: r.content, metadata: r.metadata,
    created_at: r.created_at, recall_count: Number(r.recall_count || 0)
  })),
  count: rows.length
} } }];`
));

// =========================================================================
// 4. UNKNOWN TOOL FALLBACK
// =========================================================================
const unknownIdx = TOOLS.length; // fallback output index
addNode('Unknown Tool', 'n8n-nodes-base.code', {
    jsCode: `const inp = $input.first().json;
return [{ json: { ok: false, tool: inp.tool_name, error: 'Unknown tool: ' + inp.tool_name } }];`
}, xT, -800 + (TOOLS.length + 1) * Y_STEP);
connect('Tool Router', 'Unknown Tool', unknownIdx);

// =========================================================================
// 5. MERGE OUTPUTS into single response
// =========================================================================
const allOutputs = [...formatNames, 'Unknown Tool'];

// Single Merge node would have N inputs — n8n has Merge with up to many inputs but
// it's simpler to pass through: each branch ends; only one runs per execution.
// We just need a final passthrough node so the caller sees a uniform output.
addNode('Wrap Output', 'n8n-nodes-base.code', {
    jsCode: `const out = $input.first().json;
return [{ json: out }];`
}, xT + 460, 0);
allOutputs.forEach(n => connect(n, 'Wrap Output'));

// =========================================================================
// 6. EMIT JSON
// =========================================================================
const wf = {
    id: 'chefin_tools_v3',
    name: 'Chefin Agent Tools v3',
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: { executionOrder: 'v1', timezone: 'America/Argentina/Buenos_Aires' },
    meta: { templateCredsSetupCompleted: true },
    tags: []
};
process.stdout.write(JSON.stringify(wf, null, 2));
