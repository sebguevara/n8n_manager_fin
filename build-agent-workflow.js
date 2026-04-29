// Builds the Chefin Agent v3 main workflow (LangChain Tools Agent).
// Run with: node build-agent-workflow.js > workflows/chefin-agent-v3.json
//
// This workflow REPLACES the rigid `AI Classify + Switch + 17 handlers` block
// of chefis.json with a tool-calling agent that can chain multiple SQL/utility
// tools and compose free-form replies. Pre-AI flow (webhook, OCR, dedup, buffer)
// is reused identically.
//
// IMPORTANT: this workflow contains `__TOOLS_WF_ID__` placeholders for the
// sub-workflow id. After importing both workflows, replace those placeholders
// with the actual id of `chefin-tools-v3` (visible in the n8n URL after import).

const PG = { id: 'f8CCpjEZRkcHEaJI', name: 'Postgres account' };
const REDIS = { id: 'igDqU9rqRBlmVQGc', name: 'Redis account' };
const OPENAI = { id: '0ErbOR5W4QIYaohV', name: 'OpenAI account' };
const EVO = { id: 'FgeqqvxAqTER4oeD', name: 'Evolution account' };
const EVO_KEY = 'ddc0c55de962f185e21f5bb18e1233b1f443417772e1f4c16c8a630bf902fcef';
const TOOLS_WF_ID = '__TOOLS_WF_ID__';

let idCounter = 1;
const newId = () => `n${(idCounter++).toString().padStart(3,'0')}`;
const nodes = [];
const connections = {};

const addNode = (name, type, params, x, y, extras = {}) => {
    nodes.push({
        parameters: params, id: newId(), name, type,
        typeVersion: extras.tv || 2, position: [x, y],
        ...(extras.creds && { credentials: extras.creds }),
        ...(extras.cof && { continueOnFail: true }),
        ...(extras.always && { alwaysOutputData: true }),
        ...(extras.webhookId && { webhookId: extras.webhookId })
    });
    return name;
};
const connect = (from, to, fromIdx = 0, toIdx = 0, type = 'main') => {
    if (!connections[from]) connections[from] = {};
    if (!connections[from][type]) connections[from][type] = [];
    while (connections[from][type].length <= fromIdx) connections[from][type].push([]);
    connections[from][type][fromIdx].push({ node: to, type, index: toIdx });
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
// PRE-AI FLOW (reused from chefis.json)
// =========================================================================
addNode('Webhook', 'n8n-nodes-base.webhook', {
    httpMethod: 'POST', path: 'chefin', options: {}
}, 0, 0, { tv: 2, webhookId: 'b8b4a1c2-3e1f-4a3b-9d99-c8c2c2c2c2c2' });

addNode('IF Valid Inbound', 'n8n-nodes-base.if', {
    conditions: cond('and', [
        eqStr('c1', '={{ $json.body.event }}', 'messages.upsert'),
        { id: 'c2', operator: { type: 'boolean', operation: 'false' },
          leftValue: '={{ $json.body.data.key.fromMe }}', rightValue: false }
    ]), options: {}
}, 220, 0);
connect('Webhook', 'IF Valid Inbound');

addNode('Extract Fields', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'a1', name: 'instance', type: 'string', value: '={{ $json.body.instance }}' },
        { id: 'a2', name: 'messageId', type: 'string', value: '={{ $json.body.data.key.id }}' },
        { id: 'a3', name: 'remoteJid', type: 'string', value: '={{ $json.body.data.key.remoteJid }}' },
        { id: 'a4', name: 'phone', type: 'string', value: "={{ $json.body.data.key.remoteJid.split('@')[0] }}" },
        { id: 'a5', name: 'pushName', type: 'string', value: "={{ $json.body.data.pushName || '' }}" },
        { id: 'a6', name: 'messageType', type: 'string', value: '={{ $json.body.data.messageType }}' },
        { id: 'a7', name: 'text', type: 'string', value: "={{ $json.body.data.message?.conversation || $json.body.data.message?.extendedTextMessage?.text || '' }}" },
        { id: 'a8', name: 'caption', type: 'string', value: "={{ $json.body.data.message?.imageMessage?.caption || '' }}" }
    ] }, options: {}
}, 440, 0, { tv: 3.4 });
connect('IF Valid Inbound', 'Extract Fields');

addNode('IF Allowed Phone', 'n8n-nodes-base.if', {
    conditions: cond('and', [
        { id: 'c1', operator: { type: 'boolean', operation: 'true' },
          leftValue: "={{ ($env.ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(p => p).includes($json.phone) }}",
          rightValue: true }
    ]), options: {}
}, 660, 0);
connect('Extract Fields', 'IF Allowed Phone');

addNode('Switch Media Type', 'n8n-nodes-base.switch', {
    rules: { values: [
        { conditions: cond('and', [eqStr('r1','={{ $json.messageType }}','imageMessage')]), renameOutput: true, outputKey: 'image' },
        { conditions: cond('and', [eqStr('r2','={{ $json.messageType }}','audioMessage')]), renameOutput: true, outputKey: 'audio' },
        { conditions: cond('and', [eqStr('r3','={{ $json.messageType }}','documentMessage')]), renameOutput: true, outputKey: 'document' }
    ] }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'text' }
}, 880, 0, { tv: 3 });
connect('IF Allowed Phone', 'Switch Media Type');

// IMAGE
addNode('Download Image', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: '=http://evolution-api:8080/chat/getBase64FromMediaMessage/{{ $json.instance }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'apikey', value: `=${EVO_KEY}` }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: '={\n  "message": { "key": { "id": "{{ $json.messageId }}" } },\n  "convertToMp4": false\n}',
    options: {}
}, 1100, -200, { tv: 4.2 });
connect('Switch Media Type', 'Download Image', 0);

