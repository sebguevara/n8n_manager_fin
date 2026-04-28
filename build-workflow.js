// Builds the complete expense-bot workflow JSON for n8n.
// Run with: node build-workflow.js > expense-bot-workflow-v2.json

const PG = { id: 'f8CCpjEZRkcHEaJI', name: 'Postgres account' };
const REDIS = { id: 'igDqU9rqRBlmVQGc', name: 'Redis account' };
const OPENAI = { id: '0ErbOR5W4QIYaohV', name: 'OpenAI account' };
const EVO_KEY = 'ddc0c55de962f185e21f5bb18e1233b1f443417772e1f4c16c8a630bf902fcef';

let yPos = 0, idCounter = 1;
const newId = () => `n${(idCounter++).toString().padStart(3,'0')}`;

const nodes = [];
const connections = {};

const addNode = (name, type, params, x, y, extras = {}) => {
    nodes.push({ parameters: params, id: newId(), name, type, typeVersion: extras.tv || 2, position: [x, y], ...(extras.creds && { credentials: extras.creds }), ...(extras.cof && { continueOnFail: true }), ...(extras.always && { alwaysOutputData: true }), ...(extras.webhookId && { webhookId: extras.webhookId }) });
    return name;
};
const connect = (from, to, fromIdx = 0) => {
    if (!connections[from]) connections[from] = { main: [] };
    while (connections[from].main.length <= fromIdx) connections[from].main.push([]);
    connections[from].main[fromIdx].push({ node: to, type: 'main', index: 0 });
};
const conditions = (combinator, conds) => ({ options: { caseSensitive: true, typeValidation: 'strict', version: 1 }, combinator, conditions: conds });
const eq = (id, lv, rv, type='string') => ({ id, operator: { type, operation: 'equals' }, leftValue: lv, rightValue: rv });

// ============ FLOW ============

addNode('Webhook', 'n8n-nodes-base.webhook', { httpMethod: 'POST', path: 'expense-bot', options: {} }, 0, 0, { tv: 2, webhookId: '6fb86469-89fb-4f18-89e4-ba1b46bbf120' });

addNode('IF Valid Inbound', 'n8n-nodes-base.if', {
    conditions: conditions('and', [
        eq('c1', '={{ $json.body.event }}', 'messages.upsert'),
        { id: 'c2', operator: { type: 'boolean', operation: 'false' }, leftValue: '={{ $json.body.data.key.fromMe }}', rightValue: false }
    ]),
    options: {}
}, 220, 0, { tv: 2 });
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
    conditions: conditions('and', [
        { id: 'c1', operator: { type: 'boolean', operation: 'true' },
          leftValue: "={{ ($env.ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(p => p).includes($json.phone) }}",
          rightValue: true }
    ]), options: {}
}, 660, 0, { tv: 2 });
connect('Extract Fields', 'IF Allowed Phone');

// Switch Media Type
addNode('Switch Media Type', 'n8n-nodes-base.switch', {
    rules: { values: [
        { conditions: conditions('and', [eq('r1','={{ $json.messageType }}','imageMessage')]), renameOutput: true, outputKey: 'image' },
        { conditions: conditions('and', [eq('r2','={{ $json.messageType }}','audioMessage')]), renameOutput: true, outputKey: 'audio' },
        { conditions: conditions('and', [eq('r3','={{ $json.messageType }}','documentMessage')]), renameOutput: true, outputKey: 'document' }
    ] }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'text' }
}, 880, 0, { tv: 3 });
connect('IF Allowed Phone', 'Switch Media Type');

// IMAGE branch — HTTP directo (community node no tiene download)
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
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'openAiApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: `={\n  "model": "gpt-4o-mini",\n  "response_format": {"type":"json_object"},\n  "temperature": 0.1, "max_tokens": 1500,\n  "messages": [\n    {"role":"system","content":"Sos un experto leyendo tickets argentinos. Devolvé JSON con: {is_receipt:bool, merchant, amount(número), currency:'ARS', transaction_date_iso, payment_method_hint, category_hint, description, confidence(0-1), human_reply}. Si no es un comprobante, is_receipt=false. amount=TOTAL final."},\n    {"role":"user","content":[\n      {"type":"text","text":"Caption: {{ $('Extract Fields').first().json.caption || '(ninguno)' }}"},\n      {"type":"image_url","image_url":{"url":"data:{{ $json.mimetype || 'image/jpeg' }};base64,{{ $json.base64 }}"}}\n    ]}\n  ]\n}`, options: {}
}, 1320, -200, { tv: 4.2, creds: { openAiApi: OPENAI } });
connect('Download Image', 'Vision OCR');

addNode('Receipt to Text', 'n8n-nodes-base.code', {
    jsCode: `const resp = $input.first().json;\nconst ctx = $('Extract Fields').first().json;\nlet payload;\ntry { payload = JSON.parse(resp.choices?.[0]?.message?.content || '{}'); } catch(e) { payload = {is_receipt:false,human_reply:'No pude leer el comprobante.'}; }\nlet syntheticText;\nif (payload.is_receipt && Number(payload.amount) > 0) {\n  // Format that AI Classify reliably maps to log_expense\n  const dateOnly = payload.transaction_date_iso ? String(payload.transaction_date_iso).slice(0,10) : '';\n  const desc = payload.description || (payload.merchant ? 'pago a ' + payload.merchant : 'comprobante');\n  const parts = ['pagué', String(payload.amount), 'de', payload.category_hint || 'otros'];\n  if (payload.payment_method_hint) parts.push('con', payload.payment_method_hint);\n  if (dateOnly) parts.push('el', dateOnly);\n  parts.push('—', desc);\n  syntheticText = parts.join(' ');\n} else {\n  syntheticText = payload.human_reply || 'No pude leer el comprobante.';\n}\nreturn [{ json: { text: syntheticText, phone: ctx.phone, remoteJid: ctx.remoteJid, instance: ctx.instance, messageId: ctx.messageId, pushName: ctx.pushName, receipt_data: payload } }];`
}, 1540, -200);
connect('Vision OCR', 'Receipt to Text');

// AUDIO branch — HTTP directo
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
    jsCode: `const item=$input.first().json;\nconst ctx=$('Extract Fields').first().json;\nconst b64=item.base64||'';\nif(!b64) throw new Error('Empty audio base64');\nconst buf=Buffer.from(b64,'base64');\nconst bin=await this.helpers.prepareBinaryData(buf,'audio.ogg',item.mimetype||'audio/ogg');\nreturn [{ json:{phone:ctx.phone,remoteJid:ctx.remoteJid,instance:ctx.instance,messageId:ctx.messageId,pushName:ctx.pushName}, binary:{data:bin} }];`
}, 1320, 0);
connect('Download Audio', 'Audio to Binary');

addNode('Whisper Transcribe', '@n8n/n8n-nodes-langchain.openAi', {
    resource: 'audio', operation: 'transcribe', options: { language: 'es' }
}, 1540, 0, { tv: 1.8, creds: { openAiApi: OPENAI } });
connect('Audio to Binary', 'Whisper Transcribe');

// DOCUMENT (PDF) branch — HTTP directo
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
    jsCode: `const item=$input.first().json;\nconst ctx=$('Extract Fields').first().json;\nconst b64=item.base64||'';\nif(!b64) throw new Error('Empty PDF base64');\nconst buf=Buffer.from(b64,'base64');\nconst bin=await this.helpers.prepareBinaryData(buf,'document.pdf','application/pdf');\nreturn [{ json:{phone:ctx.phone,remoteJid:ctx.remoteJid,instance:ctx.instance,messageId:ctx.messageId,pushName:ctx.pushName}, binary:{data:bin} }];`
}, 1320, 200);
connect('Download PDF', 'PDF to Binary');

addNode('Extract PDF Text', 'n8n-nodes-base.extractFromFile', {
    operation: 'pdf', binaryPropertyName: 'data', options: {}
}, 1540, 200, { tv: 1 });
connect('PDF to Binary', 'Extract PDF Text');

addNode('AI Extract Expenses', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'openAiApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json',
    jsonBody: `={\n  "model": "gpt-4o-mini",\n  "response_format": {"type":"json_object"},\n  "temperature": 0.1,\n  "max_tokens": 4000,\n  "messages": [\n    {"role":"system","content":{{ JSON.stringify("Extraés gastos individuales de PDFs (extractos bancarios, resúmenes de tarjeta, facturas, comprobantes de transferencia, etc.).\\n\\nDevolvé JSON con esta forma exacta:\\n{\\"expenses\\":[{\\"amount\\":number,\\"description\\":string,\\"category_hint\\":string,\\"transaction_date_iso\\":\\"YYYY-MM-DD\\"|null,\\"payment_method_hint\\":string,\\"merchant\\":string}],\\"summary\\":\\"tipo de doc, período y total en una línea\\"}\\n\\nReglas:\\n- Solo egresos (gastos/transferencias salientes/pagos). NO incluyas ingresos a menos que esté explícito.\\n- amount: número entero/decimal sin signos ni separadores. \\\"$ 3.300,00\\\" → 3300. \\\"15.000,50\\\" → 15000.50.\\n- Categorías permitidas: comida, supermercado, transporte, nafta, farmacia, servicios, entretenimiento, ropa, salud, educacion, hogar, viajes, regalos, mascotas, tecnologia, deportes, transferencias, otros.\\n- Para fechas DD/MM/AAAA o DD/MMM/AAAA convertí a YYYY-MM-DD. Para meses en español (ENE, FEB, MAR, ABR, MAY, JUN, JUL, AGO, SEP, OCT, NOV, DIC) usá los números correspondientes.\\n- Si una transacción tiene categoría explícita en el PDF (ej: \\\"Categoría: Transferencias\\\"), respetala mapeando a la lista permitida.\\n- payment_method_hint: efectivo|debito|credito|transferencia|mercado_pago|otro.\\n- Si NO podés leer un dato con certeza, omití esa transacción entera (NO inventes).\\n- Máximo 50 transacciones por respuesta. Si el PDF tiene más, priorizá las primeras.\\n- Si el PDF es UNA SOLA transferencia/pago, devolvé un array con UN solo elemento.\\n- summary: una línea, ej: \\\"Transferencia individual del 27/04/2026 — $3.300\\\" o \\\"Resumen tarjeta abril 2026 — 23 mov, $145.300\\\".\\n- Si el PDF no contiene gastos identificables, devolvé {\\"expenses\\":[],\\"summary\\":\\"explicación corta\\"}.\\n\\nDevolvé SOLO el JSON, sin markdown, sin texto adicional.") }}},\n    {"role":"user","content":{{ JSON.stringify("Texto del PDF a procesar:\\n\\n" + ($json.text || '').slice(0, 12000)) }}}\n  ]\n}`,
    options: {}
}, 1760, 200, { tv: 4.2, creds: { openAiApi: OPENAI } });
connect('Extract PDF Text', 'AI Extract Expenses');

