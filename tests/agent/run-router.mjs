#!/usr/bin/env node
// Eval harness: clasifica scenarios contra el ROUTER_PROMPT y compara con expected.intent.
//
// Uso:
//   OPENAI_API_KEY=sk-... node tests/agent/run-router.mjs
//   OPENAI_API_KEY=sk-... node tests/agent/run-router.mjs --filter chitchat
//
// El prompt se lee directamente del workflow JSON construido (chefin-agent-v3.json),
// para garantizar que testeamos el prompt EFECTIVO, no una copia paralela.

import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflow, getSystemPrompt, renderPrompt, buildUserMessage } from './workflow-utils.mjs';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'));
const SCENARIO_DIR = path.join(ROOT, 'scenarios');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY no está seteada');
    process.exit(2);
}

const args = process.argv.slice(2);
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;

const wf = loadWorkflow();
// El system prompt del Router ahora es 100% estático (sin {{...}}). Igual aplicamos
// renderPrompt por compat con flujos viejos.
const routerPrompt = renderPrompt(getSystemPrompt(wf, 'Router'), {});

// ---------- 2. Cargar scenarios ----------
const scenarioFiles = fs.readdirSync(SCENARIO_DIR).filter(f => f.endsWith('.json')).sort();
const scenarios = [];
for (const f of scenarioFiles) {
    const arr = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf8'));
    arr.forEach(s => scenarios.push({ ...s, _file: f }));
}

const filtered = filter ? scenarios.filter(s => s.name.toLowerCase().includes(filter.toLowerCase())) : scenarios;
console.log(`\n=== Router eval — ${filtered.length} scenarios ===\n`);

// ---------- 3. Llamar a OpenAI por cada scenario ----------
async function classify(systemPrompt, userMessage) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ]
        })
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI ${res.status}: ${text}`);
    }
    const data = await res.json();
    const raw = data.choices[0]?.message?.content || '{}';
    try {
        return JSON.parse(raw);
    } catch {
        return { intent: 'parse_error', raw };
    }
}

let pass = 0, fail = 0;
const failures = [];
const t0 = Date.now();

for (const sc of filtered) {
    const userMessage = buildUserMessage({
        message: sc.message,
        convState: sc.convState,
        convContext: sc.convContext,
        onboarded: true
    });
    let result;
    try {
        result = await classify(routerPrompt, userMessage);
    } catch (e) {
        fail++;
        failures.push({ ...sc, error: e.message });
        console.log(`✗ ${sc.name}  →  ERROR: ${e.message}`);
        continue;
    }
    const expectedIntent = sc.expected.intent;
    const actualIntent = result.intent;
    const ok = expectedIntent === actualIntent;
    if (ok) {
        pass++;
        console.log(`✓ ${sc.name}  →  ${actualIntent}`);
    } else {
        fail++;
        failures.push({ ...sc, actual: result });
        console.log(`✗ ${sc.name}  →  expected=${expectedIntent}, got=${actualIntent}${result.reply_text ? `  [reply="${result.reply_text.slice(0,60)}"]` : ''}`);
    }
}

const dur = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== Resultado: ${pass} pass · ${fail} fail · ${dur}s ===`);

if (failures.length) {
    console.log('\nFallos detallados:');
    failures.forEach(f => {
        console.log(`  - [${f._file}] ${f.name}`);
        console.log(`    msg: ${f.message}`);
        if (f.convState) console.log(`    convState: ${f.convState}`);
        console.log(`    expected: ${f.expected.intent}`);
        console.log(`    actual:   ${f.actual?.intent || 'ERROR'}`);
        if (f.actual?.reply_text) console.log(`    reply:    ${f.actual.reply_text.slice(0, 100)}`);
    });
}

process.exit(fail ? 1 : 0);