addNode('Vision OCR', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: `={\n  "model": "gpt-4o-mini",\n  "response_format": {"type":"json_object"},\n  "temperature": 0.1, "max_tokens": 1500,\n  "messages": [\n    {"role":"system","content":"Sos un experto leyendo tickets argentinos. Devolvé JSON con: {is_receipt:bool, merchant, amount(número), currency:'ARS', transaction_date_iso, payment_method_hint, category_hint, description, confidence(0-1), human_reply}. Si no es un comprobante, is_receipt=false. amount=TOTAL final."},\n    {"role":"user","content":[\n      {"type":"text","text":"Caption: {{ $('Extract Fields').first().json.caption || '(ninguno)' }}"},\n      {"type":"image_url","image_url":{"url":"data:{{ $json.mimetype || 'image/jpeg' }};base64,{{ $json.base64 }}"}}\n    ]}\n  ]\n}`,
    options: {}
}, 1320, -200, { tv: 4.2, creds: { openAiApi: OPENAI } });
connect('Download Image', 'Vision OCR');

addNode('Receipt to Text', 'n8n-nodes-base.code', {
    jsCode: `const resp=$input.first().json;const ctx=$('Extract Fields').first().json;
let payload;try{payload=JSON.parse(resp.choices?.[0]?.message?.content||'{}');}catch{payload={is_receipt:false,human_reply:'No pude leer el comprobante.'};}
let syntheticText;
if(payload.is_receipt && Number(payload.amount) > 0){
  const dateOnly = payload.transaction_date_iso ? String(payload.transaction_date_iso).slice(0,10) : '';
  const desc = payload.description || (payload.merchant ? 'pago a '+payload.merchant : 'comprobante');
  const parts = ['pagué', String(payload.amount), 'de', payload.category_hint||'otros'];
  if(payload.payment_method_hint) parts.push('con', payload.payment_method_hint);
  if(dateOnly) parts.push('el', dateOnly);
  parts.push('—', desc);
  syntheticText = parts.join(' ');
} else { syntheticText = payload.human_reply || 'No pude leer el comprobante.'; }
return [{ json: { text: syntheticText, phone: ctx.phone, remoteJid: ctx.remoteJid, instance: ctx.instance, messageId: ctx.messageId, pushName: ctx.pushName, receipt_data: payload } }];`
}, 1540, -200);
connect('Vision OCR', 'Receipt to Text');

// AUDIO
addNode('Download Audio', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: '=http://evolution-api:8080/chat/getBase64FromMediaMessage/{{ $json.instance }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'apikey', value: `=${EVO_KEY}` }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: '={\n  "message": { "key": { "id": "{{ $json.messageId }}" } },\n  "convertToMp4": false\n}',
    options: {}
}, 1100, 0, { tv: 4.2 });
connect('Switch Media Type', 'Download Audio', 1);

addNode('Audio to Binary', 'n8n-nodes-base.code', {
    jsCode: `const item=$input.first().json;const ctx=$('Extract Fields').first().json;
const b64=item.base64||'';if(!b64)throw new Error('Empty audio base64');
const buf=Buffer.from(b64,'base64');
const bin=await this.helpers.prepareBinaryData(buf,'audio.ogg',item.mimetype||'audio/ogg');
return [{ json:{phone:ctx.phone,remoteJid:ctx.remoteJid,instance:ctx.instance,messageId:ctx.messageId,pushName:ctx.pushName}, binary:{data:bin} }];`
}, 1320, 0);
connect('Download Audio', 'Audio to Binary');

addNode('Whisper Transcribe', '@n8n/n8n-nodes-langchain.openAi', {
    resource: 'audio', operation: 'transcribe', options: { language: 'es' }
}, 1540, 0, { tv: 1.8, creds: { openAiApi: OPENAI } });
connect('Audio to Binary', 'Whisper Transcribe');

// PDF — simplified: convert to text, then synth `pagué ...` style messages
// (full PDF bulk import flow can be added later if needed)
addNode('Download PDF', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: '=http://evolution-api:8080/chat/getBase64FromMediaMessage/{{ $json.instance }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'apikey', value: `=${EVO_KEY}` }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: '={\n  "message": { "key": { "id": "{{ $json.messageId }}" } },\n  "convertToMp4": false\n}',
    options: {}
}, 1100, 200, { tv: 4.2 });
connect('Switch Media Type', 'Download PDF', 2);

addNode('PDF to Binary', 'n8n-nodes-base.code', {
    jsCode: `const item=$input.first().json;const ctx=$('Extract Fields').first().json;
const b64=item.base64||'';if(!b64)throw new Error('Empty PDF base64');
const buf=Buffer.from(b64,'base64');
const bin=await this.helpers.prepareBinaryData(buf,'document.pdf','application/pdf');
return [{ json:{phone:ctx.phone,remoteJid:ctx.remoteJid,instance:ctx.instance,messageId:ctx.messageId,pushName:ctx.pushName}, binary:{data:bin} }];`
}, 1320, 200);
connect('Download PDF', 'PDF to Binary');

addNode('Extract PDF Text', 'n8n-nodes-base.extractFromFile', {
    operation: 'pdf', binaryPropertyName: 'data', options: {}
}, 1540, 200, { tv: 1 });
connect('PDF to Binary', 'Extract PDF Text');

addNode('PDF Stub Text', 'n8n-nodes-base.code', {
    jsCode: `const item=$input.first().json;const ctx=$('Extract Fields').first().json;
const txt = (item.text || '').slice(0, 4000);
return [{ json: { text: 'Adjunté un PDF. Contenido relevante:\\n\\n' + txt, phone: ctx.phone, remoteJid: ctx.remoteJid, instance: ctx.instance, messageId: ctx.messageId, pushName: ctx.pushName } }];`
}, 1760, 200);
connect('Extract PDF Text', 'PDF Stub Text');

