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
//   - Memory snapshot (04:00 daily) — backup JSONL de memory_chunks por usuario
//   - Session summary (03:30 daily) — condensa los turnos del día y los persiste
//     como kind='session_summary' para recuperar contexto cuando salgan del window
//   - Memory stale review (Sunday 02:00) — marca facts viejos sin uso como '__stale__'
//   - Manual test trigger (run any job on demand)
//
// All paths converge into a single Send branch with rate-limiting wait, except
// los jobs de mantenimiento de memoria (snapshot/summary/stale) que no envían
// nada al usuario y terminan en Log End directo.

const PG = { id: 'f8CCpjEZRkcHEaJI', name: 'Postgres account' };
const EVO = { id: 'FgeqqvxAqTER4oeD', name: 'Evolution account' };
const OPENAI = { id: '0ErbOR5W4QIYaohV', name: 'OpenAI account' };
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

// Memory maintenance crons (separados de los user-facing — no mandan WhatsApp)
// Memory snapshot — 04:00 daily (después del cleanup 03:30)
addNode('Cron Daily 04:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 4 * * *' }] }
}, 0, 1200, { tv: 1.2 });

// Session summary — 23:30 daily (después del daily summary)
addNode('Cron Daily 23:30', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 30 23 * * *' }] }
}, 0, 1400, { tv: 1.2 });

// Stale memory review — Sunday 02:00 (semanal)
addNode('Cron Sunday 02:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 2 * * 0' }] }
}, 0, 1600, { tv: 1.2 });

// Embed transactions (auto-categorización backfill) — every 5 min, day-time only.
// Procesa pending_embedding_backlog en lotes de 50. No corre toda la noche
// porque a esa hora no hay nuevas transacciones.
addNode('Cron Every 5min', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 */5 7-23 * * *' }] }
}, 0, 2200, { tv: 1.2 });

// Anomaly alerts — daily 11:00. Detecta movimientos que se desvían >2.5x del
// baseline del usuario en últimos 60 días. claim_anomalies_for_cron ya hace
// dedup vía anomaly_alert_log y setea conv_state='awaiting_anomaly_confirm'
// para que el agente capte la respuesta del usuario.
addNode('Cron Daily 11:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 11 * * *' }] }
}, 0, 2400, { tv: 1.2 });

// Subscription notice — first day of month 10:00. Avisa al usuario que
// detectamos suscripciones nuevas (cargos recurrentes con merchant similar).
addNode('Cron Monthly 10:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 10 1 * *' }] }
}, 0, 2600, { tv: 1.2 });

// Auto-grupos — Sunday 18:00. Detecta palabras repetidas en descriptions de
// últimos 14d sin grupo asignado (probablemente viaje/evento) y propone armar
// el grupo. 30d de cooldown por keyword para no spammear.
addNode('Cron Sunday 18:00', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 0 18 * * 0' }] }
}, 0, 2800, { tv: 1.2 });

// Manual test — pick a job
addNode('Manual Test', 'n8n-nodes-base.manualTrigger', {}, 0, 1800, { tv: 1 });

addNode('Pick Job', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'j', name: 'job_name', type: 'string', value: 'daily_summary' }
    ] }, options: {}
}, 220, 1800, { tv: 3.4 });
connect('Manual Test', 'Pick Job');