addNode('Parse PDF Result', 'n8n-nodes-base.code', {
    jsCode: `const resp=$input.first().json;const ctx=$('Extract Fields').first().json;\nlet payload;\ntry{payload=JSON.parse(resp.choices?.[0]?.message?.content||'{}');}catch(e){payload={expenses:[],summary:'No pude leer el PDF.'};}\nconst expenses=Array.isArray(payload.expenses)?payload.expenses:[];\nconst total=expenses.reduce((s,e)=>s+Number(e.amount||0),0);\nconst fmt=n=>Number(n||0).toLocaleString('es-AR');\nlet preview='';\nif(expenses.length){\n  preview='\\n\\nPrimeros movimientos:\\n'+expenses.slice(0,5).map(e=>\`• $\${fmt(e.amount)} \${e.category_hint||''} \${e.description||e.merchant||''} \${e.transaction_date_iso||''}\`).join('\\n');\n  if(expenses.length>5) preview+=\`\\n... y \${expenses.length-5} más.\`;\n}\n// synthesize text for the rest of the flow\nconst syntheticText=\`__pdf_import__\${expenses.length}\`;\nreturn [{ json:{ text:syntheticText, phone:ctx.phone, remoteJid:ctx.remoteJid, instance:ctx.instance, messageId:ctx.messageId, pushName:ctx.pushName, pdf_data:{expenses, summary:payload.summary||'', total, preview} }}];`
}, 1980, 200);
connect('AI Extract Expenses', 'Parse PDF Result');

// TEXT / unified entry
addNode('Pass Text', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'a1', name: 'text', type: 'string', value: '={{ $json.text }}' },
        { id: 'a2', name: 'phone', type: 'string', value: "={{ $('Extract Fields').first().json.phone }}" },
        { id: 'a3', name: 'remoteJid', type: 'string', value: "={{ $('Extract Fields').first().json.remoteJid }}" },
        { id: 'a4', name: 'instance', type: 'string', value: "={{ $('Extract Fields').first().json.instance }}" },
        { id: 'a5', name: 'messageId', type: 'string', value: "={{ $('Extract Fields').first().json.messageId }}" },
        { id: 'a6', name: 'pushName', type: 'string', value: "={{ $('Extract Fields').first().json.pushName }}" }
    ] }, options: {}
}, 1760, 0, { tv: 3.4 });
connect('Switch Media Type', 'Pass Text', 3);
connect('Whisper Transcribe', 'Pass Text');
connect('Receipt to Text', 'Pass Text');
connect('Parse PDF Result', 'Pass Text');

addNode('Bootstrap User', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT bootstrap_user($1::text, $2::text) AS user_id;',
    options: { queryReplacement: '={{ $json.phone }},={{ $json.pushName }}' }
}, 1980, 0, { tv: 2.5, creds: { postgres: PG } });
connect('Pass Text', 'Bootstrap User');

addNode('Get Conv State', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT cs.state AS conv_state, cs.context AS conv_context, u.onboarded FROM users u LEFT JOIN conversation_state cs ON cs.user_id=u.id AND cs.expires_at > NOW() WHERE u.id = $1::uuid;",
    options: { queryReplacement: '={{ $json.user_id }}' }
}, 2200, 0, { tv: 2.5, creds: { postgres: PG }, always: true });
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
        { id: 'cx', name: 'convContext', type: 'object', value: "={{ $json.conv_context || {} }}" },
        { id: 'ob', name: 'onboarded', type: 'boolean', value: "={{ $json.onboarded === true }}" }
    ] }, options: {}
}, 2420, 0, { tv: 3.4 });
connect('Get Conv State', 'Merge Ctx');

// Idempotency
addNode('Redis Check', 'n8n-nodes-base.redis', {
    operation: 'get', propertyName: 'alreadyProcessed',
    key: '=processed:{{ $json.messageId }}', options: {}
}, 2640, 0, { tv: 1, creds: { redis: REDIS } });
connect('Merge Ctx', 'Redis Check');

addNode('IF New', 'n8n-nodes-base.if', {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 1 }, combinator: 'and',
        conditions: [{ id: 'c1', operator: { type: 'string', operation: 'empty' }, leftValue: '={{ $json.alreadyProcessed }}', rightValue: '' }] },
    options: {}
}, 2860, 0, { tv: 2 });
connect('Redis Check', 'IF New');

addNode('Mark Processed', 'n8n-nodes-base.redis', {
    operation: 'set', key: '=processed:{{ $json.messageId }}', value: '1', expire: true, ttl: 3600
}, 2860, 200, { tv: 1, creds: { redis: REDIS } });
connect('IF New', 'Mark Processed');

// Buffer + Lock + Wait + Concat
addNode('Buffer Push', 'n8n-nodes-base.redis', {
    operation: 'push', list: "=buffer:{{ $('Merge Ctx').first().json.phone }}",
    messageData: "={{ $('Merge Ctx').first().json.text }}", tail: true
}, 3300, 200, { tv: 1, creds: { redis: REDIS } });
connect('Mark Processed', 'Buffer Push');

addNode('Lock Token', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'lt', name: 'lockToken', type: 'string', value: "={{ $now.toMillis() + '-' + Math.random().toString(36).slice(2,10) }}" },
        { id: 'ph', name: 'phone', type: 'string', value: "={{ $('Merge Ctx').first().json.phone }}" }
    ] }, includeOtherFields: true, options: {}
}, 3520, 200, { tv: 3.4 });
connect('Buffer Push', 'Lock Token');

addNode('Lock Set', 'n8n-nodes-base.redis', {
    operation: 'set', key: '=lock:{{ $json.phone }}', value: '={{ $json.lockToken }}', expire: true, ttl: 30
}, 3740, 200, { tv: 1, creds: { redis: REDIS } });
connect('Lock Token', 'Lock Set');

addNode('Wait', 'n8n-nodes-base.wait', { amount: 8 }, 3960, 200, { tv: 1.1, webhookId: 'de7eaba2-f851-4e37-8748-2c03cc8144a9' });
connect('Lock Set', 'Wait');

addNode('Lock Get', 'n8n-nodes-base.redis', {
    operation: 'get', propertyName: 'currentLock',
    key: "=lock:{{ $('Lock Token').first().json.phone }}", options: {}
}, 4180, 200, { tv: 1, creds: { redis: REDIS } });
connect('Wait', 'Lock Get');

addNode('IF Won Race', 'n8n-nodes-base.if', {
    conditions: conditions('and', [eq('c1', '={{ $json.currentLock }}', "={{ $('Lock Token').first().json.lockToken }}")]),
    options: {}
}, 4400, 200, { tv: 2 });
connect('Lock Get', 'IF Won Race');

addNode('Buffer Get', 'n8n-nodes-base.redis', {
    operation: 'get', propertyName: 'bufferedMessages',
    key: "=buffer:{{ $('Lock Token').first().json.phone }}", keyType: 'list', options: {}
}, 4620, 150, { tv: 1, creds: { redis: REDIS } });
connect('IF Won Race', 'Buffer Get');

addNode('Buffer Delete', 'n8n-nodes-base.redis', {
    operation: 'delete', key: "=buffer:{{ $('Lock Token').first().json.phone }}"
}, 4840, 150, { tv: 1, creds: { redis: REDIS } });
connect('Buffer Get', 'Buffer Delete');

addNode('Concat', 'n8n-nodes-base.code', {
    jsCode: `const buf=$input.first().json.bufferedMessages||[];\nconst ctx=$('Merge Ctx').first().json;\nconst combined=buf.filter(Boolean).map(s=>String(s).trim()).join(' \\n ').trim();\n// detect PDF import\nconst pdfMarker=combined.match(/__pdf_import__(\\d+)/);\nconst isPdfImport=!!pdfMarker;\nlet pdfData=null;\nif(isPdfImport){ try{ pdfData=$('Parse PDF Result').first().json.pdf_data; }catch(e){} }\nreturn [{ json:{ userId:ctx.userId, phone:ctx.phone, remoteJid:ctx.remoteJid, instance:ctx.instance, messageId:ctx.messageId, pushName:ctx.pushName, combinedText:combined, bufferLength:buf.length, convState:ctx.convState, convContext:ctx.convContext, onboarded:ctx.onboarded, isPdfImport, pdfData }}];`
}, 5060, 150);
connect('Buffer Delete', 'Concat');

// Branch off to PDF confirmation flow
addNode('IF PDF Import', 'n8n-nodes-base.if', {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 1 }, combinator: 'and',
        conditions: [{ id: 'c1', operator: { type: 'boolean', operation: 'true' }, leftValue: '={{ $json.isPdfImport }}', rightValue: true }] },
    options: {}
}, 5170, 150, { tv: 2 });
connect('Concat', 'IF PDF Import');

addNode('Save PDF Pending', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT set_conv_state($1::uuid, 'awaiting_pdf_import', $2::jsonb, 600);",
    options: { queryReplacement: "={{ $json.userId }},={{ JSON.stringify($json.pdfData || {}) }}" }
}, 5390, 50, { tv: 2.5, creds: { postgres: PG } });
connect('IF PDF Import', 'Save PDF Pending', 0);

