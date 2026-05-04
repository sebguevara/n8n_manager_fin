// Builds the Chefin Error Handler workflow.
// Run with: node build-error-workflow.js > workflows/chefin-error-v3.json
//
// Se dispara automáticamente cuando CUALQUIER nodo del workflow principal
// (Chefin Agent v3) o del cron (Chefin Cron v3) revienta. Cumple dos funciones:
//
//   1) Le manda al usuario un mensaje amable por WhatsApp diciendo que en este
//      momento no pudimos atender su pedido, así no se queda en silencio. Si no
//      pudimos extraer el teléfono del payload original (porque el error fue
//      antes de tener `remoteJid`), se omite el envío.
//
//   2) Escribe la entrada de log a `/data/logs/errors-YYYY-MM-DD.jsonl` (un
//      archivo por día). El path está bind-mounted al host en `./logs/` así
//      podemos leer/rotar los logs sin entrar al contenedor.
//
// El workflow se enlaza al agente vía `settings.errorWorkflow = "<id>"`. El
// deploy.sh importa este JSON primero, busca su id en n8n_postgres y lo
// inyecta antes de importar el agente.

const EVO = { id: 'FgeqqvxAqTER4oeD', name: 'Evolution account' };

let idCounter = 1;
const newId = () => `e${(idCounter++).toString().padStart(3, '0')}`;
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
const connect = (from, to, fromIdx = 0, toIdx = 0) => {
    if (!connections[from]) connections[from] = { main: [] };
    while (connections[from].main.length <= fromIdx) connections[from].main.push([]);
    connections[from].main[fromIdx].push({ node: to, type: 'main', index: toIdx });
};

// =========================================================================
// 1. ERROR TRIGGER — entrada del workflow
// =========================================================================
addNode('Error Trigger', 'n8n-nodes-base.errorTrigger', {}, 0, 0, { tv: 1 });

// =========================================================================
// 2. EXTRACT ERROR CONTEXT — saca teléfono/instancia + arma payload de log
// =========================================================================
// El errorTrigger nos pasa un objeto con esta forma:
//   {
//     execution: {
//       id, url, retryOf, error: { message, stack, name, ... },
//       lastNodeExecuted, mode
//     },
//     workflow: { id, name },
//     // (en algunos contextos también: executionData con runData crudo)
//   }
//
// Para reconstruir el destinatario buscamos el body del Webhook original.
// n8n no siempre incluye `runData` en el payload del Error Trigger (depende
// de la versión). Por eso intentamos varias rutas y, si no encontramos
// teléfono, marcamos `canReply=false` y dejamos que el flujo solo logee.
addNode('Extract Error Context', 'n8n-nodes-base.code', {
    jsCode: `const item = $input.first().json || {};
const exec = item.execution || {};
const wf = item.workflow || {};
const errObj = exec.error || {};

// Intentamos sacar el body original del webhook desde varias rutas posibles.
// Distintas versiones de n8n exponen runData de forma distinta en el error
// trigger. Si ninguna funciona, fallback a vacío y no respondemos.
//
// Nota: NO usamos optional-chaining (?.) acá. El Node viejo del VPS no lo
// parsea (ni la forma simple ?. ni la computada ?.[]) y el test corre este
// código vía new Function() en el host, así que necesita ser compatible.
function getPath(obj, keys) {
  let cur = obj;
  for (let i = 0; i < keys.length; i++) {
    if (cur == null) return undefined;
    cur = cur[keys[i]];
  }
  return cur;
}
function findWebhookBody(root) {
  const candidates = [
    getPath(root, ['executionData', 'resultData', 'runData']),
    getPath(root, ['execution', 'executionData', 'resultData', 'runData']),
    getPath(root, ['runData']),
  ];
  for (const rd of candidates) {
    if (!rd) continue;
    const webhookKey = Object.keys(rd).find(k => /webhook/i.test(k));
    if (!webhookKey) continue;
    const body = getPath(rd, [webhookKey, 0, 'data', 'main', 0, 0, 'json', 'body']);
    if (body) return body;
  }
  return null;
}

const body = findWebhookBody(item);
const remoteJid = (body && getPath(body, ['data', 'key', 'remoteJid'])) || '';
const phone = remoteJid ? remoteJid.split('@')[0] : '';
const instance = (body && body.instance) || '';
const messageId = (body && getPath(body, ['data', 'key', 'id'])) || '';
const userText =
  (body && getPath(body, ['data', 'message', 'conversation'])) ||
  (body && getPath(body, ['data', 'message', 'extendedTextMessage', 'text'])) ||
  (body && getPath(body, ['data', 'message', 'imageMessage', 'caption'])) ||
  '';

const canReply = Boolean(phone && instance);

// Mensaje amable (rioplatense) — no exponemos detalle técnico al usuario.
// Variamos un poco según el tipo de error: timeout/red vs. cualquier otra cosa.
const errMsg = String(errObj.message || '');
let userReply = '😅 Uh, en este momento no pude resolver tu pedido. Estoy mirando qué pasó. Probá de nuevo en un ratito y, si sigue, escribime de otra forma.';

// Severidad — la usa el operador (logs / alertas) y nos sirve para futuro
// alerting condicional. Default: error. Se baja a 'warn' para casos transient
// (timeouts, rate limits) y se sube a 'critical' para fallas que indican
// degradación de un dependency completo (postgres, redis, openai 5xx).
let severity = 'error';
let errorClass = 'unknown';

if (/timeout|ETIMEDOUT|ECONN|fetch failed|network|socket hang up/i.test(errMsg)) {
  userReply = '😅 Tuve un problema de conexión y no pude completar lo que pediste. Probá de nuevo en un minuto.';
  severity = 'warn';
  errorClass = 'transient_network';
} else if (/postgres|database|relation|column|connection terminated|too many clients/i.test(errMsg)) {
  userReply = '😅 No pude guardar/leer tu info en este momento. Estoy revisando. Probá de nuevo enseguida.';
  severity = 'critical';
  errorClass = 'database';
} else if (/rate.?limit|429|quota|insufficient_quota/i.test(errMsg)) {
  userReply = '😅 Estoy un poco saturado. Dame 30 segundos y mandalo de nuevo.';
  severity = 'warn';
  errorClass = 'rate_limit';
} else if (/openai|model_not_found|invalid_api_key|context_length/i.test(errMsg)) {
  userReply = '😅 Algo se trabó del lado del modelo. Probá reformular más corto.';
  severity = 'critical';
  errorClass = 'llm';
} else if (/Agent stopped due to iteration limit|max iterations/i.test(errMsg)) {
  userReply = '😅 Se me hizo enredo lo que pediste. Probá decírmelo de otra forma o más cortito.';
  severity = 'warn';
  errorClass = 'agent_iter_limit';
} else if (/json|unexpected token|parse/i.test(errMsg)) {
  severity = 'warn';
  errorClass = 'parse';
}

// Payload del log — JSON Line, una entrada por error. Mantenemos el stack
// completo para poder debuggear; el resto va resumido.
const logEntry = {
  timestamp: new Date().toISOString(),
  level: severity,                    // structured logging field
  event: 'workflow_error',
  errorClass,
  workflow: { id: wf.id || '', name: wf.name || '' },
  execution: {
    id: exec.id || '',
    url: exec.url || '',
    mode: exec.mode || '',
    lastNodeExecuted: exec.lastNodeExecuted || ''
  },
  error: {
    name: errObj.name || '',
    message: errMsg,
    description: errObj.description || '',
    stack: String(errObj.stack || '').split('\\n').slice(0, 30).join('\\n')
  },
  user: { phone, instance, messageId, remoteJid, userText: userText.slice(0, 300) },
  replied: canReply
};

// Emitimos SIEMPRE a stderr en JSON one-line — Docker lo captura, y un grep
// de los logs nos da todos los errores aunque la escritura del archivo falle.
// Esto NO depende del Write Error Log node — es la red de seguridad por debajo.
try { console.error(JSON.stringify(logEntry)); } catch (_) { /* stderr no-op */ }

return [{ json: { canReply, phone, instance, messageId, remoteJid, userReply, logEntry, severity, errorClass } }];`
}, 220, 0);
connect('Error Trigger', 'Extract Error Context');