// Job dispatcher for manual trigger
const dispatchRule = (id, key) => ({
    conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
      combinator: 'and', conditions: [{
          id, operator: { type: 'string', operation: 'equals' },
          leftValue: '={{ $json.job_name }}', rightValue: key }] },
    renameOutput: true, outputKey: key
});
addNode('Dispatch Manual', 'n8n-nodes-base.switch', {
    rules: { values: [
        dispatchRule('r1', 'daily_summary'),
        dispatchRule('r2', 'weekly_summary'),
        dispatchRule('r3', 'recurring'),
        dispatchRule('r4', 'cleanup'),
        dispatchRule('r5', 'budget_alerts'),
        dispatchRule('r6', 'memory_snapshot'),
        dispatchRule('r7', 'session_summary'),
        dispatchRule('r8', 'memory_stale_review'),
        dispatchRule('r9', 'watchdog'),
        dispatchRule('r10', 'embed_transactions'),
        dispatchRule('r11', 'anomaly_alerts'),
        dispatchRule('r12', 'subscription_notice'),
        dispatchRule('r13', 'group_candidates')
    ] }, options: {}
}, 440, 1800, { tv: 3 });
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
    jsCode: `const items = $input.all().filter(i => i.json.out_transaction_id);
const out = [];
const fmt = n => Number(n||0).toLocaleString('es-AR');
for (const it of items) {
  const j = it.json;
  out.push({ json: {
    job_name: 'recurring',
    user_id: j.out_user_id, phone: j.out_phone,
    instance: '${INSTANCE}',
    remoteJid: j.out_phone + '@s.whatsapp.net',
    replyText: \`🔁 Cargué tu gasto recurrente: $\${fmt(j.out_amount)} de \${j.out_category_name||'sin categoría'}\${j.out_description?' — '+j.out_description:''}\`
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
// 7b. MEMORY SNAPSHOT JOB — backup diario de memory_chunks por usuario
// =========================================================================
// Exporta a /data/logs/memory-snapshots/<YYYY-MM-DD>.jsonl (bind-mounted al host).
// 1 línea JSONL por usuario con todos sus facts vivos. Sirve como backup
// independiente del volumen de Postgres (defensa contra accidentes).
const msLog = addStartLog('memory_snapshot', 660, 1200);
connect('Cron Daily 04:00', msLog);
connect('Dispatch Manual', msLog, 5);

addNode('Export All Memory', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM export_all_memory();',
    options: {}
}, 880, 1200, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(msLog, 'Export All Memory');

addNode('Write Snapshot File', 'n8n-nodes-base.code', {
    jsCode: `const fs = require('fs');
const path = require('path');
const items = $input.all();

const SNAPSHOT_DIR = '/data/logs/memory-snapshots';
const day = new Date().toISOString().slice(0, 10);
const baseFile = path.join(SNAPSHOT_DIR, day + '.jsonl');

// Idempotencia: si el snapshot del día YA existe (re-run via Manual Test),
// rotamos el viejo a .bak antes de truncar. Antes sobreescribíamos sin más,
// perdiendo el snapshot original cuando alguien re-disparaba el cron a mano.
let file = baseFile;
let rotatedFrom = null;
try {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  if (fs.existsSync(baseFile) && fs.statSync(baseFile).size > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bak = path.join(SNAPSHOT_DIR, day + '.jsonl.bak-' + stamp);
    fs.renameSync(baseFile, bak);
    rotatedFrom = bak;
  }
} catch (e) {
  try { console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'warn', event: 'snapshot_rotate_failed',
    file: baseFile, error: String(e && e.message || e)
  })); } catch (_) {}
}

let written = 0, failed = 0;
try {
  for (const it of items) {
    const j = it.json || {};
    if (!j.user_id) continue;
    try {
      fs.appendFileSync(file, JSON.stringify({
        user_id: j.user_id,
        phone: j.phone,
        snapshot_at: j.snapshot_at,
        chunk_count: Number(j.chunk_count || 0),
        chunks: j.chunks || []
      }) + '\\n', 'utf8');
      written++;
    } catch (e) {
      try { console.error(JSON.stringify({
        ts: new Date().toISOString(), level: 'warn', event: 'snapshot_user_write_failed',
        user_id: j.user_id, error: String(e && e.message || e)
      })); } catch (_) {}
      failed++;
    }
  }
  // Retención de backups: borrar .bak-* con > 14 días
  try {
    const cutoff = Date.now() - (14 * 24 * 3600 * 1000);
    for (const f of fs.readdirSync(SNAPSHOT_DIR)) {
      if (!/\\.bak-/.test(f)) continue;
      const full = path.join(SNAPSHOT_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch (_) { /* best-effort */ }
} catch (e) {
  try { console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'critical', event: 'snapshot_write_failed',
    error: String(e && e.message || e)
  })); } catch (_) {}
}

// Telemetría estructurada del job — stderr independiente de cron_runs (DB).
try { console.error(JSON.stringify({
  ts: new Date().toISOString(), level: failed ? 'warn' : 'info',
  event: 'cron_job_finished', job: 'memory_snapshot',
  users_written: written, users_failed: failed,
  rotated_from: rotatedFrom, file
})); } catch (_) {}