// TEXT entry / merge
addNode('Pass Text', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'a1', name: 'text', type: 'string', value: '={{ $json.text }}' },
        { id: 'a2', name: 'phone', type: 'string', value: "={{ $('Extract Fields').first().json.phone }}" },
        { id: 'a3', name: 'remoteJid', type: 'string', value: "={{ $('Extract Fields').first().json.remoteJid }}" },
        { id: 'a4', name: 'instance', type: 'string', value: "={{ $('Extract Fields').first().json.instance }}" },
        { id: 'a5', name: 'messageId', type: 'string', value: "={{ $('Extract Fields').first().json.messageId }}" },
        { id: 'a6', name: 'pushName', type: 'string', value: "={{ $('Extract Fields').first().json.pushName }}" }
    ] }, options: {}
}, 1980, 0, { tv: 3.4 });
connect('Switch Media Type', 'Pass Text', 3);
connect('Whisper Transcribe', 'Pass Text');
connect('Receipt to Text', 'Pass Text');
connect('PDF Stub Text', 'Pass Text');

addNode('Bootstrap User', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT bootstrap_user($1::text, $2::text) AS user_id;',
    options: { queryReplacement: '={{ $json.phone }},={{ $json.pushName }}' }
}, 2200, 0, { tv: 2.5, creds: { postgres: PG } });
connect('Pass Text', 'Bootstrap User');

addNode('Get Conv State', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT cs.state AS conv_state, cs.context AS conv_context, u.onboarded FROM users u LEFT JOIN conversation_state cs ON cs.user_id=u.id AND cs.expires_at > NOW() WHERE u.id = $1::uuid;",
    options: { queryReplacement: '={{ $json.user_id }}' }
}, 2420, 0, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Bootstrap User', 'Get Conv State');

addNode('Merge Ctx', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Bootstrap User').first().json.user_id }}" },
        { id: 't', name: 'text', type: 'string', value: "={{ $('Pass Text').first().json.text }}" },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Pass Text').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Pass Text').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Pass Text').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Pass Text').first().json.messageId }}" },
        { id: 'pn', name: 'pushName', type: 'string', value: "={{ $('Pass Text').first().json.pushName }}" },
        { id: 'cs', name: 'convState', type: 'string', value: "={{ $json.conv_state || '' }}" },
        { id: 'cc', name: 'convContext', type: 'object', value: "={{ $json.conv_context || {} }}" },
        { id: 'ob', name: 'onboarded', type: 'boolean', value: "={{ $json.onboarded || false }}" }
    ] }, options: {}
}, 2640, 0, { tv: 3.4 });
connect('Get Conv State', 'Merge Ctx');

// Dedup with atomic INCR (the fix from the previous session)
addNode('Mark Processed', 'n8n-nodes-base.redis', {
    operation: 'incr', key: '=processed:{{ $json.messageId }}',
    expire: true, ttl: 3600, propertyName: 'procCount', options: {}
}, 2860, 0, { tv: 1, creds: { redis: REDIS } });
connect('Merge Ctx', 'Mark Processed');

addNode('IF First Time', 'n8n-nodes-base.if', {
    conditions: cond('and', [{
        id: 'c1', operator: { type: 'number', operation: 'equals' },
        leftValue: '={{ Number($json.procCount) }}', rightValue: 1
    }]), options: {}
}, 3080, 0);
connect('Mark Processed', 'IF First Time');

// Buffer + Lock + Wait + Concat (debounce)
addNode('Buffer Push', 'n8n-nodes-base.redis', {
    operation: 'push',
    list: "=buffer:{{ $('Merge Ctx').first().json.phone }}",
    messageData: "={{ $('Merge Ctx').first().json.text }}", tail: true
}, 3300, 0, { tv: 1, creds: { redis: REDIS } });
connect('IF First Time', 'Buffer Push', 0);

addNode('Lock Token', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'lt', name: 'lockToken', type: 'string', value: "={{ $now.toMillis() + '-' + Math.random().toString(36).slice(2,10) }}" },
        { id: 'ph', name: 'phone', type: 'string', value: "={{ $('Merge Ctx').first().json.phone }}" }
    ] }, includeOtherFields: true, options: {}
}, 3520, 0, { tv: 3.4 });
connect('Buffer Push', 'Lock Token');

addNode('Lock Set', 'n8n-nodes-base.redis', {
    operation: 'set', key: '=lock:{{ $json.phone }}',
    value: '={{ $json.lockToken }}', expire: true, ttl: 30
}, 3740, 0, { tv: 1, creds: { redis: REDIS } });
connect('Lock Token', 'Lock Set');

addNode('Wait', 'n8n-nodes-base.wait', { amount: 6 },
    3960, 0, { tv: 1.1, webhookId: '7e7eaba2-f851-4e37-8748-2c03cc8144aa' });
connect('Lock Set', 'Wait');

addNode('Lock Get', 'n8n-nodes-base.redis', {
    operation: 'get', propertyName: 'currentLock',
    key: "=lock:{{ $('Lock Token').first().json.phone }}", options: {}
}, 4180, 0, { tv: 1, creds: { redis: REDIS } });
connect('Wait', 'Lock Get');

addNode('IF Won Race', 'n8n-nodes-base.if', {
    conditions: cond('and', [{
        id: 'c1', operator: { type: 'string', operation: 'equals' },
        leftValue: '={{ $json.currentLock }}',
        rightValue: "={{ $('Lock Token').first().json.lockToken }}"
    }]), options: {}
}, 4400, 0);
connect('Lock Get', 'IF Won Race');

addNode('Buffer Get', 'n8n-nodes-base.redis', {
    operation: 'get', propertyName: 'bufferedMessages',
    key: "=buffer:{{ $('Lock Token').first().json.phone }}",
    keyType: 'list', options: {}
}, 4620, 0, { tv: 1, creds: { redis: REDIS } });
connect('IF Won Race', 'Buffer Get', 0);

addNode('Buffer Delete', 'n8n-nodes-base.redis', {
    operation: 'delete',
    key: "=buffer:{{ $('Lock Token').first().json.phone }}"
}, 4840, 0, { tv: 1, creds: { redis: REDIS } });
connect('Buffer Get', 'Buffer Delete');

