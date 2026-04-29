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
    url: '=http://n8n_evolution-api:8080/chat/getBase64FromMediaMessage/{{ $json.instance }}',
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
    jsonBody: `={\n  "model": "gpt-4o-mini",\n  "response_format": {"type":"json_object"},\n  "temperature": 0.1, "max_tokens": 1500,\n  "messages": [\n    {"role":"system","content":"Sos un experto leyendo comprobantes argentinos. Devolvé JSON con: {is_receipt:bool, merchant, amount(número), currency:'ARS', transaction_date_iso, payment_method_hint, category_hint, description, confidence(0-1), human_reply}. is_receipt=TRUE si la imagen muestra CUALQUIER transacción de plata: ticket de compra, recibo, factura, comprobante de transferencia (Mercado Pago, Banco, etc.), pago de servicio, voucher, captura de movimiento bancario. is_receipt=false SOLO si la imagen no tiene info financiera (selfie, paisaje, meme). amount=monto principal sin signos. category_hint para transferencias salientes='transferencias'."},\n    {"role":"user","content":[\n      {"type":"text","text":"Caption: {{ $('Extract Fields').first().json.caption || '(ninguno)' }}"},\n      {"type":"image_url","image_url":{"url":"data:{{ $json.mimetype || 'image/jpeg' }};base64,{{ $json.base64 }}"}}\n    ]}\n  ]\n}`,
    options: {}
}, 1320, -200, { tv: 4.2, creds: { openAiApi: OPENAI } });
connect('Download Image', 'Vision OCR');