return [{ json: {
  job_name: 'memory_snapshot',
  skip_send: true,
  summary: { users_written: written, users_failed: failed, file, rotated_from: rotatedFrom }
} }];`
}, 1100, 1200);
connect('Export All Memory', 'Write Snapshot File');

addNode('Log End Snapshot', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `INSERT INTO cron_runs (job_name, finished_at, items_processed, success, metadata)
            VALUES ('memory_snapshot', NOW(), $1::int, TRUE, $2::jsonb);`,
    options: {
        queryReplacement: '={{ $json.summary.users_written || 0 }},={{ JSON.stringify($json.summary || {}) }}'
    }
}, 1320, 1200, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Write Snapshot File', 'Log End Snapshot');

// =========================================================================
// 7c. SESSION SUMMARY JOB — condensa el chat history del día en un fact
// =========================================================================
// Para cada user con >=10 turnos hoy, generamos UN párrafo de resumen y lo
// guardamos como memory_chunk con kind='session_summary'. Esto preserva
// contexto de turnos que van a salir del window de 20 mensajes.
//
// Pipeline: query → para cada user → fetch últimos 50 turnos → OpenAI summarize
// → OpenAI embed → add_memory_chunk(kind='session_summary'). Si falla cualquiera
// de los pasos para un user, seguimos con los demás (cof:true en cada uno).
const ssLog = addStartLog('session_summary', 660, 1400);
connect('Cron Daily 23:30', ssLog);
connect('Dispatch Manual', ssLog, 6);

addNode('Find Active Users', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    // Solo users con actividad real hoy (>= 10 turnos en ventana 24h).
    // Si el user mandó 5 mensajes, no vale la pena resumirlo — el window
    // de 20 ya lo cubre sobrado.
    query: `SELECT u.id AS user_id, u.id::text AS session_id,
                   COUNT(ch.*) AS turn_count
            FROM users u
            JOIN n8n_chat_histories ch ON ch.session_id = u.id::text
                AND ch.created_at >= NOW() - INTERVAL '24 hours'
            WHERE u.is_active = TRUE
            GROUP BY u.id
            HAVING COUNT(ch.*) >= 10;`,
    options: {}
}, 880, 1400, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(ssLog, 'Find Active Users');

addNode('Fetch Recent Turns', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    // Trae los últimos 50 turnos del user, en orden cronológico.
    query: `SELECT message->'data'->>'content' AS text,
                   message->>'type' AS role,
                   created_at
            FROM n8n_chat_histories
            WHERE session_id = $1::text
              AND created_at >= NOW() - INTERVAL '24 hours'
            ORDER BY id DESC LIMIT 50;`,
    options: { queryReplacement: '={{ $json.session_id }}' }
}, 1100, 1400, { tv: 2.5, creds: { postgres: PG }, cof: true, always: true });
connect('Find Active Users', 'Fetch Recent Turns');

addNode('Build Summary Prompt', 'n8n-nodes-base.code', {
    jsCode: `const turns = $input.all();
// Reconstruimos en orden cronológico (la query trae DESC)
const ordered = turns.slice().reverse();
const transcript = ordered.map(t => {
  const role = (t.json.role === 'human') ? 'Usuario' : 'Asistente';
  return role + ': ' + (t.json.text || '').slice(0, 400);
}).join('\\n');

// Si el transcript es muy corto (saludos sueltos), bypass — no vale la pena.
if (transcript.length < 200) {
  return [{ json: { skip: true, reason: 'transcript_too_short' } }];
}

return [{ json: {
  user_id: $('Find Active Users').first().json.user_id,
  prompt_text: transcript,
  skip: false
} }];`
}, 1320, 1400);
connect('Fetch Recent Turns', 'Build Summary Prompt');

addNode('Summarize with LLM', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: '={\n  "model": "gpt-4o-mini",\n  "temperature": 0.2, "max_tokens": 220,\n  "messages": [\n    {"role":"system","content":"Sos un condensador de conversaciones. Tu output es UN PÁRRAFO en español rioplatense (máximo 60 palabras) que captura SOLO contexto persistente y útil del día — NO datos numéricos, NO transacciones específicas, NO saldos, NO categorías mencionadas en pasada. Capturá: temas recurrentes, decisiones, preferencias nuevas, planes mencionados, estados emocionales si afectan la conversación. Empezá directo, sin \'Hoy el usuario...\' Si no hay nada digno de recordar, devolvé exactamente la string SKIP."},\n    {"role":"user","content":"Transcripción:\\n{{ ($json.prompt_text || \'\').replace(/[\\\\\\"]/g, \' \') }}"}\n  ]\n}',
    options: {}
}, 1540, 1400, { tv: 4.2, creds: { openAiApi: OPENAI }, cof: true });
connect('Build Summary Prompt', 'Summarize with LLM');

addNode('Extract Summary Text', 'n8n-nodes-base.code', {
    jsCode: `const ctx = $('Build Summary Prompt').first().json;
