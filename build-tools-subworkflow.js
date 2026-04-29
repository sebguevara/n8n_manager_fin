// Builds the Chefin Agent Tools sub-workflow.
// Run with: node build-tools-subworkflow.js > workflows/chefin-tools-v3.json
//
// This sub-workflow is invoked by the main agent workflow once per tool call.
// Input shape (from `Execute Workflow Trigger`):
//   { tool_name: string, user_id: uuid, params: object }
// Output: { ok: boolean, data?: any, error?: string }

const PG = { id: 'f8CCpjEZRkcHEaJI', name: 'Postgres account' };

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
addNode('When Called', 'n8n-nodes-base.executeWorkflowTrigger', {
    inputSource: 'jsonExample',
    jsonExample: JSON.stringify({
        tool_name: 'get_total',
        user_id: '00000000-0000-0000-0000-000000000000',
        params: { period: 'this_month', type: 'expense' }
    }, null, 2)
}, 0, 0, { tv: 1.1 });

// Normalize input
addNode('Normalize Input', 'n8n-nodes-base.code', {
    jsCode: `const inp = $input.first().json;
const tool_name = inp.tool_name || inp.query?.tool_name || '';
const user_id = inp.user_id || inp.query?.user_id || '';
let params = inp.params || inp.query?.params || {};
if (typeof params === 'string') {
  try { params = JSON.parse(params); } catch { params = {}; }
}
if (!user_id) throw new Error('Missing user_id');
if (!tool_name) throw new Error('Missing tool_name');
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
    'generate_chart'
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
    'SELECT * FROM query_tx_dynamic($1::uuid, $2::jsonb, $3::int, $4::int);',
    "={{ $json.user_id }},={{ $json.params_json }},={{ $json.params?.limit || 20 }},={{ $json.params?.offset || 0 }}",
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
    "SELECT * FROM get_breakdown_dynamic($1::uuid, $2::text, $3::jsonb, $4::int);",
    "={{ $json.user_id }},={{ $json.params?.dimension || 'category' }},={{ $json.params_json }},={{ $json.params?.top_n || 10 }}",
    `const rows = $input.all().map(i => i.json);
return [{ json: { ok: true, tool: 'get_breakdown', data: {
  rows: rows.map(r => ({ label: r.label, emoji: r.emoji, total: Number(r.total),
    count: Number(r.count), pct: Number(r.pct_of_total) })),
  total_rows: rows.length
} } }];`
));

// 3. compare_periods
formatNames.push(addPgTool(3, 'compare_periods',
    "SELECT * FROM compare_periods($1::uuid, $2::text, $3::text, $4::text);",
    "={{ $json.user_id }},={{ $json.params?.period_a || 'this_month' }},={{ $json.params?.period_b || 'last_month' }},={{ $json.params?.type || 'expense' }}",
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
        NULLIF($2,'')::text,
        NULLIF($3,'')::date,
        NULLIF($4,'')::date,
        NULLIF($5,'')::date,
        NULLIF($6,'')::numeric,
        NULLIF($7,'')::numeric,
        NULLIF($8,'')::numeric,
        NULLIF($9,'')::text,
        NULLIF($10,'')::text,
        NULLIF($11,'')::text,
        $12::int
    );`,
    "={{ $json.user_id }}," +
    "={{ $json.params?.description_contains || '' }}," +
    "={{ $json.params?.date || '' }}," +
    "={{ $json.params?.date_from || '' }}," +
    "={{ $json.params?.date_to || '' }}," +
    "={{ $json.params?.exact_amount ?? '' }}," +
    "={{ $json.params?.min_amount ?? '' }}," +
    "={{ $json.params?.max_amount ?? '' }}," +
    "={{ $json.params?.category || '' }}," +
    "={{ $json.params?.type || '' }}," +
    "={{ $json.params?.group_name || '' }}," +
    "={{ $json.params?.limit || 20 }}",
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
    "SELECT * FROM find_potential_duplicates($1::uuid, $2::int, $3::int);",
    "={{ $json.user_id }},={{ $json.params?.window_days || 7 }},={{ $json.params?.min_repetitions || 2 }}",
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
    "SELECT * FROM bulk_delete_by_ids($1::uuid, $2::uuid[]);",
    "={{ $json.user_id }},={{ '{' + ($json.params?.ids || []).join(',') + '}' }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'bulk_delete', data: {
  deleted_count: Number(r.deleted_count||0),
  deleted_total: Number(r.deleted_total||0),
  deleted_ids: r.deleted_ids || []
} } }];`
));

// 8. bulk_update → bulk_update_by_ids
formatNames.push(addPgTool(8, 'bulk_update',
    `SELECT * FROM bulk_update_by_ids(
        $1::uuid, $2::uuid[],
        NULLIF($3,'')::uuid,
        NULLIF($4,'')::date,
        NULLIF($5,'')::uuid,
        NULLIF($6,'')::numeric,
        NULLIF($7,'')::boolean
    );`,
    "={{ $json.user_id }}," +
    "={{ '{' + ($json.params?.ids || []).join(',') + '}' }}," +
    "={{ $json.params?.new_category_id || '' }}," +
    "={{ $json.params?.new_date || '' }}," +
    "={{ $json.params?.new_group_id || '' }}," +
    "={{ $json.params?.amount_delta ?? '' }}," +
    "={{ $json.params?.set_excluded ?? '' }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'bulk_update', data: {
  updated_count: Number(r.updated_count||0), updated_ids: r.updated_ids || []
} } }];`
));