// =========================================================================
// 3. WRITE LOG FILE — siempre se ejecuta (aunque no podamos responder)
// =========================================================================
// Path: /data/logs/errors-YYYY-MM-DD.jsonl
// Esta carpeta está bind-mounted en docker-compose.yml a ./logs en el host,
// así que los logs persisten y son inspeccionables sin entrar al contenedor.
//
// Usamos `fs.promises.appendFile` con `mkdir -p` defensivo. Si la escritura
// falla por permisos / volumen no montado, NO queremos romper el handler:
// dejamos un console.error y seguimos, así el usuario igual recibe el reply.
addNode('Write Error Log', 'n8n-nodes-base.code', {
    jsCode: `const fs = require('fs');
const path = require('path');
const item = $input.first().json;
const entry = item.logEntry || {};

const LOG_DIR = '/data/logs';
const day = (entry.timestamp || new Date().toISOString()).slice(0, 10);
const file = path.join(LOG_DIR, 'errors-' + day + '.jsonl');

let writeOk = false;
let writeError = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\\n', 'utf8');
  writeOk = true;

  // Rotación lazy: gzipea archivos errors-*.jsonl con > 7 días que aún no
  // estén comprimidos. Es best-effort — si falla no rompe nada (cof:true).
  // No usamos cron porque queremos que el rotation viva donde nacen los logs.
  try {
    const cutoffMs = Date.now() - (7 * 24 * 3600 * 1000);
    const files = fs.readdirSync(LOG_DIR);
    for (const f of files) {
      if (!/^errors-\\d{4}-\\d{2}-\\d{2}\\.jsonl$/.test(f)) continue;
      const full = path.join(LOG_DIR, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs >= cutoffMs) continue;
      // gzip y borrá el original. require('zlib') es built-in, siempre disponible.
      const zlib = require('zlib');
      const data = fs.readFileSync(full);
      fs.writeFileSync(full + '.gz', zlib.gzipSync(data));
      fs.unlinkSync(full);
    }
    // Borramos archivos .gz con > 60 días — retention.
    const retentionMs = Date.now() - (60 * 24 * 3600 * 1000);
    for (const f of files) {
      if (!/^errors-\\d{4}-\\d{2}-\\d{2}\\.jsonl\\.gz$/.test(f)) continue;
      const full = path.join(LOG_DIR, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < retentionMs) fs.unlinkSync(full);
    }
  } catch (_rotErr) {
    // rotation es best-effort; si falla, lo emitimos a stderr pero no rompe
    try { console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'log_rotation_failed',
      message: String(_rotErr && _rotErr.message || _rotErr)
    })); } catch (_) {}
  }
} catch (e) {
  writeError = String(e && e.message || e);
  // Fallback estructurado: stderr siempre disponible, lo capturan los logs
  // de Docker. La entrada original ya se emitió en Extract Error Context;
  // acá emitimos un evento adicional avisando que el archivo de log falló.
  try { console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'critical', event: 'error_log_write_failed',
    target_file: file, error: writeError, original_event: entry.event
  })); } catch (_) {}
}

return [{ json: { ...item, logFile: file, logWriteOk: writeOk, logWriteError: writeError } }];`
}, 440, 0, { cof: true, always: true });
connect('Extract Error Context', 'Write Error Log');