addNode('Receipt to Text', 'n8n-nodes-base.code', {
    jsCode: `const resp=$input.first().json;const ctx=$('Extract Fields').first().json;
let payload;try{payload=JSON.parse(resp.choices?.[0]?.message?.content||'{}');}catch{payload={is_receipt:false,human_reply:'No pude leer el comprobante.'};}
let syntheticText;
// Trust amount over is_receipt flag — vision often marks transferencias as is_receipt:false but extracts the data perfectly
const amount = Number(payload.amount || 0);
if (amount > 0) {
  const dateOnly = payload.transaction_date_iso ? String(payload.transaction_date_iso).slice(0,10) : '';
  const desc = payload.description || (payload.merchant ? 'pago a '+payload.merchant : 'comprobante');
  const parts = ['pagué', String(amount), 'de', payload.category_hint||'otros'];
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
    url: '=http://n8n_evolution-api:8080/chat/getBase64FromMediaMessage/{{ $json.instance }}',
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
    url: '=http://n8n_evolution-api:8080/chat/getBase64FromMediaMessage/{{ $json.instance }}',
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

// Dedup: read existing key, branch on empty (first time) vs set (already processed).
addNode('Redis Check', 'n8n-nodes-base.redis', {
    operation: 'get', propertyName: 'alreadyProcessed',
    key: '=processed:{{ $json.messageId }}', options: {}
}, 2860, 0, { tv: 1, creds: { redis: REDIS }, always: true });
connect('Merge Ctx', 'Redis Check');

addNode('IF First Time', 'n8n-nodes-base.if', {
    conditions: {
        options: { caseSensitive: true, typeValidation: 'loose', version: 1 },
        combinator: 'and',
        conditions: [{
            id: 'c1', operator: { type: 'string', operation: 'empty' },
            leftValue: '={{ $json.alreadyProcessed }}', rightValue: ''
        }]
    },
    options: {}
}, 3080, 0);
connect('Redis Check', 'IF First Time');

// Mark processed (set) only when first time
addNode('Mark Processed', 'n8n-nodes-base.redis', {
    operation: 'set', key: '=processed:{{ $json.messageId }}',
    value: '1', expire: true, ttl: 3600
}, 3300, -100, { tv: 1, creds: { redis: REDIS } });
connect('IF First Time', 'Mark Processed', 0);

// Buffer + Lock + Wait + Concat (debounce)
addNode('Buffer Push', 'n8n-nodes-base.redis', {
    operation: 'push',
    list: "=buffer:{{ $('Merge Ctx').first().json.phone }}",
    messageData: "={{ $('Merge Ctx').first().json.text }}", tail: true
}, 3520, -100, { tv: 1, creds: { redis: REDIS } });
connect('Mark Processed', 'Buffer Push');

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
Cada tool tiene **campos directos** (no un blob \`params\`). Llená cada campo con su tipo correspondiente cuando llamás la tool:

- Cada parámetro se ve como un campo individual (amount, description, period, etc).
- \`user_id\` se inyecta automáticamente — no lo pongas.
- **EXTRAÉ los valores del mensaje del usuario**. Si el mensaje dice "pagué 3300 de transferencias el 27/4", llená \`amount=3300\`, \`category_hint="transferencias"\`, \`date="2026-04-27"\`.
- Si un campo es opcional y no aplica, dejalo en su default. No es necesario escribir cada campo.
- Para tools sin parámetros (\`get_last_list\`, \`clear_conv_state\`, \`list_groups\`, \`list_budgets\`), llamalas sin args.
- Períodos válidos: today | yesterday | this_week | this_month | last_month | this_year | all | custom.
- Para búsquedas con DATOS ESPECÍFICOS (monto exacto, fecha exacta, descripción concreta), el período default es \`all\` salvo que el usuario diga lo contrario.
- Para totales/resúmenes sin tiempo especificado, default \`this_month\`.

"># ESTRATEGIA DE RAZONAMIENTO

## REGLA OBLIGATORIA: PERÍODO EXPLÍCITO
**Antes de CUALQUIER consulta de información (charts, totales, breakdowns, listas, comparativas, búsquedas)**, el período DEBE estar claro. Si el usuario NO menciona explícitamente un período, **PREGUNTÁ ANTES de llamar tools**:

✅ Mensaje del usuario tiene período explícito → usá ese, no preguntes:
   - "este mes", "mes pasado", "esta semana", "hoy", "ayer", "este año", "todo", "histórico"
   - "del 1 al 15 de abril", "entre el 5 y el 10", "desde abril", "hasta el 20", "en marzo"
   - "los últimos 7 días", "últimos 3 meses"

❌ Mensaje sin período → PREGUNTÁ:
   - "haceme un gráfico" → "¿De qué período querés el gráfico? (hoy, esta semana, este mes, un rango específico, desde una fecha, etc.)"
   - "cuánto gasté" → "¿De qué período? Decime hoy, este mes, una fecha, un rango..."
   - "mostrame los movs" → "¿De qué período te los muestro?"
   - "en qué gasté más" → "¿En qué período querés ver el desglose?"

Sin período NO LLAMÁS NINGUNA TOOL DE LECTURA. Es regla dura, no la rompas.

## REGLA GENERAL: encadená tools como un humano lo haría
- ANTES de generar charts/reportes/comparativas → verificá primero que haya data con \`get_total\` o \`query_transactions\`. No charts vacíos.
- ANTES de borrar/editar por hint → \`find_transactions\` primero, mostrar al usuario, confirmar.
- ANTES de bulk_delete por criterio → \`bulk_preview\` siempre.
- DESPUÉS de mostrar una lista de transacciones → \`remember_last_list\` para deícticos.
- Si una tool retorna empty/has_data:false → adapta tu respuesta, NO sigas como si tuvieras datos.

## Para CONSULTAS (lectura)
1. Si el usuario menciona texto deíctico ("esos", "el primero", "los de 3300 que mostraste") → llamá \`get_last_list\` PRIMERO.
2. Para preguntas tipo "cuánto gasté X" → \`get_total\`.
3. Para "en qué gasté más / desglosá" → \`get_breakdown\` con dimension=category.
4. Para "comparame mes a mes" / "gasté más que el pasado" → \`compare_periods\`.
5. Para "mostrame los últimos / los movs" → \`query_transactions\`.
6. Para "buscame los café / los uber / los de 5000" → \`find_transactions\` con filtros determinísticos cuando sean exactos.
7. Después de mostrar una lista de transacciones (>1 item), llamá \`remember_last_list\` con sus ids para resolver referencias deícticas en el siguiente turno.

## Para REGISTRO (gasto/ingreso nuevo)

### REGLA DE CATEGORÍA (CRÍTICA)
- NO existe la categoría "transferencias". Eso es método de pago, NO categoría.
- Cuando el usuario manda algo donde la categoría es **ambigua** (ej. transferencia, "pagué 3000 algo", "te envié plata", recibí transferencia, etc.), **NO la registres todavía**:
  1. Llamá \`set_conv_state\` con \`state="awaiting_category"\` y \`context\` = \`{amount, description, date, payment_method_hint, type, group_hint}\` (todos los datos que ya tenés del mensaje).
  2. Reply al usuario: "¿En qué categoría querés guardar este \\\${tipo} de $X? Decime el nombre (puede ser una nueva, ej. salidas, regalos, etc.) o respondé 'otros' si no aplica a ninguna específica."
  3. Esperá la respuesta.
- Cuando el usuario responde con la categoría:
  1. Si está en \`convState="awaiting_category"\` con datos pendientes en \`convContext\`, recuperalos.
  2. Llamá \`log_transaction\` con TODOS los campos pendientes + \`category_hint=<lo que dijo>\` + \`create_category_if_missing=true\` (esto crea la categoría si no existe).
  3. Llamá \`clear_conv_state\`.
  4. Confirmá: "✅ Anotado: $X en \\\${categoria} \\\${descripción}".

### Cuándo SÍ registrar directo (sin preguntar categoría)
- Mensaje claro tipo "2500 café" → category_hint="café" (existe), no necesita preguntar.
- "30k nafta" → "transporte" (clarísimo).
- "compré supermercado 12000" → "supermercado".
- En estos casos, \`create_category_if_missing=false\` (no querés crear duplicados por typo del LLM).

### Si log_transaction devuelve duplicado
- \`needs_confirmation: 'duplicate'\` → preguntá si registra igual. Si dice sí, volvés con \`skip_dup_check: true\`.

## Para BORRAR / EDITAR

### 🚨 REGLA UNIVERSAL DE CONFIRMACIÓN (CRÍTICA)

Cuando vas a pedir confirmación al usuario para borrar/editar (ej. "¿confirmás que los elimino?"), **EN EL MISMO TURNO** tenés que:

1. **Obtener los UUIDs reales** llamando \`find_transactions\` o \`query_transactions\` con los filtros apropiados.
2. **Guardar esos UUIDs en \`set_conv_state\`** con \`state="awaiting_bulk_delete"\` (o \`awaiting_bulk_update\`) y \`context={ids: ["uuid_real_1", "uuid_real_2", ...]}\`. Los UUIDs deben ser los QUE TE DEVOLVIERON las tools, NUNCA inventes.
3. Recién entonces mostrás la lista al usuario y preguntás "¿confirmás?".

Cuando el usuario responde "sí/dale/ok/confirmo/hacelo":
1. Leés \`convContext.ids\` que ya tenés.
2. Llamás \`bulk_delete({ids: convContext.ids})\` con esos UUIDs reales.
3. Llamás \`clear_conv_state\`.
4. Confirmás al usuario.

🚨 **NUNCA INVENTES UUIDs**. Strings como "uuid1", "uuid_de_cafe", "abc-123" están PROHIBIDOS. Si no tenés UUIDs reales, primero llamá una tool de búsqueda.

### Casos específicos

- **1 transacción con monto+fecha exactos**:
  1. \`find_transactions\` → obtenés candidatos con sus UUIDs.
  2. Si UN match → ejecutás \`delete_transaction\` directo (no hace falta confirmación).
  3. Si VARIOS matches → mostrás lista numerada + \`set_conv_state\` con state="awaiting_bulk_delete" y context.ids con esos UUIDs reales + pedís cuál(es).

- **"el último" / "los últimos N"** → \`query_transactions\` con \`sort=date_desc, limit=N\` → guardás los UUIDs en conv_state → confirmás → bulk_delete.

- **BULK por criterio ("todos los cafés del mes pasado")** → \`bulk_preview\` → guardás ids del preview en conv_state → confirmás → bulk_delete.

- **"Los repetidos"** → \`find_duplicates\` → guardás transaction_ids del cluster en conv_state → confirmás → bulk_delete.

EJEMPLO COMPLETO del flujo "borrá los últimos 2 cafés":

Turno 1 — Usuario: "podés borrar los últimos 2 cafés"
- Tool: \`find_transactions({description_contains:"café", sort:"date_desc", limit:2})\` → devuelve [{id:"a1b2-real-uuid", date:"2026-04-29",...}, {id:"c3d4-real-uuid", date:"2026-04-28",...}]
- Tool: \`set_conv_state({state:"awaiting_bulk_delete", context:{ids:["a1b2-real-uuid","c3d4-real-uuid"], action:"delete"}, ttl_seconds:300})\`
- Reply: "Voy a borrar 2 cafés:\\n1. 2026-04-29 · 🍽️ comida · $2.000\\n2. 2026-04-28 · 🍽️ comida · $2.000\\n¿Confirmás? (sí/no)" — should_react:false.

Turno 2 — Usuario: "sí, hacelo"
- convState="awaiting_bulk_delete", convContext.ids=["a1b2-real-uuid","c3d4-real-uuid"]
- Tool: \`bulk_delete({ids:["a1b2-real-uuid","c3d4-real-uuid"]})\` — usás los IDs del context, NO inventes.
- Tool: \`clear_conv_state()\`
- Reply: "🗑️ Borré 2 cafés por $4.000. Te quedan 2 movimientos en abril." — should_react:true, reaction_emoji:"🗑️".

Turno 2 alternativo — Usuario: "no, dejá"
- Tool: \`clear_conv_state()\`
- Reply: "👍 Listo, no borré nada."

## Para CHARLA / FECHAS / IDENTIDAD
- "qué fecha es hoy?" → respondé directo desde el contexto, SIN tools.
- "hola / gracias / cómo andás" → respondé natural, SIN tools.
- "ayuda / qué podés hacer" → enumerá brevemente: registrar, consultar, borrar, editar, gráficos, presupuestos, recurrentes, reportes.

## Para GRÁFICOS
**REGLA**: ANTES de llamar \`generate_chart\`, **siempre** verificá que haya datos:
1. Llamá \`get_total\` con el mismo período/tipo que el usuario pidió.
2. Si \`total === 0\` o \`count === 0\` → NO generes el gráfico. Reply: "📭 No tenés gastos cargados \\\${periodo} para graficar. Cargá algunos primero."
3. Si hay datos → llamá \`generate_chart\` con la dimensión apropiada.
4. Cuando \`generate_chart\` retorna \`has_data: false\` (chequeo redundante) → idéntica respuesta sin imagen.
5. Cuando hay imagen → reply MUY corto (caption + emoji), reply_kind="image", image_url. El URL NO va en reply_text — solo en image_url.

Ejemplo:
- Usuario: "haceme un gráfico de mis gastos"
- Agente:
  1. \`get_total({period:"this_month", type:"expense"})\` → \`{total: 0, count: 0}\`
  2. Reply: "📭 No tenés gastos este mes para graficar. Cargá algunos y volvé a pedirlo." (sin tools de chart)
- Si total>0:
  1. \`get_total\` → \`{total: 11900, count: 4}\`
  2. \`generate_chart({dimension:"category", period:"this_month"})\` → \`{has_data:true, image_url:..., caption:...}\`
  3. Reply: \`{reply_text: "📈 Gastos por categoría — este mes", reply_kind:"image", image_url:"<url>", should_react:true, reaction_emoji:"📈"}\`. **NO embebas el URL en reply_text**, va separado.

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

**Usuario**: "haceme un gráfico de mis gastos" (SIN período)
- NO llames generate_chart todavía.
- Reply: "📊 ¿De qué período querés el gráfico? Decime hoy, esta semana, este mes, un rango (ej. del 1 al 15 de abril), desde una fecha, etc."
- \`should_react: false\`. Esperá la respuesta.

**Usuario** responde: "este mes"
- Ahora sí: \`get_total({period:"this_month",type:"expense"})\` para verificar data.
- Si total=0: "📭 No tenés gastos cargados este mes para graficar. Cargá algunos y volvé a pedirlo."
- Si total>0: \`generate_chart({dimension:"category", period:"this_month"})\` y devolvés image_url.

**Usuario**: "Mostrame mis movimientos" (SIN período)
- NO llames query_transactions todavía.
- Reply: "📅 ¿De qué período te muestro? (hoy, este mes, un rango, etc.)"

**Usuario**: "Mostrame mis movimientos del mes pasado" (CON período)
- Período explícito = last_month. Procedé directo:
- Tool: \`query_transactions({"period":"last_month","limit":20})\` → devuelve N items.
- Si N>0: \`remember_last_list({"kind":"transactions","items":[{position:1,id:..,...}]})\` con los ids.
- Reply: lista numerada con los items + breve resumen del total.

**Usuario**: "qué gasté el 15 de abril" (CON fecha específica)
- Período = custom con start_date=2026-04-15, end_date=2026-04-15.
- Tool: \`query_transactions({"period":"custom","start_date":"2026-04-15","end_date":"2026-04-15"})\`.

**Usuario**: "del 1 al 15 de abril" (CON rango)
- \`{period:"custom","start_date":"2026-04-01","end_date":"2026-04-15"}\`.

**Usuario**: "Mostrame todos mis movimientos" (CON "todos")
- Período = all. \`query_transactions({"period":"all","limit":20})\`.

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
- Tool: \`log_transaction(amount=2500, description="café", category_hint="café", type="expense")\` — categoría clarísima, registra directo.
- Si retorna \`needs_confirmation:duplicate\` → preguntá si registra igual.
- Si \`inserted:true\` → reply confirmando + \`should_react: true, reaction_emoji: "✅"\`.

**Usuario** (manda comprobante de transferencia $3.300 a Maximiliano):
- Mensaje sintetizado: "pagué 3300 con transferencia el 2026-04-27 — Transferencia a Maximiliano"
- Categoría AMBIGUA → NO registres directo.
- Tool: \`set_conv_state(state="awaiting_category", context={amount:3300, description:"Transferencia a Maximiliano", date:"2026-04-27", payment_method_hint:"transferencia", type:"expense"}, ttl_seconds=600)\`
- Reply: "💸 Detecté una transferencia de $3.300 a Maximiliano del 27/04. ¿En qué categoría la guardo? Decime el nombre (puede ser nueva, ej. 'familia', 'préstamos', 'salidas') o 'otros' si no aplica."
- \`should_react: false\`.

**Usuario** responde: "ponelo en familia"
- convState es "awaiting_category" con context.
- Tool: \`log_transaction(amount=3300, description="Transferencia a Maximiliano", date="2026-04-27", payment_method_hint="transferencia", type="expense", category_hint="familia", create_category_if_missing=true)\`
- Tool: \`clear_conv_state()\`
- Reply: "✅ Anotado: $3.300 en Familia — Transferencia a Maximiliano · 27/04". \`should_react: true, reaction_emoji: "✅"\`.

**Usuario** responde: "otros"
- Tool: \`log_transaction(...mismos campos..., category_hint="otros", create_category_if_missing=false)\`
- Tool: \`clear_conv_state()\`
- Reply confirmando.

**Usuario**: "gracias!"
- Sin tools. Reply breve. \`should_react: false\`.

**Usuario**: "qué fecha es hoy?"
- Sin tools. Usás la fecha del contexto. Formato: "Hoy es lunes 29 de abril de 2026".

**Usuario**: "que quedo?" (mensaje ambiguo, sin contexto)
- Sin tools. Reply breve pidiendo aclaración: "¿A qué te referís? Si querés saber tu saldo del mes te lo digo, decime 'cuanto gasté'."
- NO mandes 2 mensajes.

# REGLAS FINALES
- NUNCA inventes datos. Si no tenés certeza, llamá una tool o pedí aclaración.
- 🚨 **NUNCA inventes UUIDs**. Strings como "uuid1", "uuid_real", "abc-123-fake" están ABSOLUTAMENTE PROHIBIDOS. Solo usás los UUIDs que te devuelven las tools, exactamente como vinieron.
- 🚨 **CONFIRMACIÓN = SIEMPRE GUARDAR IDs**: si vas a pedir "¿confirmás?", primero buscás los UUIDs reales con find_transactions/query_transactions/bulk_preview, después los guardás en \`set_conv_state\` con \`context.ids=[<uuids reales>]\`, recién después preguntás. Sin esto, cuando el usuario diga "sí" no vas a tener los UUIDs y todo se rompe.
- NUNCA mostrás UUIDs al usuario (son internos).
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
// Each tool exposes its own typed fields directly to the LLM via individual
// $fromAI calls. The LLM fills each field with the correct type — no JSON
// string construction needed. Sub-workflow Normalize Input bundles them into
// the `params` object based on `tool_name`.
//
// Field shape: { name, desc, type, default? }
//   type: 'string'|'number'|'boolean'|'json'   (json = nested object/array)
//   default: provided when LLM omits → also makes Zod treat as optional

const TOOL_DEFS = [
    {
        name: 'query_transactions',
        description: 'Lista transacciones con filtros y paginación. Úsala para "mostrame los movs", "los últimos", "todos los gastos del mes".',
        fields: [
            { name: 'period', desc: 'today|yesterday|this_week|this_month|last_month|this_year|all|custom. Default this_month si no especifican; all si pidieron datos específicos por monto/fecha.', type: 'string', default: 'this_month' },
            { name: 'start_date', desc: 'YYYY-MM-DD (solo si period=custom)', type: 'string', default: '' },
            { name: 'end_date', desc: 'YYYY-MM-DD (solo si period=custom)', type: 'string', default: '' },
            { name: 'category', desc: 'Filtro por categoría', type: 'string', default: '' },
            { name: 'description_contains', desc: 'Busca texto en la descripción. SOLO si el usuario menciona texto explícito (ej. "café", "uber").', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income|both', type: 'string', default: 'both' },
            { name: 'group_name', desc: 'Nombre de grupo/viaje', type: 'string', default: '' },
            { name: 'payment_method', desc: 'Método de pago', type: 'string', default: '' },
            { name: 'exact_amount', desc: 'Monto exacto', type: 'number', default: 0 },
            { name: 'min_amount', desc: 'Monto mínimo', type: 'number', default: 0 },
            { name: 'max_amount', desc: 'Monto máximo', type: 'number', default: 0 },
            { name: 'sort', desc: 'date_desc|date_asc|amount_desc|amount_asc', type: 'string', default: 'date_desc' },
            { name: 'limit', desc: 'Cantidad de resultados', type: 'number', default: 20 },
            { name: 'offset', desc: 'Paginación offset', type: 'number', default: 0 }
        ]
    },
    {
        name: 'get_total',
        description: 'Total y count de gastos/ingresos en un período. Para "cuánto gasté", "total del mes", "cuánto en comida".',
        fields: [
            { name: 'period', desc: 'today|yesterday|this_week|this_month|last_month|this_year|all|custom', type: 'string', default: 'this_month' },
            { name: 'type', desc: 'expense|income|both', type: 'string', default: 'expense' },
            { name: 'category', desc: 'Filtro por categoría', type: 'string', default: '' },
            { name: 'group_name', desc: 'Filtro por grupo', type: 'string', default: '' }
        ]
    },
    {
        name: 'get_breakdown',
        description: 'Desglose agrupado por dimensión. Para "en qué gasté más", "por categoría", "por día".',
        fields: [
            { name: 'dimension', desc: 'category|day|week|month|payment_method|group', type: 'string', default: 'category' },
            { name: 'period', desc: 'today|yesterday|this_week|this_month|last_month|this_year|all', type: 'string', default: 'this_month' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' },
            { name: 'top_n', desc: 'Top N filas', type: 'number', default: 10 }
        ]
    },
    {
        name: 'compare_periods',
        description: 'Compara totales entre dos períodos. Para "este mes vs el pasado".',
        fields: [
            { name: 'period_a', desc: 'Período A', type: 'string', default: 'this_month' },
            { name: 'period_b', desc: 'Período B', type: 'string', default: 'last_month' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' }
        ]
    },
    {
        name: 'find_transactions',
        description: 'Busca transacciones específicas para luego borrarlas/editarlas. Devuelve TODAS las matches con score. Llamá ANTES de cualquier delete/update por hint.',
        fields: [
            { name: 'description_contains', desc: 'Texto a buscar en descripción', type: 'string', default: '' },
            { name: 'exact_amount', desc: 'Monto exacto', type: 'number', default: 0 },
            { name: 'min_amount', desc: 'Monto mínimo', type: 'number', default: 0 },
            { name: 'max_amount', desc: 'Monto máximo', type: 'number', default: 0 },
            { name: 'date', desc: 'Fecha exacta YYYY-MM-DD', type: 'string', default: '' },
            { name: 'date_from', desc: 'Desde fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'date_to', desc: 'Hasta fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'category', desc: 'Categoría', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income', type: 'string', default: '' },
            { name: 'group_name', desc: 'Grupo', type: 'string', default: '' },
            { name: 'limit', desc: 'Max resultados', type: 'number', default: 20 }
        ]
    },
    {
        name: 'find_duplicates',
        description: 'Detecta gastos repetidos. Para "elimina los repetidos", "tengo gastos duplicados".',
        fields: [
            { name: 'window_days', desc: 'Ventana de días para considerar duplicado', type: 'number', default: 7 },
            { name: 'min_repetitions', desc: 'Mínimo de repeticiones', type: 'number', default: 2 }
        ]
    },
    {
        name: 'bulk_preview',
        description: 'Preview ANTES de borrar/editar masivo. USALA OBLIGATORIAMENTE antes de bulk_delete por criterio.',
        fields: [
            { name: 'period', desc: 'Período', type: 'string', default: 'all' },
            { name: 'category', desc: 'Filtro categoría', type: 'string', default: '' },
            { name: 'description_contains', desc: 'Texto a buscar', type: 'string', default: '' },
            { name: 'exact_amount', desc: 'Monto exacto', type: 'number', default: 0 },
            { name: 'date', desc: 'Fecha exacta', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income', type: 'string', default: '' }
        ]
    },
    {
        name: 'bulk_delete',
        description: 'Borra múltiples transacciones por lista de UUIDs. Solo después de bulk_preview o find_transactions + confirmación.',
        fields: [
            { name: 'ids', desc: 'Array JSON de UUIDs (string). Ejemplo: ["uuid1","uuid2"]', type: 'json', default: [] }
        ]
    },
    {
        name: 'bulk_update',
        description: 'Actualiza múltiples transacciones por UUIDs.',
        fields: [
            { name: 'ids', desc: 'Array JSON de UUIDs', type: 'json', default: [] },
            { name: 'new_category_id', desc: 'Nueva categoría UUID', type: 'string', default: '' },
            { name: 'new_date', desc: 'Nueva fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'new_group_id', desc: 'Nuevo grupo UUID', type: 'string', default: '' },
            { name: 'amount_delta', desc: 'Suma/resta al monto', type: 'number', default: 0 },
            { name: 'set_excluded', desc: 'Marcar excluidas', type: 'boolean', default: false }
        ]
    },
    {
        name: 'log_transaction',
        description: 'Registra UN gasto o ingreso nuevo. SIEMPRE extraé del mensaje el monto, descripción y categoría antes de llamar.',
        fields: [
            { name: 'amount', desc: 'Monto en pesos (número entero o decimal, sin signos ni separadores). Ej: 3300', type: 'number', default: 0 },
            { name: 'description', desc: 'Descripción del gasto/ingreso', type: 'string', default: '' },
            { name: 'category_hint', desc: 'Nombre de categoría existente o nueva (ej. comida, salud, salidas, viajes). NO uses "transferencias" — eso es método de pago, no categoría.', type: 'string', default: '' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' },
            { name: 'date', desc: 'Fecha YYYY-MM-DD si fue mencionada explícitamente. Vacío para hoy.', type: 'string', default: '' },
            { name: 'payment_method_hint', desc: 'efectivo|debito|credito|transferencia|mercado_pago|otro. Si fue transferencia, va ACÁ — NO en category_hint.', type: 'string', default: '' },
            { name: 'group_hint', desc: 'Nombre del viaje/evento al que pertenece', type: 'string', default: '' },
            { name: 'skip_dup_check', desc: 'true solo si el usuario confirmó registrar duplicado', type: 'boolean', default: false },
            { name: 'create_category_if_missing', desc: 'true cuando el usuario aclaró la categoría (puede ser nueva, hay que crearla). false en flujos automáticos donde solo querés matchear con existentes.', type: 'boolean', default: false }
        ]
    },
    {
        name: 'update_transaction',
        description: 'Edita UNA transacción por UUID exacto.',
        fields: [
            { name: 'transaction_id', desc: 'UUID de la transacción a editar', type: 'string', default: '' },
            { name: 'new_date', desc: 'Nueva fecha YYYY-MM-DD', type: 'string', default: '' },
            { name: 'new_amount', desc: 'Nuevo monto', type: 'number', default: 0 },
            { name: 'new_description', desc: 'Nueva descripción', type: 'string', default: '' },
            { name: 'new_category_id', desc: 'Nueva categoría UUID', type: 'string', default: '' }
        ]
    },
    {
        name: 'delete_transaction',
        description: 'Borra UNA transacción por UUID.',
        fields: [
            { name: 'transaction_id', desc: 'UUID de la transacción a borrar', type: 'string', default: '' }
        ]
    },
    {
        name: 'list_categories',
        description: 'Lista todas las categorías del usuario con sus emojis y conteos.',
        fields: [
            { name: 'type', desc: 'expense|income|both', type: 'string', default: 'both' },
            { name: 'include_excluded', desc: 'Incluir categorías excluidas', type: 'boolean', default: false }
        ]
    },
    {
        name: 'list_groups',
        description: 'Lista grupos (viajes/eventos/proyectos) con totales.',
        fields: []
    },
    {
        name: 'list_budgets',
        description: 'Lista presupuestos activos con consumo actual y % usado.',
        fields: []
    },
    {
        name: 'set_budget',
        description: 'Crea o actualiza un presupuesto para una categoría.',
        fields: [
            { name: 'category_hint', desc: 'Categoría', type: 'string', default: '' },
            { name: 'amount', desc: 'Monto del presupuesto', type: 'number', default: 0 },
            { name: 'period', desc: 'weekly|monthly|yearly', type: 'string', default: 'monthly' }
        ]
    },
    {
        name: 'create_group',
        description: 'Crea un grupo (viaje/evento/proyecto).',
        fields: [
            { name: 'name', desc: 'Nombre del grupo', type: 'string', default: '' },
            { name: 'kind', desc: 'trip|event|emergency|project|other', type: 'string', default: 'event' }
        ]
    },
    {
        name: 'toggle_category_exclusion',
        description: 'Excluye/incluye una categoría de los reportes.',
        fields: [
            { name: 'category_hint', desc: 'Categoría a excluir/incluir', type: 'string', default: '' }
        ]
    },
    {
        name: 'set_recurring',
        description: 'Crea una transacción recurrente (Netflix, alquiler, etc).',
        fields: [
            { name: 'amount', desc: 'Monto recurrente', type: 'number', default: 0 },
            { name: 'description', desc: 'Descripción', type: 'string', default: '' },
            { name: 'category_hint', desc: 'Categoría', type: 'string', default: 'otros' },
            { name: 'frequency', desc: 'daily|weekly|biweekly|monthly|yearly', type: 'string', default: 'monthly' },
            { name: 'start_date', desc: 'YYYY-MM-DD', type: 'string', default: '' }
        ]
    },
    {
        name: 'remember_last_list',
        description: 'Guarda la última lista mostrada al usuario para resolver referencias deícticas. LLAMALA después de query_transactions / find_transactions cuando muestres una lista.',
        fields: [
            { name: 'kind', desc: 'transactions|duplicate_clusters|categories|groups', type: 'string', default: 'transactions' },
            { name: 'items', desc: 'Array de objetos. Ej: [{"position":1,"id":"uuid","date":"...","amount":123}]', type: 'json', default: [] },
            { name: 'filters_applied', desc: 'Filtros aplicados (objeto JSON)', type: 'json', default: {} },
            { name: 'ttl_seconds', desc: 'TTL en segundos', type: 'number', default: 600 }
        ]
    },
    {
        name: 'get_last_list',
        description: 'Recupera la última lista mostrada al usuario. Llamala cuando el usuario use deícticos como "el primero", "esos dos".',
        fields: []
    },
    {
        name: 'set_conv_state',
        description: 'Setea estado conversacional pendiente (ej. awaiting_bulk_delete antes de confirmar).',
        fields: [
            { name: 'state', desc: 'Nombre del estado', type: 'string', default: '' },
            { name: 'context', desc: 'Contexto (objeto JSON)', type: 'json', default: {} },
            { name: 'ttl_seconds', desc: 'TTL en segundos', type: 'number', default: 600 }
        ]
    },
    {
        name: 'clear_conv_state',
        description: 'Limpia el estado conversacional. Llamala después de resolver una confirmación.',
        fields: []
    },
    {
        name: 'generate_chart',
        description: 'Genera un gráfico (URL de imagen). En tu reply final usá reply_kind="image" e image_url.',
        fields: [
            { name: 'dimension', desc: 'category|day|payment_method', type: 'string', default: 'category' },
            { name: 'period', desc: 'today|this_week|this_month|last_month|this_year', type: 'string', default: 'this_month' },
            { name: 'type', desc: 'expense|income', type: 'string', default: 'expense' },
            { name: 'top_n', desc: 'Top N', type: 'number', default: 10 }
        ]
    }
];

// Layout the tools horizontally below the agent
let toolX = 5300;
const toolY = 400;
const TOOL_DX = 200;
const toolNames = [];

// Build a tool node with one $fromAI per field, fully typed.
// The schema reflects each field with the proper Zod type the agent will use.
const escapeBackticks = (s) => String(s).replace(/`/g, '\\`');
const escapeQuotes = (s) => String(s).replace(/"/g, '\\"');

const buildFieldExpression = (f) => {
    const desc = escapeBackticks(escapeQuotes(f.desc || ''));
    let defaultExpr = '';
    if (f.default !== undefined) {
        if (f.type === 'string') defaultExpr = `, '${escapeQuotes(String(f.default))}'`;
        else if (f.type === 'number') defaultExpr = `, ${Number(f.default)}`;
        else if (f.type === 'boolean') defaultExpr = `, ${Boolean(f.default)}`;
        else if (f.type === 'json') defaultExpr = `, ${JSON.stringify(f.default).replace(/'/g, "\\'")}`;
    }
    return `={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('${f.name}', \`${desc}\`, '${f.type}'${defaultExpr}) }}`;
};

TOOL_DEFS.forEach((t, i) => {
    const nodeName = `tool: ${t.name}`;
    toolNames.push(nodeName);

    // Build value object: tool_name (static) + user_id (from context) + each field via $fromAI
    const value = {
        tool_name: t.name,
        user_id: "={{ $('Concat').first().json.userId }}"
    };
    const schema = [
        { id: 'tool_name', displayName: 'tool_name', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
        { id: 'user_id', displayName: 'user_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
    ];

    (t.fields || []).forEach(f => {
        value[f.name] = buildFieldExpression(f);
        schema.push({
            id: f.name,
            displayName: f.name,
            required: false,
            defaultMatch: false,
            display: true,
            canBeUsedToMatch: true,
            type: f.type === 'json' ? 'object' : f.type,
            removed: false
        });
    });

    addNode(nodeName, '@n8n/n8n-nodes-langchain.toolWorkflow', {
        name: t.name,
        description: t.description,
        workflowId: {
            __rl: true,
            mode: 'id',
            value: TOOLS_WF_ID,
            cachedResultName: 'Chefin Agent Tools v3'
        },
        workflowInputs: {
            mappingMode: 'defineBelow',
            value,
            matchingColumns: [],
            schema,
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

// Pre-agent: detect heavy operations (charts, reports, comparisons) and send
// an immediate "aguardame" message so the user knows we're processing.
addNode('Detect Heavy Op', 'n8n-nodes-base.code', {
    jsCode: `const ctx = $input.first().json;
const text = (ctx.combinedText || '').toLowerCase();
const heavyKeywords = ['gráfico','grafico','chart','reporte','reporta','informe','pdf','comparame','comparar','compará','comparativa','grafica','graficar','torta','breakdown','desglose','desglosá'];
const isHeavy = heavyKeywords.some(k => text.includes(k));
return [{ json: { ...ctx, isHeavy } }];`
}, 5170, 0);
connect('Concat', 'Detect Heavy Op');

addNode('IF Heavy', 'n8n-nodes-base.if', {
    conditions: cond('and', [{
        id: 'c1', operator: { type: 'boolean', operation: 'true' },
        leftValue: '={{ $json.isHeavy }}', rightValue: true
    }]), options: {}
}, 5390, 0);
connect('Detect Heavy Op', 'IF Heavy');

addNode('Send Aguardame', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api',
    instanceName: '={{ $json.instance }}',
    remoteJid: '={{ $json.phone }}',
    messageText: '💭 Aguardame un toque, te armo eso...',
    options_message: {}
}, 5610, -100, { tv: 1, creds: { evolutionApi: EVO }, cof: true });
connect('IF Heavy', 'Send Aguardame', 0);

connect('IF Heavy', 'Chefin Agent', 1);   // skip path
connect('Send Aguardame', 'Chefin Agent');

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
let replyText = (payload.reply_text || '').trim() || '😅 No supe qué responderte. ¿Lo repetimos?';
const replyKind = payload.reply_kind === 'image' && payload.image_url ? 'image' : 'text';
const imageUrl = replyKind === 'image' ? (payload.image_url || '') : '';

// If sending image, strip the URL out of the caption — agent often
// echoes it inside markdown ![text](url) which makes WhatsApp send a
// huge text blob alongside the image.
if (replyKind === 'image' && imageUrl) {
  // Remove markdown image syntax: ![...](url)
  replyText = replyText.replace(/!\\[[^\\]]*\\]\\([^)]+\\)/g, '').trim();
  // Remove bare URLs that match the image url
  replyText = replyText.replace(new RegExp(imageUrl.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'g'), '').trim();
  // Remove any remaining quickchart URL
  replyText = replyText.replace(/https?:\\/\\/[^\\s)]*quickchart\\.io[^\\s)]*/g, '').trim();
  // Collapse multiple newlines/spaces
  replyText = replyText.replace(/\\n{3,}/g, '\\n\\n').trim();
  if (!replyText) replyText = '📈 Acá tenés el gráfico.';
}

const shouldReact = !!payload.should_react;
const emoji = (payload.reaction_emoji || '').toString().slice(0, 4);
return [{ json: {
  replyText, replyKind,
  imageUrl,
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