if (ctx.skip) {
  return [{ json: { skip: true, reason: ctx.reason } }];
}
const resp = $input.first().json || {};
const text = (resp.choices?.[0]?.message?.content || '').trim();
if (!text || text.toUpperCase() === 'SKIP' || text.length < 20) {
  return [{ json: { skip: true, reason: 'llm_returned_skip' } }];
}
return [{ json: { user_id: ctx.user_id, summary_text: text, skip: false } }];`
}, 1760, 1400);
connect('Summarize with LLM', 'Extract Summary Text');

addNode('Embed Summary', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: 'https://api.openai.com/v1/embeddings',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: `={\n  "model": "text-embedding-3-small",\n  "input": {{ JSON.stringify($json.summary_text || "") }}\n}`,
    options: {}
}, 1980, 1400, { tv: 4.2, creds: { openAiApi: OPENAI }, cof: true });
connect('Extract Summary Text', 'Embed Summary');

addNode('Save Session Summary', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    // Convertimos el array de embedding a vector usando ARRAY[]::vector(1536)
    query: `SELECT * FROM add_memory_chunk(
        $1::uuid,
        'session_summary',
        $2::text,
        $3::vector(1536),
        '{}'::jsonb,
        'cron:session_summary',
        'text-embedding-3-small'
    );`,
    options: {
        queryReplacement: "={{ $('Extract Summary Text').first().json.user_id }},={{ $('Extract Summary Text').first().json.summary_text }},={{ '[' + $json.data[0].embedding.join(',') + ']' }}"
    }
}, 2200, 1400, { tv: 2.5, creds: { postgres: PG }, cof: true, always: true });
connect('Embed Summary', 'Save Session Summary');

addNode('Aggregate Summary Stats', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all();
const written = items.filter(i => i.json && i.json.id).length;
return [{ json: {
  job_name: 'session_summary',
  skip_send: true,
  summary: { summaries_written: written, users_processed: items.length }
} }];`
}, 2420, 1400);
connect('Save Session Summary', 'Aggregate Summary Stats');

addNode('Log End Summary', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `INSERT INTO cron_runs (job_name, finished_at, items_processed, success, metadata)
            VALUES ('session_summary', NOW(), $1::int, TRUE, $2::jsonb);`,
    options: {
        queryReplacement: '={{ $json.summary.summaries_written || 0 }},={{ JSON.stringify($json.summary || {}) }}'
    }
}, 2640, 1400, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Aggregate Summary Stats', 'Log End Summary');

// =========================================================================
// 7d. STALE MEMORY REVIEW JOB — marca facts viejos sin uso como '__stale__'
// =========================================================================
const stLog = addStartLog('memory_stale_review', 660, 1600);
connect('Cron Sunday 02:00', stLog);
connect('Dispatch Manual', stLog, 7);

addNode('Mark Stale', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    // NULL p_user_id → todos los users.
    // 45d sin recall, 60d de antigüedad mínima — facts recientes nunca se marcan.
    query: 'SELECT COUNT(*)::INT AS marked FROM mark_stale_memories(NULL, 45, 60);',
    options: {}
}, 880, 1600, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(stLog, 'Mark Stale');

addNode('Format Stale Result', 'n8n-nodes-base.code', {
    jsCode: `const r = $input.first()?.json || {};
const marked = Number(r.marked || 0);
return [{ json: {
  job_name: 'memory_stale_review',
  skip_send: true,
  summary: { facts_marked_stale: marked }
} }];`
}, 1100, 1600);
connect('Mark Stale', 'Format Stale Result');

// Después del stale review de memory_chunks, marcamos también las lecciones
// muertas (agent_instructions). Mismo cron Sunday 02:00 (no agrega trigger).
// thresholds: never-applied + 30d, o idle 60d.
addNode('Flag Dead Lessons', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM flag_dead_lessons(30, 60);',
    options: {}
}, 1320, 1600, { tv: 2.5, creds: { postgres: PG }, cof: true, always: true });
connect('Format Stale Result', 'Flag Dead Lessons');