addNode('Concat', 'n8n-nodes-base.code', {
    jsCode: `const buf=$input.first().json.bufferedMessages||[];
const ctx=$('Merge Ctx').first().json;
const combined=buf.filter(Boolean).map(s=>String(s).trim()).join(' \\n ').trim();
return [{ json:{ userId:ctx.userId, phone:ctx.phone, remoteJid:ctx.remoteJid, instance:ctx.instance, messageId:ctx.messageId, pushName:ctx.pushName, combinedText:combined, bufferLength:buf.length, convState:ctx.convState, convContext:ctx.convContext, onboarded:ctx.onboarded }}];`
}, 5060, 0);
connect('Buffer Delete', 'Concat');

// =========================================================================
// AGENT BLOCK (replaces AI Classify + Switch + handlers)
// =========================================================================

// System prompt for the agent — lives in expression mode (`=` prefix) so n8n
// evaluates {{ $now }} / {{ $json.convState }} at runtime.
const SYSTEM_PROMPT = `=Sos **Chefin**, asistente conversacional experto en finanzas personales para WhatsApp en español rioplatense (Argentina).

# CONTEXTO DE LA CONVERSACIÓN
- Fecha y hora actual: {{ $now.toFormat('yyyy-MM-dd HH:mm') }} (America/Argentina/Buenos_Aires)
- Día de la semana: {{ $now.toFormat('EEEE') }}
- Estado de conversación previo: {{ $json.convState || 'ninguno' }}
- Contexto previo: {{ JSON.stringify($json.convContext || {}) }}
- Onboarded: {{ $json.onboarded }}

# TU MISIÓN
Resolvés CUALQUIER duda del usuario sobre sus finanzas usando las tools disponibles. Podés encadenar varias tools antes de responder. Sos riguroso con datos destructivos: nunca borrás ni editás sin confirmación cuando hay ambigüedad o son varios items.

# TOOLS DISPONIBLES
Cada tool toma JSON; consultá las descripciones de cada una para entender los parámetros. Algunas reglas globales:
- \`user_id\` se inyecta automáticamente — NO lo pongas en \`params\`.
- Períodos válidos: today | yesterday | this_week | this_month | last_month | this_year | all | custom.
- Para búsquedas con DATOS ESPECÍFICOS (monto exacto, fecha exacta, descripción concreta), el período default es \`all\` salvo que el usuario diga lo contrario.
- Para totales/resúmenes sin tiempo especificado, default \`this_month\`.

# ESTRATEGIA DE RAZONAMIENTO

## Para CONSULTAS (lectura)
1. Si el usuario menciona texto deíctico ("esos", "el primero", "los de 3300 que mostraste") → llamá \`get_last_list\` PRIMERO.
2. Para preguntas tipo "cuánto gasté X" → \`get_total\`.
3. Para "en qué gasté más / desglosá" → \`get_breakdown\` con dimension=category.
4. Para "comparame mes a mes" / "gasté más que el pasado" → \`compare_periods\`.
5. Para "mostrame los últimos / los movs" → \`query_transactions\`.
6. Para "buscame los café / los uber / los de 5000" → \`find_transactions\` con filtros determinísticos cuando sean exactos.
7. Después de mostrar una lista de transacciones (>1 item), llamá \`remember_last_list\` con sus ids para resolver referencias deícticas en el siguiente turno.

## Para REGISTRO (gasto/ingreso nuevo)
- Llamá \`log_transaction\`. Si la tool devuelve \`needs_confirmation: 'duplicate'\` → preguntá al usuario si quiere registrar de todas formas (y si dice sí, volvés a llamar con \`skip_dup_check: true\`).

## Para BORRAR / EDITAR
- 1 transacción específica con monto+fecha exactos:
  1. \`find_transactions\` para obtener candidatos con sus ids.
  2. Si devuelve UN solo match → ejecutás \`delete_transaction\` o \`update_transaction\` directo.
  3. Si devuelve VARIOS matches → mostrás la lista numerada al usuario, llamás \`remember_last_list\`, pedís que aclare cuál.
- "el último" (sin específicos) → \`query_transactions\` ordenado por date_desc + límite 1.
- BULK delete por criterio ("borrá todos los café del mes pasado"):
  1. \`bulk_preview\` con los filtros para obtener count + sample + ids.
  2. Mostrás al usuario: "Voy a borrar N gastos por $X. ¿Confirmás?". Llamás \`set_conv_state\` con state='awaiting_bulk_delete' y context={ids:[...]}.
  3. Cuando responda "sí" → \`bulk_delete\` con esos ids exactos. Llamás \`clear_conv_state\`.
- "Eliminá los gastos repetidos" → \`find_duplicates\` → mostrás los clusters → confirmás → \`bulk_delete\` con los ids elegidos.

## Para CHARLA / FECHAS / IDENTIDAD
- "qué fecha es hoy?" → respondé directo desde el contexto, SIN tools.
- "hola / gracias / cómo andás" → respondé natural, SIN tools.
- "ayuda / qué podés hacer" → enumerá brevemente: registrar, consultar, borrar, editar, gráficos, presupuestos, recurrentes, reportes.

## Para GRÁFICOS
- "gráfico de gastos / torta / por categoría" → \`generate_chart\` con dimension. Devolverá image_url + caption.

# ESTILO DE RESPUESTA (FORMATO FINAL)
SIEMPRE devolvé tu respuesta como JSON con esta estructura. Es la ÚNICA forma de responder al usuario:

{
  "reply_text": "<mensaje en español rioplatense, max 1500 chars salvo que sea una lista>",
  "reply_kind": "text" | "image",
  "image_url": "<URL si reply_kind=image>",
  "should_react": false,
  "reaction_emoji": ""
}

Reglas de formato:
- Listas de transacciones: numerá del 1 al N con formato \`N. AAAA-MM-DD · 💸 categoría · $monto — descripción\`. Después de la lista decí algo útil tipo "Decime cuál querés borrar/editar".
- Totales: \`💸 Gastaste $X en período (N movs).\`
- Breakdowns: lista vertical con %.
- Comparativas: \`Este mes: $X (N) · Mes pasado: $Y (M) · Diferencia: +Δ%\`.
- Confirmaciones bulk: muestra preview de hasta 5 items, total, count, y "¿confirmás? (sí/no)".
- Si NO hay datos: mensaje empático, breve.
- 1 mensaje por turno. Si supera 1500 chars el wrapper lo parte solo.

Reacciones (\`should_react: true\`):
- SOLO cuando acabás de loggear gasto (✅) o ingreso (💰), borrar (🗑️), editar (✏️) o generar gráfico (📈).
- Para queries, charla, ayuda, listas, búsquedas → \`should_react: false\`.

# LÉXICO ARGENTINO (no afecta clasificación)
Muletillas que ignorás al clasificar pero respondés en tono natural:
- "cucha", "che", "dale", "loco/a", "boludo/a", "mirá", "fijate", "viste", "ahre"
- Diminutivos: "cafecito"=café, "lukita"=mil pesos
- Plata = dinero. Luca = mil ("3 lucas"=3000). Palo = millón. K=mil ("30k"=30000). M=millón.

# FORMATO DE NÚMEROS Y FECHAS (ARGENTINO)
- Montos en respuestas: \`$2.000,50\` (punto como separador de miles, coma como decimal). Ejemplo: \`$11.900,00\`.
- Fechas en respuestas: relativas si aplica ("hoy", "ayer", "el lunes"); absolutas como "27 de abril".
- Fechas en parámetros de tools: SIEMPRE ISO \`YYYY-MM-DD\`.
- Si el usuario dice "27 de abril" sin año, asumí el año actual.
- Si el usuario dice "el lunes pasado", calculalo desde la fecha de contexto.

# ESTADOS CONVERSACIONALES HEREDADOS DE V1
Si \`convState\` viene con uno de estos valores legacy del workflow viejo, manejalo igual:
- \`awaiting_otros_confirmation\`: el usuario confirma o aclara la categoría de un gasto pendiente.
- \`awaiting_dup_confirmation\`: el usuario confirma si registra un gasto duplicado.
- \`awaiting_pdf_import\`: el usuario confirma importar gastos del PDF.
Cuando el usuario contesta "sí/dale/ok" y hay un \`convState\` activo → tomá la acción pendiente con el contexto que viene en \`convContext\`. Cuando contesta "no/cancelá" → \`clear_conv_state\` y avisá.

# EJEMPLOS DE RAZONAMIENTO

**Usuario**: "Mostrame todos mis movimientos"
- Tool: \`query_transactions({"period":"all","limit":20})\` → devuelve N items.
- Si N>0: \`remember_last_list({"kind":"transactions","items":[{position:1,id:..,...}]})\` con los ids.
- Reply: lista numerada con los items + breve resumen del total.

**Usuario**: "borrá los 3300 del 27 de abril"
- Tool: \`find_transactions({"exact_amount":3300,"date":"2026-04-27"})\` → devuelve 3 matches.
- Reply numerada con los 3 + \`remember_last_list\` con sus ids + "Decime cuál(es) borrar (1, 2, 3 o todos)".
- NUNCA borrás directo si hay >1 candidato.

**Usuario**: "elimina las 2 últimas transferencias a maxi"
Pasos OBLIGATORIOS:
1. Tool: \`find_transactions({"description_contains":"maxi","sort":"date_desc","limit":20})\` → devuelve TODAS las transferencias que mencionen "maxi" en descripción, ordenadas por fecha desc.
2. Si hay ≥2: tomá las primeras 2 (las "últimas" cronológicamente = más recientes = primeras en date_desc).
3. \`bulk_preview\` NO es necesario porque ya tenés ids exactos. Llamá directamente \`bulk_delete({"ids":[id1, id2]})\`.
4. Reply: "🗑️ Borré 2 transferencias a Maxi por $X total. Te queda 1." con \`should_react: true, reaction_emoji: "🗑️"\`.
5. Si el usuario dice "las últimas N" sin nombrar una persona, mirá \`get_last_list\` primero — si tenés contexto fresco, usalo.
NUNCA borres "el último" cuando el usuario claramente identificó un grupo (transferencias a X, gastos de Y, etc).

**Usuario**: "borrá las 2 últimas transferencias" (sin nombre)
- \`find_transactions({"category":"otros","description_contains":"transferencia","sort":"date_desc","limit":20})\` → todas las transferencias.
- Tomá las 2 más recientes → \`bulk_delete\`.

**Usuario** (después): "borrá los 2 primeros"
- Tool: \`get_last_list\` → recuperás items.
- Tool: \`bulk_delete({"ids":[items[0].id, items[1].id]})\`.
- Reply: "Borré 2 movs por $6.600. Quedó 1 transferencia de $3.300 del 27/04."

**Usuario**: "elimina los gastos repetidos"
- Tool: \`find_duplicates({"window_days":7,"min_repetitions":2})\` → devuelve clusters.
- Reply con los clusters + \`remember_last_list({kind:'duplicate_clusters',items:[...]})\` + "¿Borro estos? Decime cuáles (1, 2, todos) o 'no' para cancelar".
- Cuando confirme → \`bulk_delete\` con los ids.

**Usuario**: "gasté más este mes que el pasado?"
- Tool: \`compare_periods({"period_a":"this_month","period_b":"last_month"})\`.
- Reply: "Este mes: $X (N movs). Mes pasado: $Y (M movs). +Δ% más."

**Usuario**: "Cuál fue mi último gasto?"
- Tool: \`query_transactions({"period":"all","limit":1,"sort":"date_desc","type":"expense"})\`.
- Reply: descripción del item + "¿querés borrarlo o editarlo?"

**Usuario**: "el último gasto fue de 5000 no de 2000"
- Tool: \`query_transactions({"period":"all","limit":1,"sort":"date_desc","exact_amount":2000})\` → encuentra el item.
- Tool: \`update_transaction({"transaction_id":id,"new_amount":5000})\`.
- Reply: "Listo, lo cambié a $5.000,00." con \`should_react: true, reaction_emoji: "✏️"\`.

**Usuario**: "tomé 2500 de café"
- Tool: \`log_transaction({"amount":2500,"description":"café","category_hint":"comida","type":"expense"})\`.
- Si retorna \`needs_confirmation:duplicate\` → preguntá si registra igual.
- Si \`inserted:true\` → reply confirmando + \`should_react: true, reaction_emoji: "✅"\`.

**Usuario**: "gracias!"
- Sin tools. Reply breve. \`should_react: false\`.

**Usuario**: "qué fecha es hoy?"
- Sin tools. Usás la fecha del contexto. Formato: "Hoy es lunes 29 de abril de 2026".

**Usuario**: "que quedo?" (mensaje ambiguo, sin contexto)
- Sin tools. Reply breve pidiendo aclaración: "¿A qué te referís? Si querés saber tu saldo del mes te lo digo, decime 'cuanto gasté'."
- NO mandes 2 mensajes.

# REGLAS FINALES
- NUNCA inventes datos. Si no tenés certeza, llamá una tool o pedí aclaración.
- NUNCA inventes UUIDs. Solo usás los que te devuelven las tools.
- NUNCA mostrás UUIDs al usuario.
- Si una tool devuelve \`ok: false\`, leé el error y avisás al usuario en términos amables.
- Sos breve, directo y cálido. Nada de párrafos largos para preguntas simples.
- Si el usuario hace varias preguntas en un mismo turno, respondelas todas en UN solo mensaje (jamás mandés 2 mensajes para una pregunta).
- Si el usuario contradice una respuesta tuya anterior ("me decís 4 movs y mostrás 2"), revisá tu razonamiento, releé las tools que llamaste, y corregí sin inventar.
- Si una operación destructiva afecta >3 items, SIEMPRE pasá por preview + confirmación.
- Cuando el usuario te ataca o se enoja, reconocelo brevemente, NO te disculpes en exceso, y resolvé el problema.`;

