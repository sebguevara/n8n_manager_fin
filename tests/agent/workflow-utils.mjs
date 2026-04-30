// Helpers para parsear el workflow de n8n y exponer los specialist agents en
// formato apto para llamar a OpenAI directamente (eval harness).
//
// Todos los datos se extraen de `workflows/chefin-agent-v3.json` para que el
// harness siempre teste el prompt y las tools EFECTIVAS que van a producción.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'));
const WORKFLOW_PATH = path.resolve(ROOT, '../../workflows/chefin-agent-v3.json');

export function loadWorkflow() {
    return JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
}

export function getSystemPrompt(wf, nodeName) {
    const node = wf.nodes.find(n => n.name === nodeName);
    if (!node) throw new Error(`Node "${nodeName}" not found in workflow`);
    let raw;
    if (node.type === '@n8n/n8n-nodes-langchain.agent') {
        raw = node.parameters.options.systemMessage;
    } else if (node.type === '@n8n/n8n-nodes-langchain.chainLlm') {
        raw = node.parameters.messages.messageValues[0].message;
    } else {
        throw new Error(`Unknown agent node type: ${node.type}`);
    }
    return raw.startsWith('=') ? raw.slice(1) : raw;
}

// Reemplaza placeholders n8n por valores estáticos. Usar para que OpenAI no vea
// {{ ... }} crudos (causaría comportamiento errático).
// Nota: con el refactor de prompt caching, los system prompts ya no tienen placeholders;
// los placeholders viven SOLO en el `text` (user message). Mantenemos esta función por
// compat y para procesar el user message.
export function renderPrompt(prompt, ctx = {}) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fechaHora = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const dia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][now.getDay()];
    const fechaLarga = `${dia} ${now.getDate()} de ${['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][now.getMonth()]} de ${now.getFullYear()}`;
    return prompt
        .replace(/\{\{\s*\$now\.toFormat\('yyyy-MM-dd HH:mm'\)\s*\}\}/g, fechaHora)
        .replace(/\{\{\s*\$now\.toFormat\("EEEE d \\\\'de\\\\' MMMM \\\\'de\\\\' yyyy"\)\s*\}\}/g, fechaLarga)
        .replace(/\{\{\s*\$now\.toFormat\("EEEE"\)\s*\}\}/g, dia)
        .replace(/\{\{\s*\$now\.toFormat\('EEEE'\)\s*\}\}/g, dia)
        .replace(/\{\{\s*\$\('Concat'\)\.first\(\)\.json\.convState\s*\|\|\s*'ninguno'\s*\}\}/g, ctx.convState || 'ninguno')
        .replace(/\{\{\s*JSON\.stringify\(\$\('Concat'\)\.first\(\)\.json\.convContext\s*\|\|\s*\{\}\)\s*\}\}/g, JSON.stringify(ctx.convContext || {}))
        .replace(/\{\{\s*\$\('Concat'\)\.first\(\)\.json\.onboarded\s*\}\}/g, String(ctx.onboarded ?? true))
        .replace(/\{\{\s*\$\('Concat'\)\.first\(\)\.json\.combinedText\s*\}\}/g, ctx.combinedText || '')
        // Catch-all legacy placeholders (system prompts viejos)
        .replace(/\{\{\s*\$json\.convState\s*\|\|\s*'ninguno'\s*\}\}/g, ctx.convState || 'ninguno')
        .replace(/\{\{\s*JSON\.stringify\(\$json\.convContext\s*\|\|\s*\{\}\)\s*\}\}/g, JSON.stringify(ctx.convContext || {}))
        .replace(/\{\{\s*\$json\.onboarded\s*\}\}/g, String(ctx.onboarded ?? true))
        .replace(/\{\{[^}]*\}\}/g, '?');
}