// 9. log_transaction (full insert with category match + duplicate check)
formatNames.push(addPgTool(9, 'log_transaction',
    `WITH cat AS (
        SELECT * FROM find_best_category(
            $1::uuid,
            COALESCE(NULLIF($3,''), NULLIF($2,'')),
            COALESCE(NULLIF($8,''), 'expense')
        )
    ),
    dup AS (
        SELECT id, amount, description, transaction_date
        FROM check_duplicate_tx($1::uuid, $4::numeric,
            COALESCE(NULLIF($5,'')::date, CURRENT_DATE), 60)
        WHERE NOT $9::boolean
    ),
    grp AS (
        SELECT CASE WHEN NULLIF($7,'') IS NULL THEN NULL
               ELSE upsert_group($1::uuid, $7, 'event') END AS gid
    ),
    pm AS (
        SELECT id FROM payment_methods
        WHERE user_id=$1::uuid AND normalize_text(name) % normalize_text(NULLIF($6,''))
        ORDER BY similarity(normalize_text(name), normalize_text(COALESCE($6,''))) DESC
        LIMIT 1
    ),
    ins AS (
        INSERT INTO transactions (user_id, type, amount, description, category_id,
            payment_method_id, group_id, transaction_date)
        SELECT $1::uuid, COALESCE(NULLIF($8,''),'expense'), $4::numeric, NULLIF($2,''),
               (SELECT category_id FROM cat),
               (SELECT id FROM pm),
               (SELECT gid FROM grp),
               COALESCE(NULLIF($5,'')::date, CURRENT_DATE)
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
    "={{ $json.user_id }}," +
    "={{ $json.params?.description || '' }}," +
    "={{ $json.params?.category_hint || '' }}," +
    "={{ Number($json.params?.amount || 0) }}," +
    "={{ $json.params?.date || '' }}," +
    "={{ $json.params?.payment_method_hint || '' }}," +
    "={{ $json.params?.group_hint || '' }}," +
    "={{ $json.params?.type || 'expense' }}," +
    "={{ $json.params?.skip_dup_check ? 'true' : 'false' }}",
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
formatNames.push(addPgTool(10, 'update_transaction',
    `SELECT * FROM update_tx(
        $1::uuid, $2::uuid,
        NULLIF($3,'')::date,
        NULLIF($4,'')::numeric,
        NULLIF($5,''),
        NULLIF($6,'')::uuid
    );`,
    "={{ $json.user_id }}," +
    "={{ $json.params?.transaction_id || '' }}," +
    "={{ $json.params?.new_date || '' }}," +
    "={{ $json.params?.new_amount ?? '' }}," +
    "={{ $json.params?.new_description || '' }}," +
    "={{ $json.params?.new_category_id || '' }}",
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
    "SELECT * FROM bulk_delete_by_ids($1::uuid, ARRAY[$2::uuid]::uuid[]);",
    "={{ $json.user_id }},={{ $json.params?.transaction_id || '' }}",
    `const r = $input.first().json;
const cnt = Number(r.deleted_count||0);
if (!cnt) return [{ json: { ok: false, tool: 'delete_transaction', error: 'Transaction not found' } }];
return [{ json: { ok: true, tool: 'delete_transaction', data: {
  deleted_id: (r.deleted_ids||[])[0], deleted_total: Number(r.deleted_total||0)
} } }];`
));

// 12. list_categories
formatNames.push(addPgTool(12, 'list_categories',
    "SELECT * FROM list_categories_with_counts($1::uuid, NULLIF($2,''), $3::boolean);",
    "={{ $json.user_id }},={{ $json.params?.type || '' }},={{ $json.params?.include_excluded ? 'true' : 'false' }}",
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
    `SELECT b.id, b.amount, b.period, c.name AS category_name, c.emoji AS category_emoji,
            COALESCE(s.spent, 0) AS spent, b.is_active
     FROM budgets b
     LEFT JOIN categories c ON c.id = b.category_id
     LEFT JOIN LATERAL (
         SELECT SUM(t.amount) AS spent
         FROM v_reportable_transactions t
         WHERE t.user_id = b.user_id AND t.type = 'expense'
           AND t.category_id = b.category_id
           AND t.transaction_date >= DATE_TRUNC(b.period::text, CURRENT_DATE)
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
    "SELECT * FROM set_budget($1::uuid, NULLIF($2,''), $3::numeric, $4::text);",
    "={{ $json.user_id }},={{ $json.params?.category_hint || '' }},={{ Number($json.params?.amount || 0) }},={{ $json.params?.period || 'monthly' }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'set_budget', data: {
  category: r.category_name || null, amount: Number(r.amount||0), period: r.period
} } }];`
));

// 16. create_group
formatNames.push(addPgTool(16, 'create_group',
    "SELECT name, kind FROM expense_groups WHERE id = upsert_group($1::uuid, $2::text, $3::text);",
    "={{ $json.user_id }},={{ $json.params?.name || 'Sin nombre' }},={{ $json.params?.kind || 'event' }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'create_group', data: { name: r.name, kind: r.kind } } }];`
));

