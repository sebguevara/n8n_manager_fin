#!/usr/bin/env node
// Eval harness Tier 2: tool-routing.
// Para cada scenario, mandamos el mensaje al specialist agent correspondiente
// (con su system prompt + su subset de tools en formato function-calling) y
// verificamos que la PRIMERA tool llamada sea la esperada.
//
// Uso:
//   OPENAI_API_KEY=sk-... node tests/agent/run-tools.mjs
//   OPENAI_API_KEY=sk-... node tests/agent/run-tools.mjs --filter config
//
// Costo: ~30 calls × $0.0003 ≈ $0.01 por corrida.

import fs from 'node:fs';
import path from 'node:path';
import {
    loadWorkflow, getSystemPrompt, renderPrompt, buildUserMessage,
    getOpenAIToolsForAgent, callOpenAIWithTools,
    getToolNamesForAgent
} from './workflow-utils.mjs';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'));
const SCENARIO_FILE = path.join(ROOT, 'scenarios', 'tool-routing.json');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY no está seteada');
    process.exit(2);
}

const args = process.argv.slice(2);
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
const dryRun = args.includes('--dry');

const wf = loadWorkflow();

const AGENT_NODE = {
    transaction: 'Transaction Agent',
    config: 'Config Agent',
    insights: 'Insights Agent'
};

// Pre-carga prompts y tool defs por agente
const cache = {};
for (const [agentType, nodeName] of Object.entries(AGENT_NODE)) {
    const promptRaw = getSystemPrompt(wf, nodeName);
    const toolNames = getToolNamesForAgent(wf, nodeName);
    const tools = getOpenAIToolsForAgent(wf, nodeName);
    cache[agentType] = { nodeName, promptRaw, toolNames, tools };
    console.log(`Agent "${agentType}" → ${toolNames.length} tools (${tools.length} con schema válido)`);
}

if (dryRun) {
    console.log('\n--dry run: no llama a OpenAI. Mostrando primer scenario por agente para inspección.');
    const scenarios = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'));
    for (const agentType of Object.keys(AGENT_NODE)) {
        const sample = scenarios.find(s => s.agent === agentType);
        if (!sample) continue;
        const c = cache[agentType];
        console.log(`\n--- Sample para ${agentType} ---`);
        console.log('Mensaje:', sample.message);
        console.log('Tools (primeras 5):', c.tools.slice(0, 5).map(t => t.function.name));
        console.log('Total tools:', c.tools.length);
        console.log('Prompt rendered (primeros 200 chars):');
        const ctx = { convState: sample.convState, convContext: sample.convContext };
        console.log('  ', renderPrompt(c.promptRaw, ctx).slice(0, 200), '...');
    }
    process.exit(0);
}

// Cargar scenarios
const allScenarios = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'));
const scenarios = filter ? allScenarios.filter(s => s.name.toLowerCase().includes(filter.toLowerCase()) || s.agent === filter) : allScenarios;
console.log(`\n=== Tool-routing eval — ${scenarios.length} scenarios ===\n`);

let pass = 0, fail = 0;
const failures = [];
const t0 = Date.now();
let totalPromptTokens = 0, totalCompletionTokens = 0, totalCachedTokens = 0;

for (const sc of scenarios) {
    const c = cache[sc.agent];
    if (!c) {
        fail++;
        failures.push({ ...sc, error: `Agent "${sc.agent}" desconocido` });
        console.log(`✗ ${sc.name}  →  ERROR: agent "${sc.agent}" desconocido`);
        continue;
    }
    // Con prompt caching: system prompt es 100% estático, [CONTEXTO] va en el user message.
    const systemPrompt = renderPrompt(c.promptRaw, {});
    const userMessage = buildUserMessage({
        message: sc.message,
        convState: sc.convState,
        convContext: sc.convContext
    });

    let result;
    try {
        result = await callOpenAIWithTools({
            apiKey,
            model: 'gpt-4o-mini',
            systemPrompt,
            userMessage,
            tools: c.tools
        });
    } catch (e) {
        fail++;
        failures.push({ ...sc, error: e.message });
        console.log(`✗ ${sc.name}  →  ERROR: ${e.message.slice(0, 80)}`);
        continue;
    }

    if (result.usage) {
        totalPromptTokens += result.usage.prompt_tokens || 0;
        totalCompletionTokens += result.usage.completion_tokens || 0;
        // OpenAI reporta cached_tokens cuando hay cache hit (prefijo idéntico ≥ 1024 tokens).
        totalCachedTokens += result.usage.prompt_tokens_details?.cached_tokens || 0;
    }

    const calls = result.tool_calls.map(tc => tc.name);
    const firstTool = calls[0] || null;

    let ok = false;
    let why = '';
    if (sc.expected.first_tool) {
        ok = firstTool === sc.expected.first_tool;
        why = `expected first_tool=${sc.expected.first_tool}, got=${firstTool || 'NONE'}`;
    } else if (sc.expected.tools_include) {
        ok = sc.expected.tools_include.some(t => calls.includes(t));
        why = `expected one of [${sc.expected.tools_include.join(', ')}], got=[${calls.join(', ') || 'none'}]`;
    } else if (sc.expected.no_tool_calls) {
        ok = calls.length === 0;
        why = `expected no tool calls, got=[${calls.join(', ')}]`;
    } else {
        why = 'no expectation declared';
    }

    if (ok) {
        pass++;
        console.log(`✓ [${sc.agent}] ${sc.name}  →  ${calls.join(' → ') || '(reply directo)'}`);
    } else {
        fail++;
        failures.push({ ...sc, calls, content: result.content, why });
        console.log(`✗ [${sc.agent}] ${sc.name}  →  ${why}`);
    }
}

const dur = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== Resultado: ${pass} pass · ${fail} fail · ${dur}s ===`);
console.log(`Tokens: ${totalPromptTokens} prompt (${totalCachedTokens} cached) + ${totalCompletionTokens} completion`);
const cacheHitPct = totalPromptTokens > 0 ? (100 * totalCachedTokens / totalPromptTokens).toFixed(1) : '0';
console.log(`Cache hit rate: ${cacheHitPct}% del input (más alto = mejor)`);
// Pricing gpt-4o-mini: $0.15/1M input, $0.075/1M cached input, $0.60/1M output
const uncachedTokens = totalPromptTokens - totalCachedTokens;
const cost = (uncachedTokens * 0.15 + totalCachedTokens * 0.075 + totalCompletionTokens * 0.6) / 1_000_000;
console.log(`Costo aprox (gpt-4o-mini, con cache discount): $${cost.toFixed(4)}`);

if (failures.length) {
    console.log('\nFallos detallados:');
    failures.forEach(f => {
        console.log(`  - [${f.agent}] ${f.name}`);
        console.log(`    msg: ${f.message}`);
        if (f.convState) console.log(`    convState: ${f.convState}`);
        console.log(`    expected: ${JSON.stringify(f.expected)}`);
        if (f.calls) console.log(`    calls:    [${f.calls.join(', ')}]`);
        if (f.content) console.log(`    content:  ${f.content.slice(0, 120)}`);
        if (f.why) console.log(`    why:      ${f.why}`);
        if (f.error) console.log(`    error:    ${f.error}`);
    });
}

process.exit(fail ? 1 : 0);
