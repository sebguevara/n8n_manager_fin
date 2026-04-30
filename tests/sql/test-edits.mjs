#!/usr/bin/env node
// End-to-end test of EVERY edit operation.
// Each scenario:
//   1. Seeds a known starting state
//   2. Runs the tool's SQL with realistic params (the same SQL the n8n tool node runs)
//   3. Asserts the expected state change is persisted in the DB
//
// If anything fails, the script prints the failing scenario and the actual vs
// expected DB state. Goal: zero false negatives, zero false positives.
//
// Usage:
//   node tests/sql/test-edits.mjs [--filter substring]

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:');
const SRC = readFileSync(join(ROOT, 'build-tools-subworkflow.js'), 'utf8');

const filterArg = process.argv.indexOf('--filter');
const filter = filterArg >= 0 ? process.argv[filterArg + 1] : null;

const SHELL = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
function psql(script) {
    try {
        const out = execSync(
            `docker compose -f docker-compose.yml exec -T n8n_postgres sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -v ON_ERROR_STOP=1 -t -A -F"|" -U $POSTGRES_USER -d expenses'`,
            { encoding: 'utf8', input: script, stdio: ['pipe', 'pipe', 'pipe'], shell: SHELL }
        );
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

// Extract a tool's SQL template from build-tools-subworkflow.js
function getToolSql(name) {
    const re = new RegExp(`addPgTool\\(\\s*(?:\\d+|TOOLS\\.indexOf\\('${name}'\\))\\s*,\\s*'${name}'\\s*,\\s*(?:\\/\\/[^\\n]*\\n\\s*)*(?:\`([\\s\\S]*?)\`|'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`);
    const m = SRC.match(re);
    if (!m) throw new Error(`Tool not found: ${name}`);
    return (m[1] || m[2] || m[3]).replace(/\\\$/g, '$').replace(/\\"/g, '"');
}

// Helper: invoke a tool's SQL with (uid, params)
function runTool(uid, name, params) {
    const sql = getToolSql(name);
    const json = JSON.stringify(params);
    const script = `PREPARE stmt AS ${sql}; EXECUTE stmt('${uid}', $cf$${json}$cf$::jsonb); DEALLOCATE stmt;`;
    return psql(script);
}
function runToolSingleArg(uid, name) {
    const sql = getToolSql(name);
    const script = `PREPARE stmt AS ${sql}; EXECUTE stmt('${uid}'); DEALLOCATE stmt;`;
    return psql(script);
}

// Setup: fresh test user with seed data
function setup() {
    const out = psql(`
DELETE FROM users WHERE phone_number = '__TEST_EDITS__';
SELECT bootstrap_user('__TEST_EDITS__', 'Edit Tester') AS uid;
`);
    if (!out.ok) throw new Error('Setup failed: ' + out.out);
    const uid = out.out.split('\n').filter(l => /^[a-f0-9-]{36}$/.test(l.trim()))[0];
    if (!uid) throw new Error('Could not extract uid: ' + out.out);
    return uid;
}
function teardown() {
    psql(`DELETE FROM users WHERE phone_number = '__TEST_EDITS__';`);
}

// Tiny assertion helpers
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => { if (!cond) throw new Error('Assertion failed: ' + msg); };
const eq = (a, b, msg) => assert(String(a).trim() === String(b).trim(), `${msg} — expected "${b}", got "${a}"`);

// =======================================================================
// 1. UPDATE_TRANSACTION — amount, description, date, category by hint
// =======================================================================
test('update_transaction: change amount', (uid) => {
    psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date)
          VALUES ('${uid}', 'expense', 1000, 'café del finde', CURRENT_DATE);`);
    const tx = psql(`SELECT id FROM transactions WHERE user_id='${uid}' LIMIT 1;`).out.trim();
    const r = runTool(uid, 'update_transaction', { transaction_id: tx, new_amount: 2500 });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT amount::int FROM transactions WHERE id='${tx}';`).out.trim();
    eq(after, '2500', 'amount not updated');
});

test('update_transaction: change description', (uid) => {
    psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date)
          VALUES ('${uid}', 'expense', 1000, 'desc original', CURRENT_DATE);`);
    const tx = psql(`SELECT id FROM transactions WHERE user_id='${uid}' LIMIT 1;`).out.trim();
    const r = runTool(uid, 'update_transaction', { transaction_id: tx, new_description: 'desc nueva' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT description FROM transactions WHERE id='${tx}';`).out.trim();
    eq(after, 'desc nueva', 'description not updated');
});