addNode('Pack PDF Confirm', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "=📄 Leí el PDF y encontré *{{ $('Concat').first().json.pdfData?.expenses?.length || 0 }} gastos* por un total de ${{ Number($('Concat').first().json.pdfData?.total || 0).toLocaleString('es-AR') }}.\n\n{{ $('Concat').first().json.pdfData?.summary || '' }}{{ $('Concat').first().json.pdfData?.preview || '' }}\n\n¿Los importo todos? Respondé *sí* o *no*." },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Concat').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Concat').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Concat').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Concat').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Concat').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '📄' }
    ] }, options: {}
}, 5610, 50, { tv: 3.4 });
connect('Save PDF Pending', 'Pack PDF Confirm');

// AI Classify with rich prompt
const SYSTEM_PROMPT = `# ROL
Sos Chefin, un asistente conversacional experto en finanzas personales para WhatsApp. Tu trabajo es interpretar mensajes en español rioplatense (Argentina) y clasificarlos con MÁXIMA PRECISIÓN para que la app pueda actuar.

# CONTEXTO
- Fecha y hora actual: {{ $now.toFormat("yyyy-MM-dd HH:mm") }} (America/Argentina/Buenos_Aires)
- Día de la semana: {{ $now.toFormat("EEEE") }}
- Estado de conversación previo: {{ $json.convState || 'ninguno' }}
- Contexto previo: {{ JSON.stringify($json.convContext || {}) }}

# FORMATO DE SALIDA (OBLIGATORIO)
Devolvé EXCLUSIVAMENTE un JSON válido con esta estructura. Sin markdown, sin texto adicional, sin backticks:

{
  "intent": "log_expense"|"log_income"|"query"|"chart"|"delete_last"|"create_group"|"set_budget"|"toggle_category_exclusion"|"list_groups"|"list_categories"|"set_recurring"|"generate_report"|"confirm_yes"|"confirm_no"|"help"|"chat"|"unknown",
  "human_reply": "respuesta corta, cálida, max 280 chars. Si pedís aclaración, hacelo acá.",
  "needs_clarification": boolean,
  "confidence": 0.0-1.0,
  "transaction": {"amount": number, "description": string, "category_hint": string, "payment_method_hint": string, "type": "expense"|"income", "transaction_date_iso": "YYYY-MM-DD"|null, "group_hint": string|null},
  "query": {"kind": "total"|"by_category"|"list_recent"|"average", "category_hint": string, "period": "today"|"yesterday"|"this_week"|"this_month"|"last_month"|"this_year"|"all", "group_hint": string|null},
  "chart": {"kind": "by_category"|"by_day"|"by_payment_method"|"trend", "period": "this_week"|"this_month"|"last_month"|"this_year", "group_hint": string|null},
  "group": {"name": string, "kind": "trip"|"event"|"emergency"|"project"|"other", "action": "create"|"exclude"|"include"|"close"|"list"},
  "budget": {"category_hint": string, "amount": number, "period": "weekly"|"monthly"|"yearly"},
  "category_action": {"category_hint": string, "action": "exclude"|"include"|"resolve_category"},
  "recurring": {"amount": number, "description": string, "category_hint": string, "frequency": "daily"|"weekly"|"biweekly"|"monthly"|"yearly", "start_date_iso": string|null},
  "report": {"period": "this_month"|"last_month"|"this_year"|"all"|"custom", "start_date_iso": string|null, "end_date_iso": string|null}
}

Solo llenás los sub-objetos que correspondan al intent detectado. El resto pueden quedar como objetos vacíos {}.

# LÉXICO ARGENTINO (IMPORTANTE)
Estas son MULETILLAS o INTERJECCIONES — NUNCA cambian la clasificación. Mirá lo que viene DESPUÉS:
- "cucha", "chuca", "chuchá", "escuchame", "escuchá", "oime", "ojo", "boludo/a", "loco/a", "che", "dale", "ahre", "posta", "mira", "mirá", "viste", "fijate", "atento"
- Diminutivos comunes: "cafecito"=café, "lukita"=mil pesos, "manguito"=peso

Plata/dinero/guita/mango/luca/mangos = dinero (genérico).
Luca = mil pesos. "5 lucas" = 5000. "Una luca" = 1000.
Palo = millón. "Medio palo" = 500000.
"K"/"k" minúscula o mayúscula = mil. "30k" = 30000. "1.5k" = 1500.
"M" mayúscula al final de número = millón. "1M" = 1000000. "0.5M" = 500000.

# JERARQUÍA DE PRIORIDAD (TOP-DOWN, FIRST MATCH WINS)

1. **CONFIRMACIONES con conv_state activo**: si convState está seteado y el mensaje contiene "sí/si/dale/ok/va/listo/perfecto/bueno/bárbaro" → confirm_yes. Si "no/mejor no/cancelá/anulá" → confirm_no. Esto tiene prioridad sobre todo.

2. **HAY UNA PREGUNTA sobre plata/gastos/movimientos** ("cuánto", "qué gasté", "qué tengo", "cuáles", "mostrame", "decime los", "ver gastos", "resumen") → SIEMPRE **query** o **chart** (si pide gráfico). Nunca chat aunque empiece con muletilla.

3. **HAY UN MONTO con verbo de gasto/ingreso** (gasté, pagué, compré, salió, costó, usé, cobré, entró, recibí) o un sustantivo después de número que sugiere consumo ("3000 cafe", "15k luz") → **log_expense** o **log_income**.

4. **COMANDOS ADMINISTRATIVOS**: crear/listar grupos, presupuestos, recurrentes, reportes, exclusiones (ver lista abajo).

5. **AYUDA EXPLÍCITA**: "ayuda", "ayudame", "qué podés hacer", "menu", "menú", "opciones", "comandos" → **help**.

6. **CHARLA PURA** (sin pregunta sobre plata, sin monto, sin comando): "hola", "buen día", "qué tal", "cómo andás", "gracias", "🙏", "👋" → **chat** con saludo cálido.

7. **AMBIGUO** → unknown + needs_clarification=true + en human_reply pedí UNA cosa específica.

# INTENTS DETALLADOS

## log_expense / log_income
- transaction.amount: número pelado (sin signos, sin separadores). "30k"=30000.
- transaction.type: 'expense' por default. 'income' SOLO si hay verbo de ingreso (cobré, entró, recibí, me pagaron, devolución).
- transaction.category_hint: una de: comida, supermercado, transporte, nafta, farmacia, servicios, entretenimiento, ropa, salud, educacion, hogar, viajes, regalos, mascotas, tecnologia, deportes, otros. Si no hay pista clara → 'otros'.
- transaction.payment_method_hint: efectivo|debito|credito|transferencia|mercado_pago|otro. Default 'otro'.
- transaction.transaction_date_iso: SOLO si hay mención explícita ("ayer", "el lunes", "12/03"). Si no hay → null. NO INVENTES fechas pasadas.
- transaction.group_hint: nombre de viaje/evento si lo mencionan ("para el viaje a bariloche", "del cumple de fer").
- transaction.description: descripción corta, sin la palabra de la categoría si es redundante.

## query
- query.kind:
  - 'total' → "cuánto gasté", "total del mes", "cuánto en comida"
  - 'by_category' → "por categoría", "en qué gasté", "gastos desglosados"
  - 'list_recent' → "últimos gastos", "los últimos", "qué movimientos tengo"
  - 'average' → "promedio", "cuánto gasto x día"
- query.period:
  - "hoy" → today
  - "ayer" → yesterday
  - "esta semana"/"semanal" → this_week
  - "este mes"/"mensual" → this_month (DEFAULT si no se especifica)
  - "el mes pasado"/"abril"(si hoy es mayo) → last_month
  - "este año"/"anual" → this_year
  - "todo"/"siempre"/"histórico" → all
- query.category_hint: si filtran por categoría ("en comida", "de transporte").
- query.group_hint: si filtran por grupo ("del viaje a bariloche").

## chart
- chart.kind:
  - 'by_category' → "torta", "pie", "por categoría" (DEFAULT)
  - 'by_day' → "por día", "diario"
  - 'by_payment_method' → "por método de pago", "por tarjeta"
  - 'trend' → "tendencia", "evolución", "últimos meses"
- chart.period: igual que query, default this_month.

## delete_last
"borrá el último", "eliminalo", "no eso último", "deshacelo", "cancelá el último".

## create_group
"creá un viaje a X", "agregá evento Y", "abrí proyecto Z", "nuevo grupo X".
- group.kind: 'trip' (viaje, vacaciones), 'event' (cumple, casamiento, cena), 'emergency' (urgencia, médico), 'project' (obra, reforma), 'other'.

## list_groups
"qué viajes tengo", "mis grupos", "mostrame los eventos", "qué tengo abierto".

## list_categories
"qué categorías tengo", "mostrame las categorías", "cuáles son mis categorías", "lista de categorías", "categorías disponibles".

## set_budget
"presupuesto mensual de comida 80000", "límite de transporte 30k semanal", "tope de 50000 en farmacia".
- budget.period: weekly|monthly|yearly. Default monthly.

## toggle_category_exclusion
"no cuentes transferencias", "excluí servicios del reporte", "ignorá la categoría regalos" → exclude.
"volvé a contar X", "incluí Y" → include.

## set_recurring
"netflix 5500 mensual", "agregá alquiler 250000 todos los meses", "spotify 1500 cada mes".
- recurring.frequency: daily|weekly|biweekly|monthly|yearly. Default monthly.

## generate_report
"mandame el reporte de abril", "reporte mensual", "PDF de gastos del año", "informe del mes".
- report.period: this_month|last_month|this_year|all|custom.

## confirm_yes / confirm_no
SOLO si convState está activo. Sin contexto previo, NO devuelvas confirm_*.

## help
"ayuda", "qué podés hacer", "menu", "/help", "comandos disponibles".

## chat
Saludos puros, agradecimientos, charla. En human_reply contestá CÁLIDO Y CORTO, opcionalmente sugerí lo que podés hacer (1 línea, sin lista).

## unknown
needs_clarification=true. En human_reply pedí UNA cosa concreta. Ej: "Falta el monto, ¿cuánto fue?" o "¿Lo querés registrar como gasto o ingreso?".

# EJEMPLOS FEW-SHOT (estudialos)

Input: "hola"
→ {"intent":"chat","human_reply":"¡Hola! ¿En qué te ayudo?","confidence":0.99}

Input: "buen día"
→ {"intent":"chat","human_reply":"Buen día 🙌 ¿Qué necesitás?","confidence":0.98}

Input: "cucha qué gastos tengo este mes registrados?"
→ {"intent":"query","query":{"kind":"total","period":"this_month"},"confidence":0.95}

Input: "che cuánto gasté en comida"
→ {"intent":"query","query":{"kind":"total","category_hint":"comida","period":"this_month"},"confidence":0.95}

Input: "mostrame los últimos movimientos"
→ {"intent":"query","query":{"kind":"list_recent","period":"this_month"},"confidence":0.97}

Input: "decime un grafico de mis gastos del mes"
→ {"intent":"chart","chart":{"kind":"by_category","period":"this_month"},"confidence":0.95}

Input: "2500 cafe"
→ {"intent":"log_expense","transaction":{"amount":2500,"description":"cafe","category_hint":"comida","type":"expense","transaction_date_iso":null,"payment_method_hint":"otro"},"confidence":0.95}

Input: "pague 15 lucas de luz con debito"
→ {"intent":"log_expense","transaction":{"amount":15000,"description":"luz","category_hint":"servicios","type":"expense","payment_method_hint":"debito","transaction_date_iso":null},"confidence":0.95}

Input: "compre nafta 30k ayer"
→ {"intent":"log_expense","transaction":{"amount":30000,"description":"nafta","category_hint":"nafta","type":"expense","transaction_date_iso":"YYYY-MM-DD"(ayer),"payment_method_hint":"otro"},"confidence":0.95}

Input: "cobré 200000 del laburo"
→ {"intent":"log_income","transaction":{"amount":200000,"description":"sueldo","category_hint":"otros","type":"income","transaction_date_iso":null,"payment_method_hint":"otro"},"confidence":0.92}

Input: "3500 cena para el viaje a bariloche"
→ {"intent":"log_expense","transaction":{"amount":3500,"description":"cena","category_hint":"comida","type":"expense","group_hint":"viaje a bariloche","transaction_date_iso":null,"payment_method_hint":"otro"},"confidence":0.94}

Input: "creá un viaje a bariloche"
→ {"intent":"create_group","group":{"name":"Bariloche","kind":"trip","action":"create"},"confidence":0.97}

Input: "qué viajes tengo abiertos"
→ {"intent":"list_groups","group":{"action":"list"},"confidence":0.96}

Input: "qué categorías tengo"
→ {"intent":"list_categories","confidence":0.97}

Input: "mostrame las categorías disponibles"
→ {"intent":"list_categories","confidence":0.98}

Input: "presupuesto mensual de comida 80000"
→ {"intent":"set_budget","budget":{"category_hint":"comida","amount":80000,"period":"monthly"},"confidence":0.97}

Input: "no cuentes las transferencias en el reporte"
→ {"intent":"toggle_category_exclusion","category_action":{"category_hint":"transferencias","action":"exclude"},"confidence":0.93}

Input: "netflix 5500 mensual"
→ {"intent":"set_recurring","recurring":{"amount":5500,"description":"Netflix","category_hint":"entretenimiento","frequency":"monthly","start_date_iso":null},"confidence":0.96}

Input: "mandame reporte de abril"
→ {"intent":"generate_report","report":{"period":"last_month"},"confidence":0.94}

Input: "borrá el último"
→ {"intent":"delete_last","confidence":0.99}

Input: "ayuda" / "qué podés hacer"
→ {"intent":"help","confidence":0.99}

Input: "gracias!"
→ {"intent":"chat","human_reply":"De nada 🙌","confidence":0.99}

Input: "pague algo"
→ {"intent":"unknown","needs_clarification":true,"human_reply":"¿Cuánto y de qué?","confidence":0.4}

Input: "3000 transferencia"
→ {"intent":"log_expense","transaction":{"amount":3000,"description":"transferencia","category_hint":"otros","type":"expense","payment_method_hint":"transferencia","transaction_date_iso":null},"confidence":0.7}

[Si convState='awaiting_otros_confirmation'] Input: "comida"
→ {"intent":"confirm_no","category_action":{"category_hint":"comida","action":"resolve_category"},"confidence":0.9}

[Si convState='awaiting_otros_confirmation'] Input: "ok dale"
→ {"intent":"confirm_yes","confidence":0.99}

[Si convState='awaiting_pdf_import'] Input: "sí"
→ {"intent":"confirm_yes","confidence":0.99}

# REGLAS FINALES

- NUNCA inventes datos. Si falta info → unknown + needs_clarification.
- NUNCA inventes fechas pasadas. transaction_date_iso = null por default.
- confidence < 0.6 → poné needs_clarification=true.
- human_reply en español rioplatense, cálido, máximo 1-2 oraciones.
- SOLO devolvé el JSON. Cero markdown, cero \`\`\`, cero texto fuera del JSON.`;