// Chat model
addNode('OpenAI Chat Model', '@n8n/n8n-nodes-langchain.lmChatOpenAi', {
    model: { __rl: true, mode: 'list', value: 'gpt-4o-mini' },
    options: { temperature: 0.2, maxTokens: 1500 }
}, 5500, 200, { tv: 1.2, creds: { openAiApi: OPENAI } });

// Memory (Postgres chat history per user)
addNode('Postgres Chat Memory', '@n8n/n8n-nodes-langchain.memoryPostgresChat', {
    sessionIdType: 'customKey',
    sessionKey: "={{ $('Concat').first().json.userId }}",
    contextWindowLength: 12,
    tableName: 'n8n_chat_histories'
}, 5720, 200, { tv: 1.3, creds: { postgres: PG } });

// Output parser — structured JSON
addNode('Reply Schema', '@n8n/n8n-nodes-langchain.outputParserStructured', {
    jsonSchemaExample: JSON.stringify({
        reply_text: 'Hola! ¿en qué te ayudo?',
        reply_kind: 'text',
        image_url: '',
        should_react: false,
        reaction_emoji: ''
    }, null, 2)
}, 5940, 200, { tv: 1.2 });

// =========================================================================
// TOOL NODES (each calls the sub-workflow with the right tool_name)
// =========================================================================
const TOOL_DEFS = [
    {
        name: 'query_transactions',
        description: 'Lista transacciones con filtros y paginación. Úsala para "mostrame los movs", "los últimos", "todos los gastos del mes". Filtros opcionales: period, category, description_contains, exact_amount, min_amount, max_amount, type (expense/income/both), group_name, payment_method, sort (date_desc default). Devuelve items con id, date, amount, description, category, emoji.'
    },
    {
        name: 'get_total',
        description: 'Total y count de gastos/ingresos en un período. Para "cuánto gasté", "total del mes", "cuánto en comida". Filtros: period (default this_month), type (default expense), category, group_name.'
    },
    {
        name: 'get_breakdown',
        description: 'Desglose agrupado por dimensión. Para "en qué gasté más", "por categoría", "por método de pago", "por día". Params: dimension (category|day|week|month|payment_method|group), period (default this_month), type (default expense), top_n (default 10).'
    },
    {
        name: 'compare_periods',
        description: 'Compara totales entre dos períodos. Para "este mes vs el pasado", "estoy gastando más que antes". Params: period_a, period_b (mismos enums), type (expense/income).'
    },
    {
        name: 'find_transactions',
        description: 'Busca transacciones específicas para luego borrarlas/editarlas. Devuelve TODAS las que matchean con score y match_reasons. Filtros determinísticos AND: exact_amount, date, date_from, date_to, min_amount, max_amount, type. Filtros fuzzy (rankean): description_contains, category, group_name. Llamá esta antes de cualquier delete/update por hint.'
    },
    {
        name: 'find_duplicates',
        description: 'Detecta gastos repetidos (mismo monto + categoría dentro de N días). Para "elimina los repetidos", "tengo gastos duplicados". Params: window_days (default 7), min_repetitions (default 2). Devuelve clusters con sus transaction_ids.'
    },
    {
        name: 'bulk_preview',
        description: 'Cuenta y muestra preview ANTES de borrar/editar masivo. Acepta los mismos filtros que query_transactions. Devuelve count, total, ids, preview (10 sample). USALA OBLIGATORIAMENTE antes de bulk_delete por criterio.'
    },
    {
        name: 'bulk_delete',
        description: 'Borra múltiples transacciones por una lista explícita de UUIDs. Solo usar después de bulk_preview + confirmación del usuario. Params: ids (array de UUIDs).'
    },
    {
        name: 'bulk_update',
        description: 'Actualiza múltiples transacciones por UUIDs. Params: ids (array), new_category_id?, new_date?, new_group_id?, amount_delta?, set_excluded?.'
    },
    {
        name: 'log_transaction',
        description: 'Registra UN gasto o ingreso nuevo. Params: amount (number), description, category_hint, type (expense|income, default expense), date (YYYY-MM-DD opcional), payment_method_hint (efectivo|debito|credito|transferencia|mercado_pago|otro), group_hint (nombre de viaje/evento opcional), skip_dup_check (bool, solo si el usuario confirmó duplicado). Devuelve needs_confirmation:duplicate si detectó uno.'
    },
    {
        name: 'update_transaction',
        description: 'Edita UNA transacción por UUID exacto. Params: transaction_id (UUID), new_date?, new_amount?, new_description?, new_category_id?.'
    },
    {
        name: 'delete_transaction',
        description: 'Borra UNA transacción por UUID. Params: transaction_id (UUID). Para borrar varias usá bulk_delete.'
    },
    {
        name: 'list_categories',
        description: 'Lista todas las categorías del usuario con sus emojis y conteos. Params: type (expense|income|both opcional), include_excluded (bool).'
    },
    {
        name: 'list_groups',
        description: 'Lista grupos (viajes/eventos/proyectos) con totales.'
    },
    {
        name: 'list_budgets',
        description: 'Lista presupuestos activos con consumo actual y % usado.'
    },
    {
        name: 'set_budget',
        description: 'Crea o actualiza un presupuesto para una categoría. Params: category_hint, amount (number), period (weekly|monthly|yearly).'
    },
    {
        name: 'create_group',
        description: 'Crea un grupo (viaje/evento/proyecto). Params: name, kind (trip|event|emergency|project|other).'
    },
    {
        name: 'toggle_category_exclusion',
        description: 'Excluye/incluye una categoría de los reportes. Params: category_hint.'
    },
    {
        name: 'set_recurring',
        description: 'Crea una transacción recurrente (Netflix, alquiler, etc). Params: amount, description, category_hint, frequency (daily|weekly|biweekly|monthly|yearly), start_date?.'
    },
    {
        name: 'remember_last_list',
        description: 'Guarda la última lista mostrada al usuario para resolver referencias deícticas ("el primero", "esos dos"). LLAMALA después de query_transactions / find_transactions cuando muestres una lista. Params: kind, items (array con id+position), filters_applied, ttl_seconds (default 600).'
    },
    {
        name: 'get_last_list',
        description: 'Recupera la última lista mostrada al usuario. Devuelve items y si está fresca. Llamala cuando el usuario use deícticos.'
    },
    {
        name: 'set_conv_state',
        description: 'Setea estado conversacional pendiente (ej. awaiting_bulk_delete antes de confirmar). Params: state, context (objeto), ttl_seconds (default 600).'
    },
    {
        name: 'clear_conv_state',
        description: 'Limpia el estado conversacional. Llamala después de resolver una confirmación.'
    },
    {
        name: 'generate_chart',
        description: 'Genera un gráfico (URL de imagen) con datos del usuario. Params: dimension (category|day|payment_method), period, type. Devuelve image_url + caption. Cuando uses esta tool, en tu reply final usá reply_kind="image" e image_url.'
    }
];