addNode('Format Dead Lessons', 'n8n-nodes-base.code', {
    jsCode: `const r = $input.first()?.json || {};
const flaggedCount = Number(r.flagged_count || 0);
const ids = Array.isArray(r.sample_ids) ? r.sample_ids : [];
const samples = Array.isArray(r.sample_instructions) ? r.sample_instructions : [];

// Telemetría — el operador puede grepear stderr para ver qué lecciones
// están muertas y considerar borrarlas. No las desactivamos automáticamente.
try { console.error(JSON.stringify({
  ts: new Date().toISOString(), level: flaggedCount ? 'info' : 'info',
  event: 'dead_lessons_flagged',
  count: flaggedCount,
  sample_ids: ids.slice(0, 10),
  sample_instructions: samples.slice(0, 10)
})); } catch (_) {}

const prev = $('Format Stale Result').first().json.summary || {};
return [{ json: {
  job_name: 'memory_stale_review',
  skip_send: true,
  summary: {
    ...prev,
    lessons_flagged_dead: flaggedCount,
    lessons_flagged_ids: ids
  }
} }];`
}, 1540, 1600);
connect('Flag Dead Lessons', 'Format Dead Lessons');

addNode('Log End Stale', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `INSERT INTO cron_runs (job_name, finished_at, items_processed, success, metadata)
            VALUES ('memory_stale_review', NOW(),
                    COALESCE(($1::jsonb->>'facts_marked_stale')::int, 0)
                    + COALESCE(($1::jsonb->>'lessons_flagged_dead')::int, 0),
                    TRUE, $1::jsonb);`,
    options: {
        queryReplacement: '={{ JSON.stringify($json.summary || {}) }}'
    }
}, 1760, 1600, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Format Dead Lessons', 'Log End Stale');

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
}, 1980, 200, { tv: 1, creds: { evolutionApi: EVO }, cof: true });
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
const out = Object.entries(stats).map(([job, s]) => ({ json: { job_name: job, items_processed: s.processed, items_sent: s.processed } }));

// Telemetría estructurada — uno por job. Stderr es siempre confiable; cron_runs
// va abajo por DB y puede fallar si Postgres está raro.
try {
  for (const r of out) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'info', event: 'cron_job_finished',
      job: r.json.job_name,
      items_processed: r.json.items_processed,
      items_sent: r.json.items_sent
    }));
  }
} catch (_) {}

return out;`
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
// 10. WATCHDOG — corre 08:30 (después de todos los jobs nocturnos) y avisa
// si algún cron de las últimas 24h falló o quedó colgado.
// =========================================================================
// Detecta dos tipos de problema:
//   • success = FALSE  → el job falló y log_cron_end lo registró
//   • finished_at IS NULL Y started_at < NOW()-1h → el job ARRANCÓ pero NUNCA
//     terminó (crash, timeout, container restart). Sin esto, un job zombie
//     se ve como "no hubo run" y nadie se entera.
// Si hay problemas, manda WhatsApp al primer phone admin (hardcoded).
// Siempre emite stderr structured.
const ADMIN_PHONE = '5493794619729'; // Mismo que ALLOWED_PHONES[0] en build-agent-workflow.js

addNode('Cron Daily 08:30', 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [{ field: 'cronExpression', expression: '0 30 8 * * *' }] }
}, 0, 2000, { tv: 1.2 });

addNode('Watchdog Query', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `SELECT
        job_name,
        started_at,
        finished_at,
        success,
        LEFT(COALESCE(error_msg, ''), 240) AS error_msg,
        items_processed,
        CASE
            WHEN success = FALSE THEN 'failed'
            WHEN finished_at IS NULL AND started_at < NOW() - INTERVAL '1 hour' THEN 'zombie'
            ELSE 'ok'
        END AS status
      FROM cron_runs
      WHERE started_at > NOW() - INTERVAL '24 hours'
        AND (success IS FALSE
             OR (finished_at IS NULL AND started_at < NOW() - INTERVAL '1 hour'))
      ORDER BY started_at DESC
      LIMIT 20;`,
    options: {}
}, 220, 2000, { tv: 2.5, creds: { postgres: PG }, cof: true, always: true });
connect('Cron Daily 08:30', 'Watchdog Query');
connect('Dispatch Manual', 'Watchdog Query', 8); // expose via Manual Test too — see Dispatch Manual switch

addNode('Format Watchdog', 'n8n-nodes-base.code', {
    jsCode: `const rows = $input.all().map(i => i.json).filter(r => r && r.job_name);
const ts = new Date().toISOString();