test('update_transaction: change date', (uid) => {
    psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date)
          VALUES ('${uid}', 'expense', 1000, 'café', CURRENT_DATE);`);
    const tx = psql(`SELECT id FROM transactions WHERE user_id='${uid}' LIMIT 1;`).out.trim();
    const r = runTool(uid, 'update_transaction', { transaction_id: tx, new_date: '2026-01-15' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT transaction_date FROM transactions WHERE id='${tx}';`).out.trim();
    eq(after, '2026-01-15', 'date not updated');
});

test('update_transaction: change category by hint', (uid) => {
    const catComida = psql(`SELECT id FROM categories WHERE user_id='${uid}' AND normalized_name='comida' LIMIT 1;`).out.trim();
    const catSuper = psql(`SELECT id FROM categories WHERE user_id='${uid}' AND normalized_name='supermercado' LIMIT 1;`).out.trim();
    psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date, category_id)
          VALUES ('${uid}', 'expense', 1000, 'algo', CURRENT_DATE, '${catComida}');`);
    const tx = psql(`SELECT id FROM transactions WHERE user_id='${uid}' LIMIT 1;`).out.trim();
    const r = runTool(uid, 'update_transaction', { transaction_id: tx, new_category_hint: 'supermercado' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT category_id FROM transactions WHERE id='${tx}';`).out.trim();
    eq(after, catSuper, 'category not switched');
});

test('update_transaction: create category if missing', (uid) => {
    psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date)
          VALUES ('${uid}', 'expense', 1000, 'algo', CURRENT_DATE);`);
    const tx = psql(`SELECT id FROM transactions WHERE user_id='${uid}' LIMIT 1;`).out.trim();
    const r = runTool(uid, 'update_transaction', {
        transaction_id: tx, new_category_hint: 'mascotas', create_category_if_missing: true
    });
    assert(r.ok, 'tool errored: ' + r.out);
    const newCat = psql(`SELECT id FROM categories WHERE user_id='${uid}' AND normalized_name='mascotas';`).out.trim();
    assert(newCat, 'category not created');
    const txCat = psql(`SELECT category_id FROM transactions WHERE id='${tx}';`).out.trim();
    eq(txCat, newCat, 'tx not linked to new category');
});

// =======================================================================
// 2. BULK_UPDATE — multiple tx at once
// =======================================================================
test('bulk_update: SET new amount on N tx (absolute)', (uid) => {
    for (let i = 0; i < 3; i++) {
        psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date)
              VALUES ('${uid}', 'expense', 100, 'tx${i}', CURRENT_DATE);`);
    }
    const ids = psql(`SELECT id FROM transactions WHERE user_id='${uid}' AND amount=100;`).out.trim().split('\n');
    const r = runTool(uid, 'bulk_update', { ids, new_amount: 999 });
    assert(r.ok, 'tool errored: ' + r.out);
    const updated = psql(`SELECT COUNT(*)::int FROM transactions WHERE user_id='${uid}' AND amount=999;`).out.trim();
    eq(updated, '3', 'not all 3 set to 999');
});