// Layout the tools horizontally below the agent
let toolX = 5300;
const toolY = 400;
const TOOL_DX = 200;
const toolNames = [];

TOOL_DEFS.forEach((t, i) => {
    const nodeName = `tool: ${t.name}`;
    toolNames.push(nodeName);
    addNode(nodeName, '@n8n/n8n-nodes-langchain.toolWorkflow', {
        name: t.name,
        description: t.description,
        workflowId: { __rl: true, mode: 'id', value: TOOLS_WF_ID },
        workflowInputs: {
            mappingMode: 'defineBelow',
            value: {
                tool_name: t.name,
                user_id: "={{ $('Concat').first().json.userId }}",
                params: "={{ $fromAI('params', 'JSON object with tool parameters', 'json') }}"
            },
            schema: [
                { id: 'tool_name', displayName: 'tool_name', required: true, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
                { id: 'user_id', displayName: 'user_id', required: true, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
                { id: 'params', displayName: 'params', required: false, defaultMatch: false, display: true, type: 'object', canBeUsedToMatch: false }
            ],
            matchingColumns: [],
            attemptToConvertTypes: false,
            convertFieldsToString: false
        }
    }, toolX + (i % 12) * TOOL_DX, toolY + Math.floor(i / 12) * 200, { tv: 2.1 });
});

// Agent itself
addNode('Chefin Agent', '@n8n/n8n-nodes-langchain.agent', {
    promptType: 'define',
    text: "={{ $('Concat').first().json.combinedText }}",
    options: {
        systemMessage: SYSTEM_PROMPT,
        maxIterations: 8,
        returnIntermediateSteps: false
    },
    hasOutputParser: true
}, 5940, 0, { tv: 1.7 });

connect('Concat', 'Chefin Agent');

// Wire ai_* connections to the agent
connect('OpenAI Chat Model', 'Chefin Agent', 0, 0, 'ai_languageModel');
connect('Postgres Chat Memory', 'Chefin Agent', 0, 0, 'ai_memory');
connect('Reply Schema', 'Chefin Agent', 0, 0, 'ai_outputParser');
toolNames.forEach(t => connect(t, 'Chefin Agent', 0, 0, 'ai_tool'));

// =========================================================================
// PARSE AGENT OUTPUT → SAVE CONTEXT → SEND
// =========================================================================
addNode('Parse Agent Output', 'n8n-nodes-base.code', {
    jsCode: `const raw = $input.first().json;
let payload = raw.output || raw;
if (typeof payload === 'string') {
  try { payload = JSON.parse(payload); } catch { payload = { reply_text: payload, reply_kind: 'text' }; }
}
const ctx = $('Concat').first().json;
const replyText = (payload.reply_text || '').trim() || '😅 No supe qué responderte. ¿Lo repetimos?';
const replyKind = payload.reply_kind === 'image' && payload.image_url ? 'image' : 'text';
const shouldReact = !!payload.should_react;
const emoji = (payload.reaction_emoji || '').toString().slice(0, 4);
return [{ json: {
  replyText, replyKind,
  imageUrl: replyKind === 'image' ? (payload.image_url || '') : '',
  shouldReact, reactionEmoji: shouldReact ? (emoji || '✅') : '',
  userId: ctx.userId, phone: ctx.phone, instance: ctx.instance,
  remoteJid: ctx.remoteJid, messageId: ctx.messageId
} }];`
}, 6160, 0);
connect('Chefin Agent', 'Parse Agent Output');

// Chunker — splits replyText into <=1500-char pieces
addNode('Chunk Reply', 'n8n-nodes-base.code', {
    jsCode: `const ctx = $input.first().json;
const MAX = 1500;
const txt = ctx.replyText || '';
function chunk(s) {
  if (s.length <= MAX) return [s];
  const parts = [];
  let buf = '';
  for (const para of s.split(/\\n\\n/)) {
    const candidate = buf ? buf + '\\n\\n' + para : para;
    if (candidate.length > MAX && buf) { parts.push(buf); buf = para; }
    else if (candidate.length > MAX) { // single para > MAX → hard split
      for (let i = 0; i < para.length; i += MAX) parts.push(para.slice(i, i + MAX));
      buf = '';
    } else buf = candidate;
  }
  if (buf) parts.push(buf);
  return parts;
}
const pieces = chunk(txt);
return pieces.map((p, idx) => ({ json: {
  ...ctx, replyText: p, chunkIndex: idx, chunkCount: pieces.length,
  // image only on first chunk; reaction only on last
  replyKind: (idx === 0 ? ctx.replyKind : 'text'),
  imageUrl: (idx === 0 ? ctx.imageUrl : ''),
  shouldReact: ctx.shouldReact && idx === pieces.length - 1,
  reactionEmoji: (ctx.shouldReact && idx === pieces.length - 1) ? ctx.reactionEmoji : ''
} }));`
}, 6380, 0);
connect('Parse Agent Output', 'Chunk Reply');

// Save Context — preserves data through Send Presence
addNode('Save Context', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: '={{ $json.replyText }}' },
        { id: 'k', name: 'replyKind', type: 'string', value: '={{ $json.replyKind }}' },
        { id: 'iu', name: 'imageUrl', type: 'string', value: '={{ $json.imageUrl }}' },
        { id: 'p', name: 'phone', type: 'string', value: '={{ $json.phone }}' },
        { id: 'i', name: 'instance', type: 'string', value: '={{ $json.instance }}' },
        { id: 'j', name: 'remoteJid', type: 'string', value: '={{ $json.remoteJid }}' },
        { id: 'm', name: 'messageId', type: 'string', value: '={{ $json.messageId }}' },
        { id: 'u', name: 'userId', type: 'string', value: '={{ $json.userId }}' },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '={{ $json.reactionEmoji || "" }}' },
        { id: 'sr', name: 'shouldReact', type: 'boolean', value: '={{ Boolean($json.shouldReact) }}' },
        { id: 'cidx', name: 'chunkIndex', type: 'number', value: '={{ $json.chunkIndex || 0 }}' },
        { id: 'ccnt', name: 'chunkCount', type: 'number', value: '={{ $json.chunkCount || 1 }}' }
    ] }, options: {}
}, 6600, 0, { tv: 3.4 });
connect('Chunk Reply', 'Save Context');