// Sin fallas: log info y skip send.
if (!rows.length) {
  try { console.error(JSON.stringify({
    ts, level: 'info', event: 'watchdog_clean', failed_count: 0
  })); } catch (_) {}
  return [{ json: {
    job_name: 'watchdog', skip_send: true,
    summary: { failed_count: 0 }
  } }];
}

// Hay fallas — log critical y prepará mensaje.
try { console.error(JSON.stringify({
  ts, level: 'critical', event: 'watchdog_failures',
  failed_count: rows.length,
  jobs: rows.map(r => ({
    job: r.job_name, status: r.status,
    started: r.started_at, error: r.error_msg
  }))
})); } catch (_) {}

const lines = rows.slice(0, 10).map(r => {
  const status = r.status === 'zombie' ? '🧟 (sin terminar)' : '❌';
  const err = r.error_msg ? ' — ' + String(r.error_msg).slice(0, 80) : '';
  return status + ' ' + r.job_name + err;
});
const body = '⚠️ *Watchdog cron* (últimas 24h)\\n' +
             rows.length + ' job(s) con problemas:\\n' +
             lines.join('\\n');

return [{ json: {
  job_name: 'watchdog',
  user_id: null,
  phone: '${ADMIN_PHONE}',
  instance: '${INSTANCE}',
  remoteJid: '${ADMIN_PHONE}@s.whatsapp.net',
  replyText: body,
  summary: { failed_count: rows.length, jobs: rows.map(r => r.job_name) }
} }];`
}, 440, 2000);
connect('Watchdog Query', 'Format Watchdog');

// Lo unimos al merge para que use el mismo pipeline de Send WhatsApp + Rate Limit
connect('Format Watchdog', 'Merge Outputs', 0);

addNode('Log End Watchdog', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `INSERT INTO cron_runs (job_name, finished_at, items_processed, success, metadata)
            VALUES ('watchdog', NOW(), $1::int, TRUE, $2::jsonb);`,
    options: {
        queryReplacement: '={{ $json.summary.failed_count || 0 }},={{ JSON.stringify($json.summary || {}) }}'
    }
}, 660, 2000, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Format Watchdog', 'Log End Watchdog');

// =========================================================================
// 11. EMBED TRANSACTIONS — backfill async para auto-categorización
// =========================================================================
// Cada 5 min en horas activas, agarramos hasta 50 txs sin embedding y las
// embedeamos. El embedding queda en transaction_embeddings y se usa después
// vía suggest_category_by_similarity cuando el usuario loguea algo nuevo.
//
// Por qué async (no inline en log_transaction):
//   • Embedding es 60-150ms extra por log → afecta sensación de "rápido".
//   • Cron paraleliza 50 a la vez sin impacto al usuario.
//   • Si OpenAI falla, el log NO se rompe; solo queda sin embedding hasta
//     el próximo run del cron.
//
// Patrón: Pending Backlog Query → (n8n itera sobre items) Embed HTTP → Save
// → Aggregate → Log End. cof:true en HTTP/Save para que un fallo en una tx
// no rompa el batch entero.
const etLog = addStartLog('embed_transactions', 660, 2200);
connect('Cron Every 5min', etLog);
connect('Dispatch Manual', etLog, 9);

addNode('Pending Embedding Backlog', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM pending_embedding_backlog(50);',
    options: {}
}, 880, 2200, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(etLog, 'Pending Embedding Backlog');

addNode('Embed Transaction', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: 'https://api.openai.com/v1/embeddings',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: `={\n  "model": "text-embedding-3-small",\n  "input": {{ JSON.stringify($json.description || "") }},\n  "encoding_format": "float"\n}`,
    options: {}
}, 1100, 2200, { tv: 4.2, creds: { openAiApi: OPENAI }, cof: true, always: true });
connect('Pending Embedding Backlog', 'Embed Transaction');

addNode('Save Tx Embedding', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    // user_id, description y transaction_id vienen del nodo anterior (Pending);
    // n8n los retiene en el item original. El embedding viene en $json.data[0].
    query: `SELECT save_transaction_embedding(
        $1::uuid,
        $2::uuid,
        $3::vector(1536),
        $4::text,
        'text-embedding-3-small'
    ) AS saved;`,
    options: {
        queryReplacement: "={{ $('Pending Embedding Backlog').item.json.transaction_id }},={{ $('Pending Embedding Backlog').item.json.user_id }},={{ '[' + ($json.data?.[0]?.embedding || []).join(',') + ']' }},={{ $('Pending Embedding Backlog').item.json.description || '' }}"
    }
}, 1320, 2200, { tv: 2.5, creds: { postgres: PG }, cof: true, always: true });
connect('Embed Transaction', 'Save Tx Embedding');

addNode('Aggregate Embed Stats', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all();
const saved = items.filter(i => i.json && i.json.saved === true).length;
const failed = items.length - saved;
try { console.error(JSON.stringify({
  ts: new Date().toISOString(), level: failed ? 'warn' : 'info',
  event: 'cron_job_finished', job: 'embed_transactions',
  saved, failed, total: items.length
})); } catch (_) {}
return [{ json: {
  job_name: 'embed_transactions',
  skip_send: true,
  summary: { saved, failed, total: items.length }
} }];`
}, 1540, 2200);
connect('Save Tx Embedding', 'Aggregate Embed Stats');