test('bulk_update: amount_delta (relative shift)', (uid) => {
    for (let i = 0; i < 2; i++) {
        psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date)
              VALUES ('${uid}', 'expense', 500, 'tx${i}', CURRENT_DATE);`);
    }
    const ids = psql(`SELECT id FROM transactions WHERE user_id='${uid}' AND amount=500;`).out.trim().split('\n');
    const r = runTool(uid, 'bulk_update', { ids, amount_delta: 250 });
    assert(r.ok, 'tool errored: ' + r.out);
    const updated = psql(`SELECT COUNT(*)::int FROM transactions WHERE user_id='${uid}' AND amount=750;`).out.trim();
    eq(updated, '2', 'amount_delta did not shift both by +250');
});

test('bulk_update: change category by hint', (uid) => {
    const catSuper = psql(`SELECT id FROM categories WHERE user_id='${uid}' AND normalized_name='supermercado' LIMIT 1;`).out.trim();
    for (let i = 0; i < 2; i++) {
        psql(`INSERT INTO transactions (user_id, type, amount, description, transaction_date)
              VALUES ('${uid}', 'expense', 200, 'tx${i}', CURRENT_DATE);`);
    }
    const ids = psql(`SELECT id FROM transactions WHERE user_id='${uid}' AND amount=200;`).out.trim().split('\n');
    const r = runTool(uid, 'bulk_update', { ids, new_category_hint: 'supermercado' });
    assert(r.ok, 'tool errored: ' + r.out);
    const updated = psql(`SELECT COUNT(*)::int FROM transactions WHERE user_id='${uid}' AND amount=200 AND category_id='${catSuper}';`).out.trim();
    eq(updated, '2', 'not all 2 categorized');
});

// =======================================================================
// 3. UPDATE_RECURRING — amount, description, frequency, next_occurrence, category, end_date
// =======================================================================
test('update_recurring: change amount', (uid) => {
    psql(`INSERT INTO recurring_transactions (user_id, type, amount, description, frequency, next_occurrence)
          VALUES ('${uid}', 'expense', 5000, 'netflix', 'monthly', CURRENT_DATE + 5);`);
    const r_id = psql(`SELECT id FROM recurring_transactions WHERE user_id='${uid}';`).out.trim();
    const r = runTool(uid, 'update_recurring', { recurring_id: r_id, new_amount: 8500 });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT amount::int FROM recurring_transactions WHERE id='${r_id}';`).out.trim();
    eq(after, '8500', 'amount not updated');
});