addNode('AI Classify', '@n8n/n8n-nodes-langchain.openAi', {
    modelId: { __rl: true, mode: 'list', value: 'gpt-4o-mini' },
    messages: { values: [
        { role: 'system', content: SYSTEM_PROMPT },
        { content: '={{ $json.combinedText }}' }
    ] },
    jsonOutput: true,
    options: { temperature: 0.2 }
}, 5280, 150, { tv: 1.8, creds: { openAiApi: OPENAI } });
connect('IF PDF Import', 'AI Classify', 1);

addNode('Parse AI', 'n8n-nodes-base.code', {
    jsCode: `let raw=$input.first().json;\nlet payload=raw.message?.content||raw.content||raw;\nif(typeof payload==='string'){try{payload=JSON.parse(payload);}catch(e){payload={intent:'unknown',human_reply:'No te entendí, ¿podés repetirlo?'};}}\nconst ctx=$('Concat').first().json;\nreturn [{ json:{ ...ctx, intent:payload.intent||'unknown', human_reply:payload.human_reply||'', needs_clarification:!!payload.needs_clarification, transaction:payload.transaction||{}, query:payload.query||{}, chart:payload.chart||{}, group:payload.group||{}, budget:payload.budget||{}, category_action:payload.category_action||{}, recurring:payload.recurring||{}, report:payload.report||{}, raw_ai:payload }}];`
}, 5500, 150);
connect('AI Classify', 'Parse AI');

// Switch Intent — many branches
const intents = ['log_expense','log_income','query','chart','delete_last','create_group','list_groups','set_budget','toggle_category_exclusion','set_recurring','generate_report','confirm_yes','confirm_no','help','chat','list_categories'];
addNode('Switch Intent', 'n8n-nodes-base.switch', {
    rules: { values: intents.map((it, i) => ({
        conditions: conditions('and', [eq('r'+i, '={{ $json.intent }}', it)]),
        renameOutput: true, outputKey: it
    })) }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'fallback' }
}, 5720, 150, { tv: 3 });
connect('Parse AI', 'Switch Intent');

// === log_expense / log_income (idx 0, 1) ===
addNode('Match Category', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM find_best_category($1::uuid, $2::text, $3::text);',
    options: { queryReplacement: "={{ $json.userId }},={{ ($json.transaction?.category_hint || $json.transaction?.description || '').toString() }},={{ $json.transaction?.type === 'income' ? 'income' : 'expense' }}" }
}, 5940, 0, { tv: 2.5, creds: { postgres: PG } });
connect('Switch Intent', 'Match Category', 0);
connect('Switch Intent', 'Match Category', 1);

addNode('Ensure Category', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "WITH ins AS (INSERT INTO categories (user_id, name, normalized_name, type, keywords, is_system) VALUES ($1::uuid, $2, normalize_text($2), $3, ARRAY[normalize_text($2)], FALSE) ON CONFLICT (user_id, normalized_name, type) DO UPDATE SET name = EXCLUDED.name RETURNING id, name) SELECT COALESCE($4::uuid, (SELECT id FROM ins)) AS category_id, COALESCE((SELECT name FROM categories WHERE id = $4::uuid), (SELECT name FROM ins)) AS category_name;",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }},={{ ($('Parse AI').first().json.transaction?.category_hint || 'Otros') }},={{ $('Parse AI').first().json.transaction?.type === 'income' ? 'income' : 'expense' }},={{ $json.category_id || null }}" }
}, 6160, 0, { tv: 2.5, creds: { postgres: PG } });
connect('Match Category', 'Ensure Category');

// IF "Otros" → ask for confirmation instead of inserting
addNode('IF Is Otros', 'n8n-nodes-base.if', {
    conditions: { options: { caseSensitive: false, typeValidation: 'loose', version: 1 }, combinator: 'and',
        conditions: [{ id: 'c1', operator: { type: 'string', operation: 'equals' }, leftValue: '={{ $json.category_name.toLowerCase() }}', rightValue: 'otros' }] },
    options: {}
}, 6380, 0, { tv: 2 });
connect('Ensure Category', 'IF Is Otros');

// Otros true → set conv_state and ask
addNode('Set Conv Awaiting Otros', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT set_conv_state($1::uuid, 'awaiting_otros_confirmation', $2::jsonb, 300);",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }},={{ JSON.stringify({pending_tx: $('Parse AI').first().json.transaction, category_id: $json.category_id}) }}" }
}, 6600, -100, { tv: 2.5, creds: { postgres: PG } });
connect('IF Is Otros', 'Set Conv Awaiting Otros', 0);

addNode('Format Otros Question', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT format_reply('confirm_otros') AS reply_text;",
    options: {}
}, 6820, -100, { tv: 2.5, creds: { postgres: PG } });
connect('Set Conv Awaiting Otros', 'Format Otros Question');