addNode('Log End Embed', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: `INSERT INTO cron_runs (job_name, finished_at, items_processed, success, metadata)
            VALUES ('embed_transactions', NOW(), $1::int,
                    CASE WHEN ($2::jsonb->>'failed')::int = 0 THEN TRUE ELSE FALSE END,
                    $2::jsonb);`,
    options: {
        queryReplacement: '={{ $json.summary.saved || 0 }},={{ JSON.stringify($json.summary || {}) }}'
    }
}, 1760, 2200, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Aggregate Embed Stats', 'Log End Embed');

// =========================================================================
// 12. ANOMALY ALERTS — daily 11:00
// =========================================================================
// claim_anomalies_for_cron hace todo el trabajo crítico (dedup + conv_state).
// Acá solo formateamos el mensaje y lo pasamos al pipeline de send.
const aaLog = addStartLog('anomaly_alerts', 660, 2400);
connect('Cron Daily 11:00', aaLog);
connect('Dispatch Manual', aaLog, 10);

addNode('Claim Anomalies', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM claim_anomalies_for_cron();',
    options: {}
}, 880, 2400, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(aaLog, 'Claim Anomalies');

addNode('Format Anomalies', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all().filter(i => i.json && i.json.user_id);
const fmt = n => Number(n||0).toLocaleString('es-AR');
const out = [];
for (const it of items) {
  const j = it.json;
  const amt = Number(j.amount || 0);
  const baseline = Number(j.baseline || 0);
  const mult = Number(j.multiplier || 0);
  const desc = String(j.description || '').slice(0, 60);
  const date = j.transaction_date ? String(j.transaction_date).slice(0, 10) : '';
  const cat = j.category_name || 'sin categoría';

  // Mensaje natural — el agente captará la respuesta vía conv_state
  // 'awaiting_anomaly_confirm' (set por la SQL function).
  let body = '🚨 *Movimiento inusual detectado*\\n';
  body += '$' + fmt(amt) + ' en *' + cat + '*';
  if (desc) body += ' — ' + desc;
  if (date) body += ' (' + date + ')';
  if (baseline > 0 && mult > 1.5) {
    body += '\\n📊 Es ' + mult.toFixed(1) + 'x tu promedio en ' + cat + ' ($' + fmt(baseline) + ').';
  }
  body += '\\n¿Es correcto o lo cargaste mal?';

  out.push({ json: {
    job_name: 'anomaly_alerts',
    user_id: j.user_id,
    phone: j.phone,
    instance: '${INSTANCE}',
    remoteJid: j.phone + '@s.whatsapp.net',
    replyText: body
  } });
}
return out;`
}, 1100, 2400);
connect('Claim Anomalies', 'Format Anomalies');
// Conectar al pipeline de send (mismo que daily_summary etc.)
connect('Format Anomalies', 'Merge Outputs', 0);

// =========================================================================
// 13. SUBSCRIPTION NOTICE — monthly (1st @ 10:00)
// =========================================================================
// claim_new_subscriptions_for_cron detecta cargos recurrentes nuevos por
// merchant similarity y los marca como notificados.
const snLog = addStartLog('subscription_notice', 660, 2600);
connect('Cron Monthly 10:00', snLog);
connect('Dispatch Manual', snLog, 11);

addNode('Claim Subscriptions', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM claim_new_subscriptions_for_cron();',
    options: {}
}, 880, 2600, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(snLog, 'Claim Subscriptions');

addNode('Format Subscriptions', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all().filter(i => i.json && i.json.user_id);
const fmt = n => Number(n||0).toLocaleString('es-AR');
const out = [];
for (const it of items) {
  const j = it.json;
  const arr = Array.isArray(j.items) ? j.items : (typeof j.items === 'string' ? JSON.parse(j.items || '[]') : []);
  const newCount = Number(j.new_count || 0);
  const monthlyTotal = Number(j.monthly_total || 0);
  if (newCount === 0 || arr.length === 0) continue;

  let body = '🔔 *Detecté ' + newCount + ' suscripción' + (newCount > 1 ? 'es' : '') + ' nueva' + (newCount > 1 ? 's' : '') + '*\\n';
  for (const sub of arr.slice(0, 5)) {
    const merchant = sub.merchant_key || sub.sample_description || 'desconocido';
    const amt = Number(sub.estimated_monthly_amount || sub.amount || 0);
    body += '• ' + merchant + ' · $' + fmt(amt) + '/mes\\n';
  }
  if (monthlyTotal > 0) {
    body += '\\nTotal mensual estimado: *$' + fmt(monthlyTotal) + '*';
  }
  body += '\\n\\n¿Querés que las dé de alta como recurrentes? Podés decirme cuál sí y cuál no.';

  out.push({ json: {
    job_name: 'subscription_notice',
    user_id: j.user_id,
    phone: j.phone,
    instance: '${INSTANCE}',
    remoteJid: j.phone + '@s.whatsapp.net',
    replyText: body
  } });
}
return out;`
}, 1100, 2600);
connect('Claim Subscriptions', 'Format Subscriptions');
connect('Format Subscriptions', 'Merge Outputs', 0);