// Construye el user message con el bloque [CONTEXTO]...[/CONTEXTO] adelante,
// igual que lo hace n8n via la expression `text` del nodo agente.
// Esto refleja la realidad: el contexto dinámico va con el user message,
// no en el system prompt (clave para prompt caching).
export function buildUserMessage({ message, convState, convContext, onboarded = true }) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fecha = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const dia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][now.getDay()];
    return `[CONTEXTO]
fecha=${fecha}
dia=${dia}
convState=${convState || 'ninguno'}
convContext=${JSON.stringify(convContext || {})}
onboarded=${onboarded}
[/CONTEXTO]

${message}`;
}

// Devuelve los nombres de las tools (sin prefijo "tool: ") conectadas a un agente
// vía ai_tool. Esto refleja exactamente la partición real del workflow.
export function getToolNamesForAgent(wf, agentName) {
    const out = [];
    for (const [fromNode, conns] of Object.entries(wf.connections || {})) {
        if (!fromNode.startsWith('tool: ')) continue;
        const aiTools = conns.ai_tool || [];
        const goesToAgent = aiTools.flat().some(c => c?.node === agentName);
        if (goesToAgent) {
            out.push(fromNode.slice('tool: '.length));
        }
    }
    return out.sort();
}

// Convierte un nodo toolWorkflow de n8n en una definición de función formato OpenAI.
// Lee parameters.workflowInputs.value (donde vive el $fromAI(...)) y arma el JSON schema.
function toolNodeToFunctionDef(node) {
    const fnName = node.parameters.name;
    const description = node.parameters.description || '';
    const valueObj = node.parameters.workflowInputs?.value || {};

    const properties = {};
    for (const [fieldName, expr] of Object.entries(valueObj)) {
        if (fieldName === 'tool_name' || fieldName === 'user_id') continue;
        // Patrón: $fromAI('name', `desc`, 'type'[, default])
        const m = String(expr).match(/\$fromAI\(\s*'([^']+)'\s*,\s*`([^`]*)`\s*,\s*'(\w+)'/);
        if (!m) continue;
        const [, fName, fDesc, fType] = m;
        let jsonType;
        switch (fType) {
            case 'string':  jsonType = 'string'; break;
            case 'number':  jsonType = 'number'; break;
            case 'boolean': jsonType = 'boolean'; break;
            case 'json':    jsonType = 'object'; break;
            default:        jsonType = 'string';
        }
        // Para arrays JSON (ej. tx_ids), OpenAI los acepta como object con additionalProperties=true
        // o como array of strings. Por simplicidad mantenemos como object/array según el desc.
        if (jsonType === 'object' && /array|lista|\[\]/i.test(fDesc)) {
            properties[fName] = { type: 'array', items: { type: 'string' }, description: fDesc };
        } else {
            properties[fName] = { type: jsonType, description: fDesc };
        }
    }

    return {
        type: 'function',
        function: {
            name: fnName,
            description,
            parameters: {
                type: 'object',
                properties,
                required: []
            }
        }
    };
}

// Devuelve [{type:'function', function:{...}}, ...] con SOLO las tools del agente.
export function getOpenAIToolsForAgent(wf, agentName) {
    const allowed = new Set(getToolNamesForAgent(wf, agentName));
    const defs = [];
    for (const node of wf.nodes) {
        if (node.type !== '@n8n/n8n-nodes-langchain.toolWorkflow') continue;
        if (!allowed.has(node.parameters.name)) continue;
        defs.push(toolNodeToFunctionDef(node));
    }
    return defs;
}

// Llama a OpenAI Chat Completions con tool-calling. Devuelve { tool_calls, content }.
export async function callOpenAIWithTools({ apiKey, model = 'gpt-4o-mini', systemPrompt, userMessage, tools, temperature = 0.1 }) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            temperature,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            tools,
            tool_choice: 'auto'
        })
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`OpenAI ${res.status}: ${t.slice(0, 400)}`);
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    return {
        tool_calls: (msg.tool_calls || []).map(tc => ({
            name: tc.function?.name,
            arguments_raw: tc.function?.arguments,
            arguments: safeJSON(tc.function?.arguments)
        })),
        content: msg.content || '',
        usage: data.usage
    };
}

function safeJSON(s) {
    if (!s) return {};
    try { return JSON.parse(s); } catch { return { __parse_error: s }; }
}
