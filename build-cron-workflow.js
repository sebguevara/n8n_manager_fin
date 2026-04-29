// Builds the consolidated Chefin cron workflow.
// Run with: node build-cron-workflow.js > workflows/chefin-cron-v3.json
//
// Replaces the 3 separate cron workflows (daily-summary, weekly-summary,
// recurring-processor) with a single organized workflow that includes:
//   - Daily summary (22:00 ART)
//   - Weekly summary (Sunday 21:00)
//   - Recurring transactions processor (06:00 daily)
//   - Cleanup job (03:00 daily) — old chat history + expired conv_states
//   - Budget alerts (every 4 hours, 09:00..21:00)
//   - Manual test trigger (run any job on demand)
//
// All paths converge into a single Send branch with rate-limiting wait.

const PG = { id: 'f8CCpjEZRkcHEaJI', name: 'Postgres account' };
const EVO = { id: 'FgeqqvxAqTER4oeD', name: 'Evolution account' };
const INSTANCE = 'chefin'; // default Evolution instance

let idCounter = 1;
const newId = () => `c${(idCounter++).toString().padStart(3,'0')}`;
const nodes = [];
const connections = {};

const addNode = (name, type, params, x, y, extras = {}) => {
    nodes.push({
        parameters: params, id: newId(), name, type,
        typeVersion: extras.tv || 2, position: [x, y],
        ...(extras.creds && { credentials: extras.creds }),
        ...(extras.cof && { continueOnFail: true }),
        ...(extras.always && { alwaysOutputData: true })
    });
    return name;
};
const connect = (from, to, fromIdx = 0) => {
    if (!connections[from]) connections[from] = { main: [] };
    while (connections[from].main.length <= fromIdx) connections[from].main.push([]);
    connections[from].main[fromIdx].push({ node: to, type: 'main', index: 0 });
};

// =========================================================================
// 1. TRIGGERS (left column)
// =========================================================================

// Daily summary — 22:00 ART
addNode('Cron Daily 22:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 22 * * *' }] }
}, 0, 0, { tv: 1.2 });

// Weekly summary — Sunday 21:00
addNode('Cron Sunday 21:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 21 * * 0' }] }
}, 0, 200, { tv: 1.2 });

// Recurring transactions — 06:00 daily
addNode('Cron Daily 06:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 6 * * *' }] }
}, 0, 400, { tv: 1.2 });

// Cleanup — 03:00 daily
addNode('Cron Daily 03:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 30 3 * * *' }] }
}, 0, 600, { tv: 1.2 });

// Budget alerts — every 4 hours between 09 and 21
addNode('Cron Every 4h', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 9,13,17,21 * * *' }] }
}, 0, 800, { tv: 1.2 });

// Manual test — pick a job
addNode('Manual Test', 'n8n-nodes-base.manualTrigger', {}, 0, 1000, { tv: 1 });

addNode('Pick Job', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'j', name: 'job_name', type: 'string', value: 'daily_summary' }
    ] }, options: {}
}, 220, 1000, { tv: 3.4 });
connect('Manual Test', 'Pick Job');

// Job dispatcher for manual trigger
addNode('Dispatch Manual', 'n8n-nodes-base.switch', {
    rules: { values: [
        { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
          combinator: 'and', conditions: [{
              id: 'r1', operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.job_name }}', rightValue: 'daily_summary' }] },
          renameOutput: true, outputKey: 'daily_summary' },
        { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
          combinator: 'and', conditions: [{
              id: 'r2', operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.job_name }}', rightValue: 'weekly_summary' }] },
          renameOutput: true, outputKey: 'weekly_summary' },
        { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
          combinator: 'and', conditions: [{
              id: 'r3', operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.job_name }}', rightValue: 'recurring' }] },
          renameOutput: true, outputKey: 'recurring' },
        { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
          combinator: 'and', conditions: [{
              id: 'r4', operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.job_name }}', rightValue: 'cleanup' }] },
          renameOutput: true, outputKey: 'cleanup' },
        { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
          combinator: 'and', conditions: [{
              id: 'r5', operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.job_name }}', rightValue: 'budget_alerts' }] },
          renameOutput: true, outputKey: 'budget_alerts' }
    ] }, options: {}
}, 440, 1000, { tv: 3 });
connect('Pick Job', 'Dispatch Manual');

// =========================================================================
// 2. JOB START LOGGING (each job logs its run start to cron_runs)
// =========================================================================
const addStartLog = (jobName, x, y) => {
    const node = `Log Start: ${jobName}`;
    addNode(node, 'n8n-nodes-base.postgres', {
        operation: 'executeQuery',
        query: "SELECT log_cron_start($1::text, '{}'::jsonb) AS run_id;",
        options: { queryReplacement: `=${jobName}` }
    }, x, y, { tv: 2.5, creds: { postgres: PG }, cof: true, always: true });
    return node;
};