addNode('Pack Otros Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: '={{ $json.reply_text }}' },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '🤔' }
    ] }, options: {}
}, 7040, -100, { tv: 3.4 });
connect('Format Otros Question', 'Pack Otros Reply');

// Insert Tx (when not Otros, or after resolving)
addNode('Check Duplicate', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT * FROM check_duplicate_tx($1::uuid, $2::numeric, $3::date, 60);",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }},={{ Number($('Parse AI').first().json.transaction?.amount || 0) }},={{ $('Parse AI').first().json.transaction?.transaction_date_iso ? String($('Parse AI').first().json.transaction?.transaction_date_iso).slice(0,10) : new Date().toISOString().slice(0,10) }}" }
}, 6500, 100, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('IF Is Otros', 'Check Duplicate', 1);

addNode('IF Is Duplicate', 'n8n-nodes-base.if', {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 1 }, combinator: 'and',
        conditions: [{ id: 'c1', operator: { type: 'string', operation: 'notEmpty' }, leftValue: '={{ $json.id }}', rightValue: '' }] },
    options: {}
}, 6600, 100, { tv: 2 });
connect('Check Duplicate', 'IF Is Duplicate');

// Duplicate found → save pending and ask
addNode('Save Dup Pending', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT set_conv_state($1::uuid, 'awaiting_dup_confirmation', $2::jsonb, 300);",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }},={{ JSON.stringify({pending_tx: $('Parse AI').first().json.transaction, category_id: $('Ensure Category').first().json.category_id, existing_id: $json.id, existing_created: $json.created_at}) }}" }
}, 6700, 0, { tv: 2.5, creds: { postgres: PG } });
connect('IF Is Duplicate', 'Save Dup Pending', 0);

addNode('Pack Dup Question', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "=⚠️ Ya tenés un gasto registrado de ${{ Number($('Check Duplicate').first().json.amount).toLocaleString('es-AR') }}{{ $('Check Duplicate').first().json.description ? ' (' + $('Check Duplicate').first().json.description + ')' : '' }} hoy. ¿Lo guardo igual? Respondé *sí* o *no*." },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '⚠️' }
    ] }, options: {}
}, 6800, 0, { tv: 3.4 });
connect('Save Dup Pending', 'Pack Dup Question');

// Not duplicate → resolve group → insert
addNode('Resolve Group', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT CASE WHEN $2::text != '__none__' AND $2::text != '' THEN upsert_group($1::uuid, $2::text, 'event') ELSE NULL END AS group_id;",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }},={{ $('Parse AI').first().json.transaction?.group_hint || '__none__' }}" }
}, 6700, 200, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('IF Is Duplicate', 'Resolve Group', 1);

addNode('Insert Tx', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "WITH msg AS (INSERT INTO messages (user_id, direction, whatsapp_message_id, content, intent, processed) VALUES ($1::uuid,'inbound',$2,$3,$4,TRUE) ON CONFLICT (whatsapp_message_id) DO UPDATE SET intent = EXCLUDED.intent, processed = TRUE RETURNING id) INSERT INTO transactions (user_id, category_id, group_id, message_id, type, amount, currency, description, raw_message, transaction_date, transaction_at, confidence_score, metadata) VALUES ($1::uuid, $5::uuid, NULLIF($6, 'null')::uuid, (SELECT id FROM msg), $7, $8::numeric, 'ARS', $9, $10, COALESCE(NULLIF($11, 'null')::date, CURRENT_DATE), NULLIF($13, 'null')::timestamptz, 0.85, REPLACE($12, '|', ',')::jsonb) RETURNING id, amount, description, transaction_date, category_id;",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }},={{ $('Parse AI').first().json.messageId }},={{ ($('Parse AI').first().json.combinedText || '').toString().replace(/,/g, ' ') }},={{ $('Parse AI').first().json.intent }},={{ $('Ensure Category').first().json.category_id }},={{ $json.group_id || null }},={{ $('Parse AI').first().json.transaction?.type === 'income' ? 'income' : 'expense' }},={{ Number($('Parse AI').first().json.transaction?.amount || 0) }},={{ ($('Parse AI').first().json.transaction?.description || $('Parse AI').first().json.combinedText || '').toString().replace(/,/g, ' ') }},={{ ($('Parse AI').first().json.combinedText || '').toString().replace(/,/g, ' ') }},={{ $('Parse AI').first().json.transaction?.transaction_date_iso ? String($('Parse AI').first().json.transaction?.transaction_date_iso).slice(0,10) : null }},={{ JSON.stringify($('Parse AI').first().json.raw_ai || {}).replace(/,/g, '|') }},={{ $('Parse AI').first().json.transaction?.transaction_date_iso && String($('Parse AI').first().json.transaction?.transaction_date_iso).length > 10 ? $('Parse AI').first().json.transaction?.transaction_date_iso : null }}" }
}, 6820, 200, { tv: 2.5, creds: { postgres: PG } });
connect('Resolve Group', 'Insert Tx');

addNode('Format Expense Reply Q', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT format_reply($1::text, $2::numeric, $3::text, $4::text, $5::date) AS reply_text;",
    options: { queryReplacement: "={{ $('Parse AI').first().json.transaction?.type === 'income' ? 'income_logged' : 'expense_logged' }},={{ $json.amount }},={{ $('Ensure Category').first().json.category_name }},={{ $('Parse AI').first().json.transaction?.description || '' }},={{ $json.transaction_date }}" }
}, 7040, 100, { tv: 2.5, creds: { postgres: PG } });
connect('Insert Tx', 'Format Expense Reply Q');

addNode('Check Budget', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM check_budget_status($1::uuid, $2::uuid);',
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }},={{ $('Insert Tx').first().json.category_id }}" }
}, 7260, 100, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Format Expense Reply Q', 'Check Budget');

addNode('Pack Expense Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "={{ $('Format Expense Reply Q').first().json.reply_text + ($json.should_alert ? ('\\n\\n' + ($json.level === 'over_budget' ? '⚠️ Te pasaste del presupuesto de ' + $json.category_name + ': $' + Number($json.total).toLocaleString('es-AR') + ' de $' + Number($json.budget_amount).toLocaleString('es-AR') : '🟡 Vas por $' + Number($json.total).toLocaleString('es-AR') + ' en ' + $json.category_name + ' este mes (limite $' + Number($json.budget_amount).toLocaleString('es-AR') + ')')) : '') }}" },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: "={{ $('Parse AI').first().json.transaction?.type === 'income' ? '💰' : '✅' }}" }
    ] }, options: {}
}, 7480, 100, { tv: 3.4 });
connect('Check Budget', 'Pack Expense Reply');

// === query (idx 2) ===
addNode('Build Query SQL', 'n8n-nodes-base.code', {
    jsCode: `const ctx=$input.first().json;\nconst q=ctx.query||{};\nconst period=q.period||'this_month';\nconst periodSql={today:"transaction_date = CURRENT_DATE",yesterday:"transaction_date = CURRENT_DATE - INTERVAL '1 day'",this_week:"transaction_date >= DATE_TRUNC('week', CURRENT_DATE)",this_month:"transaction_date >= DATE_TRUNC('month', CURRENT_DATE)",last_month:"transaction_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') AND transaction_date < DATE_TRUNC('month', CURRENT_DATE)",this_year:"transaction_date >= DATE_TRUNC('year', CURRENT_DATE)",all:"TRUE"}[period]||"transaction_date >= DATE_TRUNC('month', CURRENT_DATE)";\nlet sql,params;const userId=ctx.userId;const catHint=(q.category_hint||'').trim();\nif(q.kind==='list_recent'){sql=\`SELECT t.transaction_date::text AS d, t.amount, t.description, c.name AS cat, c.emoji FROM v_reportable_transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 AND t.type='expense' AND \${periodSql} ORDER BY t.transaction_date DESC, t.created_at DESC LIMIT 10\`;params=[userId];}\nelse if(q.kind==='by_category'){sql=\`SELECT c.name AS category, c.emoji, SUM(t.amount) AS total, COUNT(*) AS n FROM v_reportable_transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 AND t.type='expense' AND \${periodSql} GROUP BY c.name, c.emoji ORDER BY total DESC\`;params=[userId];}\nelse if(q.kind==='average'){sql=\`SELECT AVG(amount) AS avg_amount, COUNT(*) AS n FROM v_reportable_transactions WHERE user_id=$1 AND type='expense' AND \${periodSql}\`;params=[userId];}\nelse{if(catHint){sql=\`SELECT COALESCE(SUM(t.amount),0) AS total, COUNT(*) AS n, c.name AS category, c.emoji FROM v_reportable_transactions t JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 AND t.type='expense' AND \${periodSql} AND c.normalized_name % normalize_text($2) GROUP BY c.name, c.emoji ORDER BY total DESC LIMIT 5\`;params=[userId,catHint];}else{sql=\`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM v_reportable_transactions WHERE user_id=$1 AND type='expense' AND \${periodSql}\`;params=[userId];}}\nreturn [{json:{...ctx,sql,params,period}}];`
}, 5940, 280);
connect('Switch Intent', 'Build Query SQL', 2);

addNode('Run Query', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery', query: '={{ $json.sql }}',
    options: { queryReplacement: "={{ ($json.params || []).join(',') }}" }
}, 6160, 280, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Build Query SQL', 'Run Query');