// =========================================================================
// 14. GROUP CANDIDATES — Sunday 18:00
// =========================================================================
const gcLog = addStartLog('group_candidates', 660, 2800);
connect('Cron Sunday 18:00', gcLog);
connect('Dispatch Manual', gcLog, 12);

addNode('Claim Group Candidates', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM claim_group_candidates_for_cron();',
    options: {}
}, 880, 2800, { tv: 2.5, creds: { postgres: PG }, always: true });
connect(gcLog, 'Claim Group Candidates');

addNode('Format Group Candidates', 'n8n-nodes-base.code', {
    jsCode: `const items = $input.all().filter(i => i.json && i.json.user_id && i.json.keyword);
const fmt = n => Number(n||0).toLocaleString('es-AR');
const out = [];
for (const it of items) {
  const j = it.json;
  // Capitalizar primera letra para verse natural
  const keyword = String(j.keyword || '').replace(/^./, c => c.toUpperCase());
  const txCount = Number(j.tx_count || 0);
  const total = Number(j.total_amount || 0);
  const earliest = j.earliest_date ? String(j.earliest_date).slice(0, 10) : '';
  const latest = j.latest_date ? String(j.latest_date).slice(0, 10) : '';
  const samples = Array.isArray(j.sample_descriptions) ? j.sample_descriptions : [];

  let body = '🗺️ *Detecté un patrón en tus gastos*\\n';
  body += 'Veo ' + txCount + ' movimientos relacionados con *' + keyword + '*';
  if (earliest && latest && earliest !== latest) {
    body += ' entre ' + earliest + ' y ' + latest;
  }
  body += ' por *$' + fmt(total) + '*.\\n';
  if (samples.length) {
    body += '\\nEj: ' + samples.slice(0, 3).map(s => '"' + String(s).slice(0, 50) + '"').join(', ') + '\\n';
  }
  body += '\\n¿Querés que arme el grupo "' + keyword + '" y mueva esos movimientos ahí?';

  out.push({ json: {
    job_name: 'group_candidates',
    user_id: j.user_id,
    phone: j.phone,
    instance: '${INSTANCE}',
    remoteJid: j.phone + '@s.whatsapp.net',
    replyText: body
  } });
}
return out;`
}, 1100, 2800);
connect('Claim Group Candidates', 'Format Group Candidates');
connect('Format Group Candidates', 'Merge Outputs', 0);

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
        timezone: 'America/Argentina/Buenos_Aires',
        // Mismo error handler que el agente principal — un cron que falla
        // (p. ej. resúmenes diarios) queda logeado pero no podemos avisarle al
        // usuario porque no hay payload de webhook (canReply=false). Igual
        // queremos el log persistido.
        errorWorkflow: '__ERROR_WF_ID__'
    },
    meta: { templateCredsSetupCompleted: true },
    tags: []
};
process.stdout.write(JSON.stringify(wf, null, 2));