// 17. toggle_category_exclusion
formatNames.push(addPgTool(17, 'toggle_category_exclusion',
    "SELECT * FROM toggle_category_exclusion($1::uuid, $2::text);",
    "={{ $json.user_id }},={{ $json.params?.category_hint || '' }}",
    `const r = $input.first().json;
if (!r || !r.name) return [{ json: { ok: false, tool: 'toggle_category_exclusion', error: 'Category not found' } }];
return [{ json: { ok: true, tool: 'toggle_category_exclusion', data: {
  category: r.name, excluded: r.excluded
} } }];`
));

// 18. set_recurring
formatNames.push(addPgTool(18, 'set_recurring',
    `INSERT INTO recurring_transactions (user_id, type, amount, description, category_id,
        frequency, start_date, is_active)
     SELECT $1::uuid, 'expense', $2::numeric, NULLIF($3,''),
            (SELECT category_id FROM find_best_category($1::uuid, COALESCE(NULLIF($3,''), NULLIF($4,'')), 'expense')),
            $5::text,
            COALESCE(NULLIF($6,'')::date, CURRENT_DATE),
            TRUE
     RETURNING id, amount, description, frequency, start_date;`,
    "={{ $json.user_id }}," +
    "={{ Number($json.params?.amount || 0) }}," +
    "={{ $json.params?.description || '' }}," +
    "={{ $json.params?.category_hint || '' }}," +
    "={{ $json.params?.frequency || 'monthly' }}," +
    "={{ $json.params?.start_date || '' }}",
    `const r = $input.first().json;
return [{ json: { ok: true, tool: 'set_recurring', data: {
  id: r.id, amount: Number(r.amount), description: r.description,
  frequency: r.frequency, start_date: r.start_date
} } }];`
));

// 19. remember_last_list
formatNames.push(addPgTool(19, 'remember_last_list',
    "SELECT remember_last_list($1::uuid, $2::text, $3::jsonb, $4::jsonb, $5::int);",
    "={{ $json.user_id }}," +
    "={{ $json.params?.kind || 'transactions' }}," +
    "={{ JSON.stringify($json.params?.items || []) }}," +
    "={{ JSON.stringify($json.params?.filters_applied || {}) }}," +
    "={{ $json.params?.ttl_seconds || 600 }}",
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
    "SELECT set_conv_state($1::uuid, $2::text, $3::jsonb, $4::int);",
    "={{ $json.user_id }}," +
    "={{ $json.params?.state || '' }}," +
    "={{ JSON.stringify($json.params?.context || {}) }}," +
    "={{ $json.params?.ttl_seconds || 600 }}",
    `return [{ json: { ok: true, tool: 'set_conv_state', data: { saved: true } } }];`
));

// 22. clear_conv_state
formatNames.push(addPgTool(22, 'clear_conv_state',
    "DELETE FROM conversation_state WHERE user_id = $1::uuid;",
    "={{ $json.user_id }}",
    `return [{ json: { ok: true, tool: 'clear_conv_state', data: { cleared: true } } }];`
));

// 23. generate_chart (no SQL — just QuickChart URL builder, but uses Postgres for data)
const chartIdx = 23;
yT = -800 + chartIdx * Y_STEP;
addNode('PG generate_chart', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT * FROM get_breakdown_dynamic($1::uuid, $2::text, $3::jsonb, $4::int);",
    options: {
        queryReplacement: "={{ $json.user_id }},={{ $json.params?.dimension || 'category' }},={{ $json.params_json }},={{ $json.params?.top_n || 10 }}"
    }
}, xT, yT, { tv: 2.5, creds: { postgres: PG }, always: true, cof: true });
connect('Tool Router', 'PG generate_chart', chartIdx);

addNode('Fmt generate_chart', 'n8n-nodes-base.code', {
    jsCode: `const rows = $input.all().map(i => i.json);
const params = $('Normalize Input').first().json.params || {};
const kind = params.kind || params.dimension || 'by_category';
const period = params.period || 'this_month';
const periodLabel = ({this_month:'este mes',last_month:'el mes pasado',this_week:'esta semana',this_year:'este año',today:'hoy',yesterday:'ayer',all:'en total'})[period] || period;
if (!rows.length) {
  return [{ json: { ok: true, tool: 'generate_chart', data: { has_data: false, caption: '📭 No tengo datos para ' + periodLabel + '.' } } }];
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
