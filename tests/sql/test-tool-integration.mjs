#!/usr/bin/env node
// Integration test for the tool→SQL boundary.
// Extracts every SQL query embedded in build-tools-subworkflow.js, then
// executes each one against the live postgres container with realistic
// JSONB params. The goal is to catch wiring bugs that unit tests miss:
// wrong cast types, missing keys, function-signature drift, etc.
//
// Usage: node tests/sql/test-tool-integration.mjs [--filter name]

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:');
const SRC = readFileSync(join(ROOT, 'build-tools-subworkflow.js'), 'utf8');

const filterArg = process.argv.indexOf('--filter');
const filter = filterArg >= 0 ? process.argv[filterArg + 1] : null;

// ---- Realistic params per tool (what the LLM would actually send) -------
const SCENARIOS = {
    query_transactions:        { period: 'this_month', limit: 5 },
    get_total:                 { period: 'this_month', type: 'expense' },
    get_breakdown:             { dimension: 'category', period: 'this_month', type: 'expense' },
    compare_periods:           { period_a: 'this_month', period_b: 'last_month', type: 'expense' },
    find_transactions:         { description_contains: 'café', limit: 5 },
    find_duplicates:           { window_days: 7, min_repetitions: 2 },
    bulk_preview:              { description_contains: 'café' },
    bulk_delete:               { ids: ['__SEED_TX_ID__'] },
    log_transaction:           { amount: 1234, description: 'test café', category_hint: 'café', type: 'expense', create_category_if_missing: true },
    list_categories:           {},
    list_groups:               {},
    list_budgets:              {},
    set_budget:                { category_hint: 'café', amount: 50000, period: 'monthly' },
    create_group:              { name: 'test trip', kind: 'trip' },
    toggle_category_exclusion: { category_hint: 'café' },
    set_recurring:             { amount: 5500, description: 'test recurring', category_hint: 'café', frequency: 'monthly', start_date: '2026-05-01' },
    remember_last_list:        { kind: 'transactions', items: [{ position: 1, id: '00000000-0000-0000-0000-000000000001' }] },
    get_last_list:             {},
    set_conv_state:            { state: 'awaiting_category', context: { amount: 3300 }, ttl_seconds: 600 },
    clear_conv_state:          {},
    create_category:           { name: 'test cat', type: 'expense' },
    rename_category:           { old_name: 'no-existe', new_name: 'tampoco' },
    delete_category:           { name: 'no-existe' },
    list_recurring:            { active_only: true },
    find_recurring_by_hint:    { hint: 'Netflix' },
    update_recurring:          { recurring_id: '__SEED_RID__', new_next_occurrence: '2026-05-01' },
    pause_recurring:           { recurring_id: '__SEED_RID__' },
    resume_recurring:          { recurring_id: '__SEED_RID__' },
    cancel_recurring:          { recurring_id: '__SEED_RID__' },
    update_group:              { name: 'test trip', new_name: 'test trip 2' },
    rename_group:              { old_name: 'test trip 2', new_name: 'test trip 3' },
    close_group:               { name: 'test trip 3' },
    delete_group:              { name: 'test trip 3', unassign: true },
    delete_budget:             { category_hint: 'café' },
    pause_budget:              { category_hint: 'café' },
    resume_budget:             { category_hint: 'café' },
    create_tag:                { name: 'test-tag' },
    rename_tag:                { old_name: 'no-existe', new_name: 'tampoco' },
    delete_tag:                { name: 'no-existe' },
    list_tags:                 {},
    tag_transactions:          { tag_name: 'oficina', tx_ids: ['__SEED_TX_ID__'], create_if_missing: true },
    untag_transactions:        { tag_name: 'oficina', tx_ids: ['__SEED_TX_ID__'] },
    suggest_tags:              { description: 'café', limit: 3 },
    get_settings:              {},
    update_settings:           { preferred_currency: 'USD' },
    financial_advice:          { mode: 'savings_capacity' },
    forget_memory:             { memory_id: '00000000-0000-0000-0000-000000000000' },
    list_memories:             { limit: 10 },

    update_transaction:        { transaction_id: '__SEED_TX_ID__', new_amount: 555 },
    delete_transaction:        { transaction_id: '__SEED_TX_ID__' },
    bulk_update:               { ids: ['__SEED_TX_ID__'], new_amount: 100 }
};