addNode('Format Query Reply', 'n8n-nodes-base.code', {
    jsCode: `const items=$input.all();const ctx=$('Parse AI').first().json;const period=$('Build Query SQL').first().json.period;const fmt=n=>Number(n||0).toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:2});const periodLabel=({today:'hoy',yesterday:'ayer',this_week:'esta semana',this_month:'este mes',last_month:'el mes pasado',this_year:'este año',all:'en total'})[period]||period;\nlet text='';\nif(!items.length||(items.length===1&&items[0].json.total==='0')){text=\`📭 No tengo registros para \${periodLabel} todavía.\`;}\nelse if(items.length===1&&items[0].json.total!==undefined&&!items[0].json.category){const r=items[0].json;text=\`💸 Gastaste $\${fmt(r.total)} \${periodLabel} (\${r.n} \${r.n==1?'movimiento':'movimientos'}).\`;}\nelse if(items[0].json.category!==undefined){text=\`📊 Gastos por categoría \${periodLabel}:\\n\`+items.slice(0,10).map(i=>\`\${i.json.emoji||''} \${i.json.category||'—'}: $\${fmt(i.json.total)} (\${i.json.n})\`).join('\\n');const total=items.reduce((s,i)=>s+Number(i.json.total||0),0);text+=\`\\n\\n*Total:* $\${fmt(total)}\`;}\nelse if(items[0].json.d!==undefined){text=\`🧾 Últimos movimientos:\\n\`+items.map(i=>\`\${i.json.d} · \${i.json.emoji||''} \${i.json.cat||'—'} · $\${fmt(i.json.amount)}\${i.json.description?' — '+i.json.description:''}\`).join('\\n');}\nelse if(items[0].json.avg_amount!==undefined){const r=items[0].json;text=\`📈 Promedio \${periodLabel}: $\${fmt(r.avg_amount)} (\${r.n} mov).\`;}\nelse{text='No tengo registros.';}\nreturn [{json:{replyText:text,replyKind:'text',userId:ctx.userId,phone:ctx.phone,instance:ctx.instance,remoteJid:ctx.remoteJid,messageId:ctx.messageId,reactionEmoji:'📊'}}];`
}, 6380, 280);
connect('Run Query', 'Format Query Reply');

// === chart (idx 3) ===
addNode('Build Chart SQL', 'n8n-nodes-base.code', {
    jsCode: `const ctx=$input.first().json;const c=ctx.chart||{};const period=c.period||'this_month';const periodSql={this_week:"transaction_date >= DATE_TRUNC('week', CURRENT_DATE)",this_month:"transaction_date >= DATE_TRUNC('month', CURRENT_DATE)",last_month:"transaction_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') AND transaction_date < DATE_TRUNC('month', CURRENT_DATE)",this_year:"transaction_date >= DATE_TRUNC('year', CURRENT_DATE)"}[period]||"transaction_date >= DATE_TRUNC('month', CURRENT_DATE)";\nlet sql;\nif(c.kind==='by_day'){sql=\`SELECT transaction_date::text AS label, SUM(amount)::numeric AS value FROM v_reportable_transactions WHERE user_id=$1 AND type='expense' AND \${periodSql} GROUP BY transaction_date ORDER BY transaction_date\`;}\nelse if(c.kind==='by_payment_method'){sql=\`SELECT COALESCE(p.name,'Sin método') AS label, SUM(t.amount)::numeric AS value FROM v_reportable_transactions t LEFT JOIN payment_methods p ON p.id=t.payment_method_id WHERE t.user_id=$1 AND t.type='expense' AND \${periodSql} GROUP BY p.name ORDER BY value DESC\`;}\nelse if(c.kind==='trend'){sql=\`SELECT TO_CHAR(DATE_TRUNC('month', transaction_date),'YYYY-MM') AS label, SUM(amount)::numeric AS value FROM v_reportable_transactions WHERE user_id=$1 AND type='expense' AND transaction_date >= CURRENT_DATE - INTERVAL '6 months' GROUP BY 1 ORDER BY 1\`;}\nelse{sql=\`SELECT COALESCE(c.name,'Sin categoría') AS label, SUM(t.amount)::numeric AS value FROM v_reportable_transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=$1 AND t.type='expense' AND \${periodSql} GROUP BY c.name ORDER BY value DESC LIMIT 12\`;}\nreturn [{json:{...ctx,sql,kind:c.kind||'by_category',period}}];`
}, 5940, 460);
connect('Switch Intent', 'Build Chart SQL', 3);

addNode('Run Chart', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery', query: '={{ $json.sql }}',
    options: { queryReplacement: "={{ $json.userId }}" }
}, 6160, 460, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Build Chart SQL', 'Run Chart');

addNode('Build QuickChart URL', 'n8n-nodes-base.code', {
    jsCode: `const items=$input.all();const ctx=$('Parse AI').first().json;const meta=$('Build Chart SQL').first().json;const periodLabel=({this_week:'esta semana',this_month:'este mes',last_month:'mes pasado',this_year:'este año'})[meta.period]||meta.period;\nif(!items.length||items.every(i=>!i.json.label)){return [{json:{replyKind:'text',replyText:\`📭 No tengo gastos para \${periodLabel}. Mandame algunos primero.\`,userId:ctx.userId,phone:ctx.phone,instance:ctx.instance,remoteJid:ctx.remoteJid,messageId:ctx.messageId,reactionEmoji:'📈'}}];}\nconst labels=items.map(i=>i.json.label);const values=items.map(i=>Number(i.json.value));const total=values.reduce((s,v)=>s+v,0);const isPie=meta.kind==='by_category'||meta.kind==='by_payment_method';const palette=['#FF6B6B','#4ECDC4','#FFD93D','#6BCB77','#4D96FF','#9D4EDD','#FF9F1C','#2EC4B6','#E71D36','#7209B7','#3A86FF','#FB5607'];const titleByKind=({by_category:'Gastos por categoría',by_payment_method:'Gastos por método de pago',by_day:'Gastos diarios',trend:'Tendencia mensual (6 meses)'})[meta.kind]||'Gastos';\nlet chart;\nif(isPie){chart={type:'doughnut',data:{labels,datasets:[{data:values,backgroundColor:palette}]},options:{plugins:{title:{display:true,text:\`\${titleByKind} — \${periodLabel}\`},legend:{position:'right'}}}};}\nelse{chart={type:'bar',data:{labels,datasets:[{label:'Gasto',data:values,backgroundColor:palette[0]}]},options:{plugins:{title:{display:true,text:\`\${titleByKind} — \${periodLabel}\`},legend:{display:false}},scales:{y:{beginAtZero:true}}}};}\nconst url='https://quickchart.io/chart?bkg=white&w=900&h=600&c='+encodeURIComponent(JSON.stringify(chart));const fmt=n=>Number(n||0).toLocaleString('es-AR');const caption=\`\${titleByKind} — \${periodLabel}\\nTotal: $\${fmt(total)}\`;\nreturn [{json:{replyKind:'image',imageUrl:url,replyText:caption,userId:ctx.userId,phone:ctx.phone,instance:ctx.instance,remoteJid:ctx.remoteJid,messageId:ctx.messageId,reactionEmoji:'📈'}}];`
}, 6380, 460);
connect('Run Chart', 'Build QuickChart URL');

// === delete_last (idx 4) ===
addNode('Delete Last', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "WITH last_tx AS (SELECT id, amount, description, transaction_date FROM transactions WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 1) DELETE FROM transactions WHERE id IN (SELECT id FROM last_tx) RETURNING amount, description, transaction_date;",
    options: { queryReplacement: "={{ $json.userId }}" }
}, 5940, 640, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Intent', 'Delete Last', 4);

addNode('Format Delete Reply', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT format_reply('deleted', $1::numeric, NULL, $2::text, $3::date) AS reply_text;",
    options: { queryReplacement: "={{ $json.amount }},={{ $json.description }},={{ $json.transaction_date }}" }
}, 6160, 640, { tv: 2.5, creds: { postgres: PG } });
connect('Delete Last', 'Format Delete Reply');

addNode('Pack Delete Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: '={{ $json.reply_text }}' },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '🗑️' }
    ] }, options: {}
}, 6380, 640, { tv: 3.4 });
connect('Format Delete Reply', 'Pack Delete Reply');

// === create_group (idx 5) ===
addNode('Create Group', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT name, kind FROM expense_groups WHERE id = upsert_group($1::uuid, $2::text, $3::text);",
    options: { queryReplacement: "={{ $json.userId }},={{ $json.group?.name || 'Sin nombre' }},={{ $json.group?.kind || 'event' }}" }
}, 5940, 820, { tv: 2.5, creds: { postgres: PG } });
connect('Switch Intent', 'Create Group', 5);

addNode('Pack Group Created', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "=🧳 Creé el {{ $json.kind }} *{{ $json.name }}*. Cuando registres gastos para esto, mencionalo (ej: \"3000 cena para {{ $json.name }}\") y los voy a agrupar acá." },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '🧳' }
    ] }, options: {}
}, 6160, 820, { tv: 3.4 });
connect('Create Group', 'Pack Group Created');

// === list_groups (idx 6) ===
addNode('List Groups', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM list_groups($1::uuid, true);',
    options: { queryReplacement: "={{ $json.userId }}" }
}, 5940, 1000, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Intent', 'List Groups', 6);

addNode('Format Groups List', 'n8n-nodes-base.code', {
    jsCode: `const items=$input.all();const ctx=$('Parse AI').first().json;const fmt=n=>Number(n||0).toLocaleString('es-AR');\nlet text;\nif(!items.length||!items[0].json.id){text='📭 No tenés grupos creados todavía. Probá: "creá un viaje a bariloche".';}\nelse{text='🧳 Tus grupos:\\n'+items.map(i=>{const j=i.json;return \`\${j.excluded?'🚫 ':''}\${j.emoji||'•'} *\${j.name}* (\${j.kind}) — \${j.n} gastos · $\${fmt(j.total)}\`;}).join('\\n');}\nreturn [{json:{replyText:text,replyKind:'text',userId:ctx.userId,phone:ctx.phone,instance:ctx.instance,remoteJid:ctx.remoteJid,messageId:ctx.messageId,reactionEmoji:'📋'}}];`
}, 6160, 1000);
connect('List Groups', 'Format Groups List');

// === set_budget (idx 7) ===
addNode('Set Budget', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM set_budget($1::uuid, $2::text, $3::numeric, $4::text);',
    options: { queryReplacement: "={{ $json.userId }},={{ $json.budget?.category_hint || '' }},={{ $json.budget?.amount || 0 }},={{ $json.budget?.period || 'monthly' }}" }
}, 5940, 1180, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Intent', 'Set Budget', 7);