// =========================================================================
// 4. IF CAN REPLY — solo intentamos enviar si tenemos phone+instance
// =========================================================================
addNode('IF Can Reply', 'n8n-nodes-base.if', {
    conditions: {
        options: { caseSensitive: true, typeValidation: 'strict', version: 1 },
        combinator: 'and',
        conditions: [{
            id: 'c1',
            operator: { type: 'boolean', operation: 'true' },
            leftValue: '={{ $json.canReply }}',
            rightValue: true
        }]
    },
    options: {}
}, 660, 0);
connect('Write Error Log', 'IF Can Reply');

// =========================================================================
// 5. SEND ERROR REPLY — Evolution API send-text
// =========================================================================
// `cof: true` para que un fallo de Evolution (API caída, instancia muerta) no
// haga fallar el workflow de error en cascada. Si esto explota, el log ya
// quedó escrito en el paso anterior.
addNode('Send Error Reply', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api',
    instanceName: '={{ $json.instance }}',
    remoteJid: '={{ $json.phone }}',
    messageText: '={{ $json.userReply }}',
    options_message: {}
}, 880, -100, { tv: 1, creds: { evolutionApi: EVO }, cof: true, always: true });
connect('IF Can Reply', 'Send Error Reply', 0);

// Verificación post-send: si Evolution falló, el usuario NO recibió ni el
// reply original (porque el agente reventó) NI el mensaje de error (porque
// Evolution está caído). Es el peor escenario UX. Lo logueamos como CRITICAL
// para que el operador lo note en stderr aunque la base esté OK.
addNode('Verify Reply Sent', 'n8n-nodes-base.code', {
    jsCode: `const item = $input.first()?.json || {};
const sendErr = item.error || item.errorMessage || (item.message && /error/i.test(item.message) ? item.message : null);
const sent = !sendErr && (item.key || item.messageId || item.id);
const ts = new Date().toISOString();
if (!sent) {
  try { console.error(JSON.stringify({
    ts, level: 'critical', event: 'error_reply_send_failed',
    error: String(sendErr || 'no message id in evolution response'),
    phone_present: true,
    note: 'usuario NO recibió ni el reply original ni el mensaje de error'
  })); } catch (_) {}
}
return [{ json: { ...item, replySent: !!sent, replySendError: sendErr || null } }];`
}, 1100, -100, { cof: true, always: true });
connect('Send Error Reply', 'Verify Reply Sent');

// Rama "no podemos responder" → log estructurado para diferenciar "no había
// teléfono" (e.g. error en cron) vs. "Evolution falló" (más arriba).
addNode('Skip Reply', 'n8n-nodes-base.code', {
    jsCode: `const item = $input.first()?.json || {};
try { console.error(JSON.stringify({
  ts: new Date().toISOString(), level: 'info', event: 'error_reply_skipped',
  reason: 'no_phone_extracted',
  workflow: item.logEntry && item.logEntry.workflow || null
})); } catch (_) {}
return [{ json: item }];`
}, 880, 100);
connect('IF Can Reply', 'Skip Reply', 1);

// =========================================================================
// EMIT JSON
// =========================================================================
const wf = {
    id: 'chefin_error_v3',
    name: 'Chefin Error Handler v3',
    nodes,
    connections,
    pinData: {},
    active: true, // se activa solo, no necesita trigger manual
    settings: {
        executionOrder: 'v1',
        timezone: 'America/Argentina/Buenos_Aires',
        saveExecutionProgress: true,
        saveManualExecutions: true,
        saveDataErrorExecution: 'all',
        saveDataSuccessExecution: 'all'
    },
    meta: { templateCredsSetupCompleted: true },
    tags: []
};
process.stdout.write(JSON.stringify(wf, null, 2));