// Memory tools that need an embedding are skipped — they require a live
// embedding API call. We test them separately with a fake-vector hack.
const SKIP_NEEDS_EMBEDDING = new Set(['remember_fact', 'recall_memory', 'update_memory']);
// generate_chart is wired manually (not via addPgTool) — the chart-data SQL
// is exercised via get_breakdown internally.
const SKIP_NOT_PG_TOOL = new Set(['generate_chart']);

// ---- Extract SQL templates from the build script ------------------------
function extractTools() {
    // Allow JS line comments before the SQL string and accept all 3 string
    // styles used in the build script: backtick (multi-line), single-quoted,
    // double-quoted (one-liners). Replacement expr always uses double quotes.
    const tools = [];
    const re = /addPgTool\(\s*(?:\d+|TOOLS\.indexOf\('(\w+)'\))\s*,\s*'(\w+)'\s*,\s*(?:\/\/[^\n]*\n\s*)*(?:`([\s\S]*?)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(SRC))) {
        const name = m[2];
        const sqlRaw = m[3] || m[4] || m[5] || '';
        const sql = sqlRaw.replace(/\\\$/g, '$').replace(/\\"/g, '"');
        const replacement = m[6];
        tools.push({ name, sql, replacement });
    }
    return tools;
}

// Convert the n8n queryReplacement expression into actual psql -v vars.
// Most tools use "={{ $json.user_id }},={{ $json.params_json }}" → $1=uuid, $2=jsonb.
function buildPsqlScript(uid, name, sql, params) {
    const paramsJson = JSON.stringify(params).replace(/'/g, "''");
    // The SQL uses $1::uuid and $2::jsonb. Replace literally with PREPARE/EXECUTE.
    return `SET client_min_messages = error;
SELECT '${name}' AS tool;
PREPARE stmt AS ${sql};
EXECUTE stmt('${uid}', $cf$${JSON.stringify(params)}$cf$::jsonb);
DEALLOCATE stmt;
`;
}

// Some tools take only $1 (user_id, no params). Detect that.
function paramCount(sql) {
    const matches = sql.match(/\$\d/g) || [];
    const max = matches.reduce((a, p) => Math.max(a, parseInt(p.slice(1), 10)), 0);
    return max;
}

function buildPsqlScriptAuto(uid, name, sql, params) {
    const n = paramCount(sql);
    if (n === 1) {
        return `SET client_min_messages = error;
PREPARE stmt AS ${sql};
EXECUTE stmt('${uid}');
DEALLOCATE stmt;
`;
    }
    return `SET client_min_messages = error;
PREPARE stmt AS ${sql};
EXECUTE stmt('${uid}', $cf$${JSON.stringify(params)}$cf$::jsonb);
DEALLOCATE stmt;
`;
}

// Use bash explicitly so single-quote-wrapped sh -c doesn't get mangled by cmd.exe
const SHELL = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
function runPsql(script) {
    try {
        const out = execSync(
            `docker compose -f docker-compose.yml exec -T n8n_postgres sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d expenses'`,
            { encoding: 'utf8', input: script, stdio: ['pipe', 'pipe', 'pipe'], shell: SHELL }
        );
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status };
    }
}

// ---- Setup ----------------------------------------------------------------
console.log('Setting up test user...');
const setupSql = readFileSync(join(ROOT, 'tests/sql/00_setup.sql'), 'utf8');
const setup = runPsql(setupSql);
if (!setup.ok) {
    console.error('Setup failed:', setup.out);
    process.exit(2);
}
const uidMatch = setup.out.match(/SETUP_UID=([a-f0-9-]+)/);
if (!uidMatch) {
    console.error('Could not extract setup UID:', setup.out);
    process.exit(2);
}
const UID = uidMatch[1];
console.log('Test user UID:', UID);