addNode('Pack Budget Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "={{ $json.category_name ? '🎯 Listo, presupuesto ' + ($json.period === 'weekly' ? 'semanal' : $json.period === 'yearly' ? 'anual' : 'mensual') + ' de *' + $json.category_name + '* en $' + Number($json.amount).toLocaleString('es-AR') + '. Te aviso cuando estés cerca o te pases.' : '😅 No encontré esa categoría. Mandala como aparece en tus gastos.' }}" },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '🎯' }
    ] }, options: {}
}, 6160, 1180, { tv: 3.4 });
connect('Set Budget', 'Pack Budget Reply');

// === toggle_category_exclusion (idx 8) ===
addNode('Toggle Cat Excl', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT * FROM toggle_category_exclusion($1::uuid, $2::text);',
    options: { queryReplacement: "={{ $json.userId }},={{ $json.category_action?.category_hint || '' }}" }
}, 5940, 1360, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Intent', 'Toggle Cat Excl', 8);

addNode('Pack Toggle Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "={{ $json.name ? ($json.excluded ? '🚫 Listo, *' + $json.name + '* deja de contar en los reportes.' : '✅ *' + $json.name + '* vuelve a contar en los reportes.') : '😅 No encontré esa categoría.' }}" },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '👌' }
    ] }, options: {}
}, 6160, 1360, { tv: 3.4 });
connect('Toggle Cat Excl', 'Pack Toggle Reply');

// === set_recurring (idx 9) ===
addNode('Set Recurring', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "WITH cat AS (SELECT id FROM categories WHERE user_id=$1::uuid AND normalized_name % normalize_text($2::text) ORDER BY similarity(normalized_name, normalize_text($2::text)) DESC LIMIT 1) INSERT INTO recurring_transactions (user_id, category_id, type, amount, currency, description, frequency, next_occurrence, is_active) VALUES ($1::uuid, (SELECT id FROM cat), 'expense', $3::numeric, 'ARS', $4::text, $5::text, COALESCE($6::date, CURRENT_DATE), TRUE) RETURNING amount, description, frequency, next_occurrence;",
    options: { queryReplacement: "={{ $json.userId }},={{ $json.recurring?.category_hint || 'Otros' }},={{ $json.recurring?.amount || 0 }},={{ $json.recurring?.description || '' }},={{ $json.recurring?.frequency || 'monthly' }},={{ $json.recurring?.start_date_iso || null }}" }
}, 5940, 1540, { tv: 2.5, creds: { postgres: PG } });
connect('Switch Intent', 'Set Recurring', 9);

addNode('Pack Recurring Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "=🔁 Listo, agendé recurrente: $({{ $json.amount }}) {{ $json.description ? '— ' + $json.description : '' }} cada {{ $json.frequency === 'daily' ? 'día' : $json.frequency === 'weekly' ? 'semana' : $json.frequency === 'biweekly' ? 'quincena' : $json.frequency === 'yearly' ? 'año' : 'mes' }}. Próxima carga: {{ $json.next_occurrence }}." },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '🔁' }
    ] }, options: {}
}, 6160, 1540, { tv: 3.4 });
connect('Set Recurring', 'Pack Recurring Reply');

// === generate_report (idx 10) ===
addNode('Calc Report Range', 'n8n-nodes-base.code', {
    jsCode: `const ctx=$input.first().json;const r=ctx.report||{};const period=r.period||'this_month';const today=new Date();const fmt=d=>d.toISOString().slice(0,10);let s,e;\nif(period==='custom'&&r.start_date_iso&&r.end_date_iso){s=r.start_date_iso;e=r.end_date_iso;}\nelse if(period==='last_month'){const d=new Date(today.getFullYear(),today.getMonth()-1,1);s=fmt(d);e=fmt(new Date(today.getFullYear(),today.getMonth(),0));}\nelse if(period==='this_year'){s=\`\${today.getFullYear()}-01-01\`;e=fmt(today);}\nelse if(period==='all'){s='2000-01-01';e=fmt(today);}\nelse{s=fmt(new Date(today.getFullYear(),today.getMonth(),1));e=fmt(today);}\nreturn [{json:{...ctx,startDate:s,endDate:e}}];`
}, 5940, 1720);
connect('Switch Intent', 'Calc Report Range', 10);

addNode('Trigger PDF Webhook', 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: 'http://n8n:5678/webhook/report-request',
    sendBody: true, specifyBody: 'json',
    jsonBody: '={\n  "userId": "{{ $json.userId }}",\n  "phone": "{{ $json.phone }}",\n  "instance": "{{ $json.instance }}",\n  "startDate": "{{ $json.startDate }}",\n  "endDate": "{{ $json.endDate }}"\n}',
    options: { response: { response: { neverError: true } } }
}, 6160, 1720, { tv: 4.2, cof: true });
connect('Calc Report Range', 'Trigger PDF Webhook');

addNode('Pack Report Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "=📄 Estoy armando tu reporte ({{ $('Calc Report Range').first().json.startDate }} → {{ $('Calc Report Range').first().json.endDate }}). Te lo mando en un toque." },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '📄' }
    ] }, options: {}
}, 6380, 1720, { tv: 3.4 });
connect('Trigger PDF Webhook', 'Pack Report Reply');

// === confirm_yes (idx 11) — branch by pending state ===
addNode('Get Pending', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT state, context FROM conversation_state WHERE user_id = $1::uuid LIMIT 1;",
    options: { queryReplacement: "={{ $json.userId }}" }
}, 5780, 1900, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Intent', 'Get Pending', 11);

addNode('Switch Pending Type', 'n8n-nodes-base.switch', {
    rules: { values: [
        { conditions: conditions('and', [eq('p1', '={{ $json.state }}', 'awaiting_pdf_import')]), renameOutput: true, outputKey: 'pdf' },
        { conditions: conditions('and', [eq('p2', '={{ $json.state }}', 'awaiting_dup_confirmation')]), renameOutput: true, outputKey: 'duplicate' }
    ] }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'otros' }
}, 5940, 1900, { tv: 3 });
connect('Get Pending', 'Switch Pending Type');

addNode('Bulk Insert PDF', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "WITH state AS (SELECT context FROM conversation_state WHERE user_id = $1::uuid AND state = 'awaiting_pdf_import' LIMIT 1), expenses AS (SELECT (e.value->>'amount')::numeric AS amount, e.value->>'description' AS description, e.value->>'category_hint' AS cat_hint, NULLIF(e.value->>'transaction_date_iso','')::date AS tx_date, e.value->>'merchant' AS merchant FROM state s, jsonb_array_elements(s.context->'expenses') e), with_cats AS (SELECT ex.*, COALESCE((SELECT id FROM categories c WHERE c.user_id=$1::uuid AND c.normalized_name = normalize_text(ex.cat_hint) LIMIT 1), (SELECT id FROM categories c WHERE c.user_id=$1::uuid AND c.normalized_name = normalize_text('Otros') LIMIT 1)) AS category_id FROM expenses ex), ins AS (INSERT INTO transactions (user_id, category_id, type, amount, currency, description, raw_message, transaction_date, confidence_score, metadata) SELECT $1::uuid, wc.category_id, 'expense', wc.amount, 'ARS', COALESCE(wc.description, wc.merchant, 'Importado de PDF'), '[pdf_import]', COALESCE(wc.tx_date, CURRENT_DATE), 0.7, jsonb_build_object('source','pdf_import','merchant',wc.merchant) FROM with_cats wc WHERE wc.amount > 0 RETURNING id), cleanup AS (SELECT clear_conv_state($1::uuid)) SELECT COUNT(*) AS imported_count, (SELECT SUM(amount) FROM expenses) AS total FROM ins;",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }}" }
}, 6160, 1820, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Pending Type', 'Bulk Insert PDF', 0);

addNode('Pack PDF Imported', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "=✅ Importé *{{ $json.imported_count }}* gastos del PDF por un total de ${{ Number($json.total || 0).toLocaleString('es-AR') }}. Si querés revisarlos, pedime \"últimos movimientos\"." },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '📥' }
    ] }, options: {}
}, 6380, 1820, { tv: 3.4 });
connect('Bulk Insert PDF', 'Pack PDF Imported');

addNode('Insert Dup Confirmed', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "WITH state AS (SELECT context FROM conversation_state WHERE user_id = $1::uuid AND state = 'awaiting_dup_confirmation' LIMIT 1), ins AS (INSERT INTO transactions (user_id, category_id, type, amount, currency, description, raw_message, transaction_date, transaction_at, confidence_score, metadata) SELECT $1::uuid, (s.context->>'category_id')::uuid, 'expense', (s.context->'pending_tx'->>'amount')::numeric, 'ARS', s.context->'pending_tx'->>'description', '[duplicate confirmed]', COALESCE((s.context->'pending_tx'->>'transaction_date_iso')::date, CURRENT_DATE), CASE WHEN length(s.context->'pending_tx'->>'transaction_date_iso') > 10 THEN (s.context->'pending_tx'->>'transaction_date_iso')::timestamptz ELSE NULL END, 0.85, s.context FROM state s RETURNING amount, description, transaction_date), del AS (SELECT clear_conv_state($1::uuid)) SELECT * FROM ins;",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }}" }
}, 6160, 1860, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Pending Type', 'Insert Dup Confirmed', 1);
connect('Insert Dup Confirmed', 'Pack Yes Reply');

addNode('Resolve Pending Yes', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "WITH state AS (SELECT context FROM conversation_state WHERE user_id = $1::uuid AND state = 'awaiting_otros_confirmation' LIMIT 1), ins AS (INSERT INTO transactions (user_id, category_id, type, amount, currency, description, raw_message, transaction_date, confidence_score, metadata) SELECT $1::uuid, (s.context->>'category_id')::uuid, 'expense', (s.context->'pending_tx'->>'amount')::numeric, 'ARS', s.context->'pending_tx'->>'description', '[confirmed otros]', COALESCE((s.context->'pending_tx'->>'transaction_date_iso')::date, CURRENT_DATE), 0.85, s.context FROM state s RETURNING amount, description, transaction_date), del AS (SELECT clear_conv_state($1::uuid)) SELECT * FROM ins;",
    options: { queryReplacement: "={{ $('Parse AI').first().json.userId }}" }
}, 6160, 1980, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Pending Type', 'Resolve Pending Yes', 2);