addNode('Send Presence', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'chat-api', operation: 'send-presence',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.phone }}",
    delay: 1600
}, 6820, 0, { tv: 1, creds: { evolutionApi: EVO }, cof: true, always: true });
connect('Save Context', 'Send Presence');

addNode('IF Image Reply', 'n8n-nodes-base.if', {
    conditions: cond('and', [eqStr('c1', "={{ $('Save Context').first().json.replyKind }}", 'image')]),
    options: {}
}, 7040, 0);
connect('Send Presence', 'IF Image Reply');

addNode('Send Image', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api', operation: 'send-image',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.phone }}",
    media: "={{ $('Save Context').first().json.imageUrl }}",
    caption: "={{ $('Save Context').first().json.replyText }}",
    options_message: {}
}, 7260, -100, { tv: 1, creds: { evolutionApi: EVO } });
connect('IF Image Reply', 'Send Image', 0);

addNode('Send Text', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.phone }}",
    messageText: "={{ $('Save Context').first().json.replyText }}",
    options_message: {}
}, 7260, 100, { tv: 1, creds: { evolutionApi: EVO } });
connect('IF Image Reply', 'Send Text', 1);

addNode('IF Should React', 'n8n-nodes-base.if', {
    conditions: cond('and', [{
        id: 'c1', operator: { type: 'string', operation: 'notEmpty' },
        leftValue: "={{ $('Save Context').first().json.reactionEmoji }}", rightValue: ''
    }]), options: {}
}, 7480, 0);
connect('Send Image', 'IF Should React');
connect('Send Text', 'IF Should React');