// =========================================================================
// 3. DAILY SUMMARY JOB
// =========================================================================
const dsLog = addStartLog('daily_summary', 660, 0);
connect('Cron Daily 22:00', dsLog);
connect('Dispatch Manual', dsLog, 0);

addNode('Daily Summary Query', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `SELECT u.id AS user_id, u.phone_number AS phone, u.name,
                   ds.total, ds.n, ds.top_category, ds.top_amount
            FROM users u
            CROSS JOIN LATERAL daily_summary(u.id) ds
            WHERE u.daily_summary_enabled = TRUE AND u.is_active = TRUE;`,
    options: {}
}, 880, 0, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(dsLog, 'Daily Summary Query');

addNode('Format Daily Summary', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all();
const out = [];
for (const it of items) {
  const j = it.json;
  const total = Number(j.total || 0);
  const n = Number(j.n || 0);
  const fmt = x => Number(x||0).toLocaleString('es-AR');
  let text;
  if (n === 0) {
    const opts = [
      '🧘 Hoy no anotaste gastos. Buen día para la billetera.',
      '🎉 Día sin gastos registrados. ¡Bien ahí!',
      '✨ Hoy no me llegó nada. Si te olvidaste algo, lo podés cargar ahora.'
    ];
    text = opts[Math.floor(Math.random()*opts.length)];
  } else {
    let body = \`📊 *Resumen de hoy*\\nGastaste $\${fmt(total)} en \${n} \${n===1?'movimiento':'movimientos'}\`;
    if (j.top_category) body += \`\\nMás fuerte: \${j.top_category} ($\${fmt(j.top_amount)})\`;
    text = body;
  }
  out.push({ json: {
    job_name: 'daily_summary',
    user_id: j.user_id, phone: j.phone,
    instance: '${INSTANCE}',
    remoteJid: j.phone + '@s.whatsapp.net',
    replyText: text
  }});
}
return out;`
}, 1100, 0);
connect('Daily Summary Query', 'Format Daily Summary');

// =========================================================================
// 4. WEEKLY SUMMARY JOB
// =========================================================================
const wsLog = addStartLog('weekly_summary', 660, 200);
connect('Cron Sunday 21:00', wsLog);
connect('Dispatch Manual', wsLog, 1);

addNode('Weekly Summary Query', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `WITH this_week AS (
  SELECT u.id AS user_id, u.phone_number, u.name,
         COALESCE(SUM(t.amount),0) AS this_total, COUNT(t.*) AS this_n
  FROM users u
  LEFT JOIN v_reportable_transactions t
    ON t.user_id = u.id AND t.type = 'expense'
   AND t.transaction_date >= DATE_TRUNC('week', CURRENT_DATE)
  WHERE u.weekly_summary_enabled = TRUE AND u.is_active = TRUE
  GROUP BY u.id, u.phone_number, u.name
),
last_week AS (
  SELECT u.id AS user_id, COALESCE(SUM(t.amount),0) AS last_total
  FROM users u
  LEFT JOIN v_reportable_transactions t
    ON t.user_id = u.id AND t.type = 'expense'
   AND t.transaction_date >= DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')
   AND t.transaction_date <  DATE_TRUNC('week', CURRENT_DATE)
  GROUP BY u.id
),
top_cat AS (
  SELECT DISTINCT ON (t.user_id) t.user_id, c.name AS category, SUM(t.amount) AS amt
  FROM v_reportable_transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  WHERE t.type = 'expense' AND t.transaction_date >= DATE_TRUNC('week', CURRENT_DATE)
  GROUP BY t.user_id, c.name
  ORDER BY t.user_id, amt DESC
)
SELECT tw.user_id, tw.phone_number AS phone, tw.name,
       tw.this_total, tw.this_n,
       lw.last_total, tc.category AS top_category, tc.amt AS top_amount
FROM this_week tw
LEFT JOIN last_week lw USING (user_id)
LEFT JOIN top_cat tc USING (user_id);`,
    options: {}
}, 880, 200, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(wsLog, 'Weekly Summary Query');

addNode('Format Weekly Summary', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all();
const out = [];
const fmt = n => Number(n||0).toLocaleString('es-AR');
for (const it of items) {
  const j = it.json;
  const t = Number(j.this_total||0), l = Number(j.last_total||0);
  let trend = '';
  if (l > 0) {
    const pct = Math.round(((t - l) / l) * 100);
    if (pct > 5) trend = \`\\n📈 \${pct}% más que la semana pasada ($\${fmt(l)})\`;
    else if (pct < -5) trend = \`\\n📉 \${Math.abs(pct)}% menos que la semana pasada ($\${fmt(l)})\`;
    else trend = '\\n📊 Similar a la semana pasada.';
  }
  let body;
  if (Number(j.this_n) === 0) {
    body = '🌿 *Resumen semanal*\\nEsta semana no registraste gastos.';
  } else {
    body = \`📅 *Resumen semanal*\\nGastaste $\${fmt(t)} en \${j.this_n} \${j.this_n==1?'movimiento':'movimientos'}\${trend}\`;
    if (j.top_category) body += \`\\nMás fuerte: \${j.top_category} ($\${fmt(j.top_amount)})\`;
  }
  out.push({ json: {
    job_name: 'weekly_summary',
    user_id: j.user_id, phone: j.phone,
    instance: '${INSTANCE}',
    remoteJid: j.phone + '@s.whatsapp.net',
    replyText: body
  }});
}
return out;`
}, 1100, 200);
connect('Weekly Summary Query', 'Format Weekly Summary');

// =========================================================================
// 5. RECURRING TRANSACTIONS JOB
// =========================================================================
const rcLog = addStartLog('recurring', 660, 400);
connect('Cron Daily 06:00', rcLog);
connect('Dispatch Manual', rcLog, 2);

addNode('Process Due Recurring', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM process_due_recurring();',
    options: {}
}, 880, 400, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(rcLog, 'Process Due Recurring');

addNode('Format Recurring', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all().filter(i => i.json.transaction_id);
const out = [];
const fmt = n => Number(n||0).toLocaleString('es-AR');
for (const it of items) {
  const j = it.json;
  out.push({ json: {
    job_name: 'recurring',
    user_id: j.user_id, phone: j.phone,
    instance: '${INSTANCE}',
    remoteJid: j.phone + '@s.whatsapp.net',
    replyText: \`🔁 Cargué tu gasto recurrente: $\${fmt(j.amount)} de \${j.category_name||'sin categoría'}\${j.description?' — '+j.description:''}\`
  }});
}
return out;`
}, 1100, 400);
connect('Process Due Recurring', 'Format Recurring');

// =========================================================================
// 6. CLEANUP JOB (no messages — just DB hygiene)
// =========================================================================
const clLog = addStartLog('cleanup', 660, 600);
connect('Cron Daily 03:00', clLog);
connect('Dispatch Manual', clLog, 3);

addNode('Cleanup Postgres', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `SELECT
        purge_old_chat_history(30) AS chats_purged,
        purge_expired_conv_states() AS states_purged,
        (SELECT COUNT(*)::INT FROM cron_runs WHERE started_at < NOW() - INTERVAL '90 days') AS old_cron_runs;`,
    options: {}
}, 880, 600, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(clLog, 'Cleanup Postgres');

addNode('Format Cleanup', 'n8n-nodes-base.code', {
    jsCode: `const r = $input.first()?.json || {};
const summary = {
  chats_purged: Number(r.chats_purged||0),
  states_purged: Number(r.states_purged||0),
  old_cron_runs: Number(r.old_cron_runs||0)
};
// No messages to send — return synthetic record so Log End has data
return [{ json: { job_name: 'cleanup', skip_send: true, summary }}];`
}, 1100, 600);
connect('Cleanup Postgres', 'Format Cleanup');

// =========================================================================
// 7. BUDGET ALERTS JOB
// =========================================================================
const baLog = addStartLog('budget_alerts', 660, 800);
connect('Cron Every 4h', baLog);
connect('Dispatch Manual', baLog, 4);

addNode('Pending Alerts Query', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM pending_budget_alerts();',
    options: {}
}, 880, 800, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(baLog, 'Pending Alerts Query');

addNode('Format Alerts', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all().filter(i => i.json.user_id);
const fmt = n => Number(n||0).toLocaleString('es-AR');
const out = [];
for (const it of items) {
  const j = it.json;
  const spent = Number(j.spent||0), amount = Number(j.amount||0);
  const pct = amount > 0 ? Math.round(spent / amount * 100) : 0;
  let body;
  if (j.level === 'over_budget') {
    body = \`⚠️ Te pasaste del presupuesto de *\${j.category_name}* (\${j.period}): $\${fmt(spent)} de $\${fmt(amount)} (\${pct}%).\`;
  } else {
    body = \`🟡 Vas por $\${fmt(spent)} en *\${j.category_name}* este \${j.period} (\${pct}% del presupuesto $\${fmt(amount)}).\`;
  }
  out.push({ json: {
    job_name: 'budget_alerts',
    user_id: j.user_id, phone: j.phone,
    instance: '${INSTANCE}',
    remoteJid: j.phone + '@s.whatsapp.net',
    replyText: body,
    // Carry budget metadata so we can mark it sent after delivery
    _budget_id: j.budget_id, _level: j.level
  }});
}
return out;`
}, 1100, 800);
connect('Pending Alerts Query', 'Format Alerts');

// =========================================================================
// 8. MERGE → SEND PIPELINE (common to all jobs except cleanup)
// =========================================================================
addNode('Merge Outputs', 'n8n-nodes-base.merge', {
    mode: 'append',
    options: {}
}, 1320, 200, { tv: 3 });
connect('Format Daily Summary', 'Merge Outputs', 0);
connect('Format Weekly Summary', 'Merge Outputs', 0);
connect('Format Recurring', 'Merge Outputs', 0);
connect('Format Alerts', 'Merge Outputs', 0);

// Filter out skip_send (cleanup) and empty
addNode('Filter Sendable', 'n8n-nodes-base.filter', {
    conditions: {
        options: { caseSensitive: true, typeValidation: 'loose', version: 1 },
        combinator: 'and',
        conditions: [
            { id: 'c1', operator: { type: 'boolean', operation: 'notTrue' },
              leftValue: '={{ Boolean($json.skip_send) }}', rightValue: false },
            { id: 'c2', operator: { type: 'string', operation: 'notEmpty' },
              leftValue: '={{ $json.replyText }}', rightValue: '' }
        ]
    },
    options: {}
}, 1540, 200, { tv: 2 });
connect('Merge Outputs', 'Filter Sendable');

// Loop: Split In Batches → Send → Wait 400ms → loop
addNode('Loop Batches', 'n8n-nodes-base.splitInBatches', {
    batchSize: 1, options: {}
}, 1760, 200, { tv: 3 });
connect('Filter Sendable', 'Loop Batches');

addNode('Send WhatsApp', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api',
    instanceName: '={{ $json.instance }}',
    remoteJid: '={{ $json.remoteJid || ($json.phone + "@s.whatsapp.net") }}',
    messageText: '={{ $json.replyText }}',
    options_message: {}
}, 1980, 200, { creds: { evolutionApi: EVO }, cof: true });
connect('Loop Batches', 'Send WhatsApp', 1);

addNode('Mark Sent (if budget)', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `SELECT CASE
        WHEN $1::text = 'budget_alerts' AND $2 IS NOT NULL AND $3 IS NOT NULL
        THEN (SELECT mark_budget_alert_sent($2::uuid, $3::uuid, $4::text))
        ELSE NULL END AS marked;`,
    options: {
        queryReplacement: "={{ $json.job_name }},={{ $json.user_id }},={{ $json._budget_id || '' }},={{ $json._level || '' }}"
    }
}, 2200, 200, { tv: 2.5, creds: { postgres: PG }, cof: true, always: true });
connect('Send WhatsApp', 'Mark Sent (if budget)');

addNode('Rate Limit Wait', 'n8n-nodes-base.wait', { amount: 400, unit: 'ms' },
    2420, 200, { tv: 1.1 });
connect('Mark Sent (if budget)', 'Rate Limit Wait');
connect('Rate Limit Wait', 'Loop Batches');

// =========================================================================
// 9. END LOG (after all batches done — done output of SplitInBatches)
// =========================================================================
addNode('Aggregate Stats', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all();
const stats = {};
for (const it of items) {
  const job = it.json.job_name || 'unknown';
  stats[job] = stats[job] || { processed: 0 };
  stats[job].processed += 1;
}
return Object.entries(stats).map(([job, s]) => ({ json: { job_name: job, items_processed: s.processed, items_sent: s.processed } }));`
}, 1980, 0);
connect('Loop Batches', 'Aggregate Stats', 0);

addNode('Log End', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `INSERT INTO cron_runs (job_name, finished_at, items_processed, items_sent, success)
            VALUES ($1::text, NOW(), $2::int, $3::int, TRUE);`,
    options: {
        queryReplacement: '={{ $json.job_name }},={{ $json.items_processed || 0 }},={{ $json.items_sent || 0 }}'
    }
}, 2200, 0, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Aggregate Stats', 'Log End');

// Cleanup-only path (no Send): log end too
addNode('Log End Cleanup', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `INSERT INTO cron_runs (job_name, finished_at, items_processed, success, metadata)
            VALUES ('cleanup', NOW(), 0, TRUE, $1::jsonb);`,
    options: { queryReplacement: '={{ JSON.stringify($json.summary || {}) }}' }
}, 1320, 600, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Format Cleanup', 'Log End Cleanup');

// =========================================================================
// EMIT JSON
// =========================================================================
const wf = {
    id: 'chefin_cron_v3',
    name: 'Chefin Cron v3 (consolidated)',
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: {
        executionOrder: 'v1',
        timezone: 'America/Argentina/Buenos_Aires'
    },
    meta: { templateCredsSetupCompleted: true },
    tags: []
};
process.stdout.write(JSON.stringify(wf, null, 2));