addNode('Pack Yes Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "={{ $json.amount ? '✅ Listo, lo guardé en *Otros*: $' + Number($json.amount).toLocaleString('es-AR') + ($json.description ? ' — ' + $json.description : '') : '😅 No tenía nada pendiente para confirmar.' }}" },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '✅' }
    ] }, options: {}
}, 6160, 1900, { tv: 3.4 });
connect('Resolve Pending Yes', 'Pack Yes Reply');

// === confirm_no (idx 12) — clear pending ===
addNode('Clear Pending', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: 'SELECT clear_conv_state($1::uuid);',
    options: { queryReplacement: "={{ $json.userId }}" }
}, 5940, 2080, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Intent', 'Clear Pending', 12);

addNode('Pack No Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: '=👍 Cancelado. Si querés intentarlo de nuevo, escribime el gasto con la categoría que prefieras.' },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $('Parse AI').first().json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $('Parse AI').first().json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $('Parse AI').first().json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $('Parse AI').first().json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $('Parse AI').first().json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '👍' }
    ] }, options: {}
}, 6160, 2080, { tv: 3.4 });
connect('Clear Pending', 'Pack No Reply');

// === chat (idx 13) ===
addNode('Chat Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "={{ $json.human_reply || '👋 ¡Hola! Estoy para ayudarte con tus gastos.' }}" },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '👋' }
    ] }, options: {}
}, 5940, 2260, { tv: 3.4 });
connect('Switch Intent', 'Chat Reply', 14);
connect('Switch Intent', 'Chat Reply', 16);

// === list_categories (idx 15) ===
addNode('List Categories', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "SELECT name, emoji, type, excluded_from_reports, is_active FROM categories WHERE user_id = $1::uuid AND is_active = TRUE ORDER BY type DESC, name;",
    options: { queryReplacement: "={{ $json.userId }}" }
}, 5940, 2620, { tv: 2.5, creds: { postgres: PG }, always: true });
connect('Switch Intent', 'List Categories', 15);

addNode('Format Categories List', 'n8n-nodes-base.code', {
    jsCode: `const items=$input.all();const ctx=$('Parse AI').first().json;\nif(!items.length||!items[0].json.name){return [{json:{replyText:'📭 No tenés categorías cargadas todavía.',replyKind:'text',userId:ctx.userId,phone:ctx.phone,instance:ctx.instance,remoteJid:ctx.remoteJid,messageId:ctx.messageId,reactionEmoji:'📋'}}];}\nconst expense=items.filter(i=>i.json.type==='expense');\nconst income=items.filter(i=>i.json.type==='income');\nconst fmt=arr=>arr.map(i=>{const j=i.json;return \`\${j.excluded_from_reports?'🚫 ':''}\${j.emoji||'•'} \${j.name}\`;}).join('\\n');\nlet text='📋 *Tus categorías:*';\nif(expense.length){text+='\\n\\n💸 *Gastos:*\\n'+fmt(expense);}\nif(income.length){text+='\\n\\n💰 *Ingresos:*\\n'+fmt(income);}\ntext+='\\n\\n_🚫 = excluida de reportes_';\nreturn [{json:{replyText:text,replyKind:'text',userId:ctx.userId,phone:ctx.phone,instance:ctx.instance,remoteJid:ctx.remoteJid,messageId:ctx.messageId,reactionEmoji:'📋'}}];`
}, 6160, 2620);
connect('List Categories', 'Format Categories List');

// === help (fallback) ===
addNode('Help Reply', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: "=👋 Soy Chefin, tu bot de gastos.\n\n📝 *Registrar*\n• \"2500 cafe\" / \"15000 luz con débito\"\n• \"30k nafta ayer\" / \"cobré 200000\"\n\n📊 *Consultas*\n• \"cuánto gasté este mes\" / \"gastos en comida\"\n• \"últimos movimientos\"\n\n📈 *Gráficos*\n• \"gráfico por categoría\"\n• \"tendencia de los últimos 6 meses\"\n\n🧳 *Grupos*\n• \"creá viaje a bariloche\"\n• \"3500 cena para el viaje\"\n• \"qué viajes tengo\"\n\n🎯 *Presupuestos*\n• \"presupuesto mensual de comida 80000\"\n• \"no cuentes transferencias\"\n\n🔁 *Recurrentes*\n• \"netflix 5500 mensual\"\n\n📄 *Reportes*\n• \"mandame reporte mensual\"\n\n🎙️ También entiendo audios y 📸 fotos de tickets." },
        { id: 'k', name: 'replyKind', type: 'string', value: 'text' },
        { id: 'p', name: 'phone', type: 'string', value: "={{ $json.phone }}" },
        { id: 'i', name: 'instance', type: 'string', value: "={{ $json.instance }}" },
        { id: 'j', name: 'remoteJid', type: 'string', value: "={{ $json.remoteJid }}" },
        { id: 'm', name: 'messageId', type: 'string', value: "={{ $json.messageId }}" },
        { id: 'u', name: 'userId', type: 'string', value: "={{ $json.userId }}" },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '📚' }
    ] }, options: {}
}, 5940, 2440, { tv: 3.4 });
connect('Switch Intent', 'Help Reply', 13);

// === Converge to Send Reply ===
const replyNodes = ['Pack Otros Reply','Pack Expense Reply','Format Query Reply','Build QuickChart URL','Pack Delete Reply','Pack Group Created','Format Groups List','Pack Budget Reply','Pack Toggle Reply','Pack Recurring Reply','Pack Report Reply','Pack Yes Reply','Pack No Reply','Chat Reply','Help Reply','Pack PDF Confirm','Pack PDF Imported','Format Categories List','Pack Dup Question'];

const EVO_CRED = { evolutionApi: { id: 'FgeqqvxAqTER4oeD', name: 'Evolution account' } };

// Save Context — captures all reply data so it survives Send Presence
addNode('Save Context', 'n8n-nodes-base.set', {
    assignments: { assignments: [
        { id: 'r', name: 'replyText', type: 'string', value: '={{ $json.replyText }}' },
        { id: 'k', name: 'replyKind', type: 'string', value: '={{ $json.replyKind }}' },
        { id: 'iu', name: 'imageUrl', type: 'string', value: '={{ $json.imageUrl || "" }}' },
        { id: 'p', name: 'phone', type: 'string', value: '={{ $json.phone }}' },
        { id: 'i', name: 'instance', type: 'string', value: '={{ $json.instance }}' },
        { id: 'j', name: 'remoteJid', type: 'string', value: '={{ $json.remoteJid }}' },
        { id: 'm', name: 'messageId', type: 'string', value: '={{ $json.messageId }}' },
        { id: 'u', name: 'userId', type: 'string', value: '={{ $json.userId }}' },
        { id: 'rx', name: 'reactionEmoji', type: 'string', value: '={{ $json.reactionEmoji || "✅" }}' }
    ] }, options: {}
}, 7300, 1000, { tv: 3.4 });
replyNodes.forEach(n => connect(n, 'Save Context'));

// Send Presence — runs in serial, drops data but Save Context preserves it
addNode('Send Presence', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'chat-api',
    operation: 'send-presence',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.phone }}",
    presence: 'composing',
    delay: 1600,
    options_message: {}
}, 7480, 1000, { tv: 1, cof: true, always: true, creds: EVO_CRED });
connect('Save Context', 'Send Presence');

addNode('IF Image Reply', 'n8n-nodes-base.if', {
    conditions: conditions('and', [eq('c1', "={{ $('Save Context').first().json.replyKind }}", 'image')]),
    options: {}
}, 7700, 1000, { tv: 2 });
connect('Send Presence', 'IF Image Reply');

addNode('Send Image', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api',
    operation: 'send-image',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.phone }}",
    media: "={{ $('Save Context').first().json.imageUrl }}",
    caption: "={{ $('Save Context').first().json.replyText }}",
    options_message: {}
}, 7920, 900, { tv: 1, creds: EVO_CRED });
connect('IF Image Reply', 'Send Image', 0);

addNode('Send Text', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.phone }}",
    messageText: "={{ $('Save Context').first().json.replyText }}",
    options_message: {}
}, 7920, 1100, { tv: 1, creds: EVO_CRED });
connect('IF Image Reply', 'Send Text', 1);

addNode('Send Reaction', 'n8n-nodes-evolution-api.evolutionApi', {
    resource: 'messages-api',
    operation: 'send-reaction',
    instanceName: "={{ $('Save Context').first().json.instance }}",
    remoteJid: "={{ $('Save Context').first().json.remoteJid }}",
    messageId: "={{ $('Save Context').first().json.messageId }}",
    fromMe: false,
    reaction: "={{ $('Save Context').first().json.reactionEmoji || '✅' }}",
    options_message: {}
}, 8140, 1000, { tv: 1, cof: true, creds: EVO_CRED });
connect('Send Image', 'Send Reaction');
connect('Send Text', 'Send Reaction');

addNode('Log Outbound', 'n8n-nodes-base.postgres', {
    operation: 'executeQuery',
    query: "INSERT INTO messages (user_id, direction, content, processed, raw_payload) VALUES ($1::uuid, 'outbound', $2, TRUE, $3::jsonb);",
    options: { queryReplacement: "={{ $('Save Context').first().json.userId }},={{ $('Save Context').first().json.replyText || '' }},={{ JSON.stringify($('Save Context').first().json) }}" }
}, 8360, 1000, { tv: 2.5, creds: { postgres: PG }, cof: true });
connect('Send Reaction', 'Log Outbound');

// ============ OUTPUT ============
const wf = {
    name: 'Expense Bot — WhatsApp v2',
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: { executionOrder: 'v1', binaryMode: 'separate', timezone: 'America/Argentina/Buenos_Aires' },
    meta: { templateCredsSetupCompleted: true },
    tags: []
};
console.log(JSON.stringify(wf, null, 2));