addNode('Send Reaction', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api', operation: 'send-reaction',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.remoteJid }}",
    messageId: "={{ $('Save Context').first().json.messageId }}",
    fromMe: false,
    reaction: "={{ $('Save Context').first().json.reactionEmoji }}"
}, 7700, -100, { tv: 1, creds: { evolutionApi: EVO }, cof: true });
connect('IF Should React', 'Send Reaction', 0);

addNode('Log Outbound', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "INSERT INTO messages (user_id, direction, content, processed, raw_payload) VALUES ($1::uuid, 'outbound', $2, TRUE, $3::jsonb);",
    options: {
        queryReplacement: "={{ $('Save Context').first().json.userId }},={{ $('Save Context').first().json.replyText || '' }},={{ JSON.stringify($('Save Context').first().json) }}"
    }
}, 7920, 0, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Send Reaction', 'Log Outbound');
connect('IF Should React', 'Log Outbound', 1);

// =========================================================================
// EMIT JSON
// =========================================================================
const wf = {
    id: 'chefin_agent_v3',
    name: 'Chefin Agent v3',
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: {
        executionOrder: 'v1',
        binaryMode: 'separate',
        timezone: 'America/Argentina/Buenos_Aires'
    },
    meta: { templateCredsSetupCompleted: true },
    tags: []
};
process.stdout.write(JSON.stringify(wf, null, 2));