test('update_recurring: change next_occurrence', (uid) => {
    psql(`INSERT INTO recurring_transactions (user_id, type, amount, description, frequency, next_occurrence)
          VALUES ('${uid}', 'expense', 340000, 'alquiler', 'monthly', '2026-04-30');`);
    const r_id = psql(`SELECT id FROM recurring_transactions WHERE user_id='${uid}';`).out.trim();
    const r = runTool(uid, 'update_recurring', { recurring_id: r_id, new_next_occurrence: '2026-05-01' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT next_occurrence FROM recurring_transactions WHERE id='${r_id}';`).out.trim();
    eq(after, '2026-05-01', 'next_occurrence not updated');
});

test('update_recurring: change frequency', (uid) => {
    psql(`INSERT INTO recurring_transactions (user_id, type, amount, description, frequency, next_occurrence)
          VALUES ('${uid}', 'expense', 5000, 'gym', 'monthly', CURRENT_DATE + 5);`);
    const r_id = psql(`SELECT id FROM recurring_transactions WHERE user_id='${uid}';`).out.trim();
    const r = runTool(uid, 'update_recurring', { recurring_id: r_id, new_frequency: 'yearly' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT frequency FROM recurring_transactions WHERE id='${r_id}';`).out.trim();
    eq(after, 'yearly', 'frequency not updated');
});

test('update_recurring: change category by hint', (uid) => {
    const catComida = psql(`SELECT id FROM categories WHERE user_id='${uid}' AND normalized_name='comida' LIMIT 1;`).out.trim();
    psql(`INSERT INTO recurring_transactions (user_id, type, amount, description, frequency, next_occurrence)
          VALUES ('${uid}', 'expense', 5000, 'pedido ya', 'monthly', CURRENT_DATE + 5);`);
    const r_id = psql(`SELECT id FROM recurring_transactions WHERE user_id='${uid}';`).out.trim();
    const r = runTool(uid, 'update_recurring', { recurring_id: r_id, new_category_hint: 'comida' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT category_id FROM recurring_transactions WHERE id='${r_id}';`).out.trim();
    eq(after, catComida, 'category not updated');
});

test('update_recurring: change end_date', (uid) => {
    psql(`INSERT INTO recurring_transactions (user_id, type, amount, description, frequency, next_occurrence)
          VALUES ('${uid}', 'expense', 5000, 'temporal', 'monthly', CURRENT_DATE + 5);`);
    const r_id = psql(`SELECT id FROM recurring_transactions WHERE user_id='${uid}';`).out.trim();
    const r = runTool(uid, 'update_recurring', { recurring_id: r_id, new_end_date: '2026-12-31' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT end_date FROM recurring_transactions WHERE id='${r_id}';`).out.trim();
    eq(after, '2026-12-31', 'end_date not updated');
});

// =======================================================================
// 4. UPDATE_GROUP / RENAME_GROUP / CLOSE_GROUP
// =======================================================================
test('update_group: rename via update_group', (uid) => {
    psql(`SELECT upsert_group('${uid}', 'viaje original', 'trip');`);
    const r = runTool(uid, 'update_group', { name: 'viaje original', new_name: 'viaje nuevo' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT name FROM expense_groups WHERE user_id='${uid}';`).out.trim();
    eq(after, 'viaje nuevo', 'group not renamed');
});

test('update_group: change kind', (uid) => {
    psql(`SELECT upsert_group('${uid}', 'evento test', 'event');`);
    const r = runTool(uid, 'update_group', { name: 'evento test', new_kind: 'project' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT kind FROM expense_groups WHERE user_id='${uid}';`).out.trim();
    eq(after, 'project', 'kind not updated');
});

test('update_group: change date range', (uid) => {
    psql(`SELECT upsert_group('${uid}', 'viaje fechas', 'trip');`);
    const r = runTool(uid, 'update_group', {
        name: 'viaje fechas', new_starts_at: '2026-06-01', new_ends_at: '2026-06-15'
    });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT starts_at::text || '|' || ends_at::text FROM expense_groups WHERE user_id='${uid}';`).out.trim();
    eq(after, '2026-06-01|2026-06-15', 'date range not updated');
});

test('rename_group', (uid) => {
    psql(`SELECT upsert_group('${uid}', 'old grp', 'event');`);
    const r = runTool(uid, 'rename_group', { old_name: 'old grp', new_name: 'new grp' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT name FROM expense_groups WHERE user_id='${uid}';`).out.trim();
    eq(after, 'new grp', 'rename did not stick');
});

test('close_group', (uid) => {
    psql(`SELECT upsert_group('${uid}', 'cerrame', 'trip');`);
    const r = runTool(uid, 'close_group', { name: 'cerrame' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT is_active FROM expense_groups WHERE user_id='${uid}';`).out.trim();
    eq(after, 'f', 'group not deactivated');
});

// =======================================================================
// 5. RENAME_CATEGORY
// =======================================================================
test('rename_category', (uid) => {
    psql(`SELECT category_id FROM resolve_or_create_category('${uid}', 'salidas', 'expense');`);
    const r = runTool(uid, 'rename_category', { old_name: 'salidas', new_name: 'eventos sociales' });
    assert(r.ok, 'tool errored: ' + r.out);
    // INITCAP applied by SQL: stored as "Eventos Sociales", normalized as "eventos sociales"
    const after = psql(`SELECT name FROM categories WHERE user_id='${uid}' AND normalized_name='eventos sociales';`).out.trim();
    eq(after, 'Eventos Sociales', 'category not renamed (INITCAP applied)');
});

// =======================================================================
// 6. SET_BUDGET (UPSERT)
// =======================================================================
test('set_budget: insert new', (uid) => {
    const r = runTool(uid, 'set_budget', { category_hint: 'comida', amount: 50000, period: 'monthly' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT amount::int FROM budgets b
        JOIN categories c ON c.id=b.category_id
        WHERE b.user_id='${uid}' AND c.normalized_name='comida' AND b.period='monthly' AND b.is_active;`).out.trim();
    eq(after, '50000', 'budget not inserted');
});

test('set_budget: upsert existing (replace amount)', (uid) => {
    runTool(uid, 'set_budget', { category_hint: 'comida', amount: 50000, period: 'monthly' });
    const r = runTool(uid, 'set_budget', { category_hint: 'comida', amount: 75000, period: 'monthly' });
    assert(r.ok, 'tool errored: ' + r.out);
    const count = psql(`SELECT COUNT(*)::int FROM budgets b
        JOIN categories c ON c.id=b.category_id
        WHERE b.user_id='${uid}' AND c.normalized_name='comida' AND b.period='monthly' AND b.is_active;`).out.trim();
    eq(count, '1', 'duplicate budget created (should upsert)');
    const after = psql(`SELECT amount::int FROM budgets b
        JOIN categories c ON c.id=b.category_id
        WHERE b.user_id='${uid}' AND c.normalized_name='comida' AND b.period='monthly' AND b.is_active;`).out.trim();
    eq(after, '75000', 'budget amount not updated');
});

// =======================================================================
// 7. RENAME_TAG
// =======================================================================
test('rename_tag', (uid) => {
    psql(`SELECT create_tag('${uid}', 'oficina-vieja', NULL);`);
    const r = runTool(uid, 'rename_tag', { old_name: 'oficina-vieja', new_name: 'oficina-nueva' });
    assert(r.ok, 'tool errored: ' + r.out);
    // INITCAP applied: "oficina-nueva" → "Oficina-Nueva"
    const after = psql(`SELECT name FROM tags WHERE user_id='${uid}';`).out.trim();
    eq(after, 'Oficina-Nueva', 'tag not renamed (INITCAP applied)');
});

// =======================================================================
// 8. UPDATE_SETTINGS — partial updates (only changed fields)
// =======================================================================
test('update_settings: change name only', (uid) => {
    const r = runTool(uid, 'update_settings', { name: 'Nombre Nuevo' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT name FROM users WHERE id='${uid}';`).out.trim();
    eq(after, 'Nombre Nuevo', 'name not updated');
});

test('update_settings: change daily_summary_hour', (uid) => {
    const r = runTool(uid, 'update_settings', { daily_summary_hour: 20 });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT daily_summary_hour FROM users WHERE id='${uid}';`).out.trim();
    eq(after, '20', 'hour not updated');
});

test('update_settings: disable daily summary', (uid) => {
    const r = runTool(uid, 'update_settings', { daily_summary_enabled: 'false' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT daily_summary_enabled FROM users WHERE id='${uid}';`).out.trim();
    eq(after, 'f', 'daily_summary not disabled');
});

test('update_settings: partial does NOT clobber other fields', (uid) => {
    runTool(uid, 'update_settings', { name: 'Antes', preferred_currency: 'USD', daily_summary_hour: 9 });
    const r = runTool(uid, 'update_settings', { name: 'Despues' });
    assert(r.ok, 'tool errored: ' + r.out);
    const after = psql(`SELECT name || '|' || preferred_currency || '|' || daily_summary_hour::text FROM users WHERE id='${uid}';`).out.trim();
    eq(after, 'Despues|USD|9', 'partial update clobbered other fields');
});

// =======================================================================
// 9. PAUSE / RESUME / CANCEL recurring (state changes count as edits)
// =======================================================================
test('pause_recurring → resume_recurring round trip', (uid) => {
    psql(`INSERT INTO recurring_transactions (user_id, type, amount, description, frequency, next_occurrence)
          VALUES ('${uid}', 'expense', 5000, 'spotify', 'monthly', CURRENT_DATE + 5);`);
    const r_id = psql(`SELECT id FROM recurring_transactions WHERE user_id='${uid}';`).out.trim();

    const pauseRes = runTool(uid, 'pause_recurring', { recurring_id: r_id });
    assert(pauseRes.ok, 'pause errored');
    const paused = psql(`SELECT is_active FROM recurring_transactions WHERE id='${r_id}';`).out.trim();
    eq(paused, 'f', 'pause did not deactivate');

    const resumeRes = runTool(uid, 'resume_recurring', { recurring_id: r_id });
    assert(resumeRes.ok, 'resume errored');
    const resumed = psql(`SELECT is_active FROM recurring_transactions WHERE id='${r_id}';`).out.trim();
    eq(resumed, 't', 'resume did not reactivate');
});

test('pause_budget → resume_budget round trip', (uid) => {
    runTool(uid, 'set_budget', { category_hint: 'comida', amount: 50000, period: 'monthly' });
    const pauseRes = runTool(uid, 'pause_budget', { category_hint: 'comida', period: 'monthly' });
    assert(pauseRes.ok, 'pause errored: ' + pauseRes.out);
    const paused = psql(`SELECT b.is_active FROM budgets b JOIN categories c ON c.id=b.category_id
                          WHERE b.user_id='${uid}' AND c.normalized_name='comida';`).out.trim();
    eq(paused, 'f', 'budget pause did not deactivate');

    const resumeRes = runTool(uid, 'resume_budget', { category_hint: 'comida', period: 'monthly' });
    assert(resumeRes.ok, 'resume errored: ' + resumeRes.out);
    const resumed = psql(`SELECT b.is_active FROM budgets b JOIN categories c ON c.id=b.category_id
                          WHERE b.user_id='${uid}' AND c.normalized_name='comida';`).out.trim();
    eq(resumed, 't', 'budget resume did not reactivate');
});

// =======================================================================
// 10. TOGGLE_CATEGORY_EXCLUSION (edit-like state flip)
// =======================================================================
test('toggle_category_exclusion: flips bidirectionally', (uid) => {
    const r1 = runTool(uid, 'toggle_category_exclusion', { category_hint: 'comida' });
    assert(r1.ok, 'first toggle errored');
    const after1 = psql(`SELECT excluded_from_reports FROM categories WHERE user_id='${uid}' AND normalized_name='comida';`).out.trim();
    eq(after1, 't', 'first toggle did not exclude');

    const r2 = runTool(uid, 'toggle_category_exclusion', { category_hint: 'comida' });
    assert(r2.ok, 'second toggle errored');
    const after2 = psql(`SELECT excluded_from_reports FROM categories WHERE user_id='${uid}' AND normalized_name='comida';`).out.trim();
    eq(after2, 'f', 'second toggle did not include back');
});

// =======================================================================
// RUN
// =======================================================================
let pass = 0, fail = 0;
const failures = [];

console.log(`\n=== Edit operations test — ${tests.length} scenarios ===\n`);

const start = Date.now();
for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    teardown();
    const uid = setup();
    try {
        t.fn(uid);
        console.log(`✓ ${t.name}`);
        pass++;
    } catch (e) {
        console.log(`✗ ${t.name}`);
        console.log(`  ${e.message}`);
        fail++;
        failures.push({ name: t.name, error: e.message });
    }
}
teardown();
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\n=== ${pass} pass · ${fail} fail · ${elapsed}s ===`);
if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ${f.name}: ${f.error}`));
    process.exit(1);
}