// Create real entities so update/delete tools have valid IDs to work on.
const seedRes = runPsql(`
INSERT INTO recurring_transactions (user_id, type, amount, description, frequency, next_occurrence)
VALUES ('${UID}'::uuid, 'expense', 5500, 'Netflix test', 'monthly', CURRENT_DATE + INTERVAL '5 days');
INSERT INTO budgets (user_id, category_id, amount, period, is_active)
SELECT '${UID}'::uuid, c.id, 50000, 'monthly', TRUE
FROM categories c
WHERE c.user_id = '${UID}'::uuid AND c.normalized_name = 'comida';
SELECT upsert_group('${UID}'::uuid, 'test trip', 'trip') AS gid \\gset
SELECT id AS rid FROM recurring_transactions WHERE user_id = '${UID}'::uuid LIMIT 1 \\gset
SELECT create_tag('${UID}'::uuid, 'oficina', NULL) AS tid \\gset
SELECT id AS tx_id FROM transactions WHERE user_id = '${UID}'::uuid LIMIT 1 \\gset
\\echo SEED_GID=:gid
\\echo SEED_RID=:rid
\\echo SEED_TID=:tid
\\echo SEED_TX_ID=:tx_id
`);
if (!seedRes.ok) {
    console.error('Seed failed:', seedRes.out);
    process.exit(2);
}
const SEED = {
    gid: (seedRes.out.match(/SEED_GID=([a-f0-9-]+)/) || [])[1],
    rid: (seedRes.out.match(/SEED_RID=([a-f0-9-]+)/) || [])[1],
    tid: (seedRes.out.match(/SEED_TID=([a-f0-9-]+)/) || [])[1],
    tx_id: (seedRes.out.match(/SEED_TX_ID=([a-f0-9-]+)/) || [])[1]
};
console.log('Seed:', SEED);

// ---- Run all tools --------------------------------------------------------
const tools = extractTools();
console.log(`\n=== Tool integration test — ${tools.length} tools ===\n`);

let pass = 0, fail = 0;
const failures = [];

// Run destructive tools LAST so they don't blow away seeds the others need.
const DESTRUCTIVE = new Set(['bulk_delete', 'delete_transaction', 'delete_category', 'delete_group', 'delete_budget', 'delete_tag', 'cancel_recurring']);
const sortedTools = [
    ...tools.filter(t => !DESTRUCTIVE.has(t.name)),
    ...tools.filter(t => DESTRUCTIVE.has(t.name))
];

function substituteSeeds(obj) {
    if (Array.isArray(obj)) return obj.map(substituteSeeds);
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = substituteSeeds(v);
        return out;
    }
    if (typeof obj === 'string' && obj.startsWith('__SEED_') && obj.endsWith('__')) {
        const key = obj.slice(7, -2).toLowerCase();
        return SEED[key] || obj;
    }
    return obj;
}

for (const tool of sortedTools) {
    if (SKIP_NEEDS_EMBEDDING.has(tool.name) || SKIP_NOT_PG_TOOL.has(tool.name)) continue;
    if (filter && !tool.name.includes(filter)) continue;

    const rawParams = SCENARIOS[tool.name];
    if (!rawParams && paramCount(tool.sql) > 1) {
        console.log(`⚠ ${tool.name}  (no scenario defined, skipping)`);
        continue;
    }
    const params = substituteSeeds(rawParams || {});
    const script = buildPsqlScriptAuto(UID, tool.name, tool.sql, params);
    const res = runPsql(script);
    if (res.ok) {
        console.log(`✓ ${tool.name}`);
        pass++;
    } else {
        console.log(`✗ ${tool.name}`);
        console.log('  ' + res.out.split('\n').filter(l => l.trim()).slice(-6).join('\n  '));
        fail++;
        failures.push({ tool: tool.name, error: res.out });
    }
}

// ---- Cleanup --------------------------------------------------------------
const cleanupSql = readFileSync(join(ROOT, 'tests/sql/99_cleanup.sql'), 'utf8');
runPsql(cleanupSql);

console.log(`\n=== Result: ${pass} pass · ${fail} fail ===`);
if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
        console.log(`\n--- ${f.tool} ---`);
        console.log(f.error.split('\n').filter(l => l.trim()).join('\n'));
    }
    process.exit(1);
}
