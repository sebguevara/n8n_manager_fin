// Test del Chefin Error Handler v3 — corre la JS de los Code nodes en
// aislamiento contra payloads variados que el errorTrigger podría entregar.
//
// Cubrimos:
//   - Diferentes shapes que distintas versiones de n8n usan para pasar
//     runData al error trigger.
//   - Errores que ocurren ANTES de tener webhook body (cron, errores tempranos).
//   - Mensajes de error de distintas categorías (timeout / postgres / genérico).
//   - Stack traces enormes (deben truncarse).
//   - Payloads malformados / vacíos / nulos.
//   - Escritura del log (mkdir -p, write OK, write failure).
//
// Lo que NO cubrimos (requiere n8n live):
//   - Que n8n efectivamente dispare el errorTrigger en una falla real.
//   - Que Evolution API entregue el mensaje al usuario.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'));
const WORKFLOW_PATH = path.resolve(ROOT, '../../workflows/chefin-error-v3.json');

const wf = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const extractNode = wf.nodes.find(n => n.name === 'Extract Error Context');
const writeNode   = wf.nodes.find(n => n.name === 'Write Error Log');

if (!extractNode || !writeNode) {
    console.error('Required nodes not found in workflow JSON');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Sandbox helpers — mimican $input.first().json y require() del Code node n8n
// ---------------------------------------------------------------------------
function runCode(jsCode, inputJson) {
    const $input = { first: () => ({ json: inputJson }) };
    // n8n permite require() en Code nodes; lo proveemos directo.
    const fn = new Function('$input', 'require', jsCode);
    return fn($input, (mod) => require(mod));
}

// Soporte para `require` en módulo ESM
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// CASOS — Extract Error Context
// ---------------------------------------------------------------------------
const sampleBody = {
    instance: 'chefin',
    data: {
        key: { id: 'msg-123', remoteJid: '5491112345678@s.whatsapp.net' },
        message: { conversation: 'gasté 5000 en comida' },
        messageType: 'conversation'
    }
};

const extractCases = [
    {
        name: 'Happy path — runData.Webhook con body completo',
        input: {
            execution: {
                id: 'exec-1', url: 'https://n8n.example/exec/1',
                lastNodeExecuted: 'Vision OCR', mode: 'webhook',
                error: { message: 'OpenAI 500', name: 'NodeOperationError', stack: 'Error: ...' }
            },
            workflow: { id: 'wf-1', name: 'Chefin Agent v3' },
            executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: sampleBody } }]] } }] } } }
        },
        expect: r => r.canReply === true && r.phone === '5491112345678' && r.instance === 'chefin' && r.userReply.length > 10
    },
    {
        name: 'runData en raíz (otra shape de n8n)',
        input: {
            execution: { id: 'exec-2', error: { message: 'ETIMEDOUT' } },
            workflow: { name: 'Chefin Agent v3' },
            runData: { 'Webhook': [{ data: { main: [[{ json: { body: sampleBody } }]] } }] }
        },
        expect: r => r.canReply === true && /conexión/i.test(r.userReply) // mensaje de timeout
    },
    {
        name: 'runData en execution.executionData (otra shape)',
        input: {
            execution: {
                id: 'exec-3', error: { message: 'relation "transactions" does not exist' },
                executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: sampleBody } }]] } }] } } }
            },
            workflow: { name: 'Chefin Agent v3' }
        },
        expect: r => r.canReply === true && /no pude guardar/i.test(r.userReply) // db error message
    },
    {
        name: 'Cron error — sin webhook, no podemos responder',
        input: {
            execution: { id: 'cron-1', error: { message: 'Postgres connection refused' } },
            workflow: { name: 'Chefin Cron v3 (consolidated)' }
        },
        expect: r => r.canReply === false && r.phone === '' && r.logEntry.error.message === 'Postgres connection refused'
    },
    {
        name: 'Body presente pero sin remoteJid (mensaje raro)',
        input: {
            execution: { id: 'exec-4', error: { message: 'something' } },
            workflow: { name: 'Chefin Agent v3' },
            executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: { instance: 'chefin', data: { key: {} } } } }]] } }] } } }
        },
        expect: r => r.canReply === false
    },
    {
        name: 'Audio message (sin text) — captura igual contexto',
        input: {
            execution: { id: 'exec-5', error: { message: 'Whisper API failed' } },
            workflow: { name: 'Chefin Agent v3' },
            executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: {
                instance: 'chefin',
                data: {
                    key: { id: 'audio-1', remoteJid: '5491198765432@s.whatsapp.net' },
                    message: { audioMessage: { /*...*/ } },
                    messageType: 'audioMessage'
                }
            } } }]] } }] } } }
        },
        expect: r => r.canReply === true && r.phone === '5491198765432' && r.logEntry.user.userText === ''
    },
    {
        name: 'Image message con caption — userText viene del caption',
        input: {
            execution: { id: 'exec-6', error: { message: 'OCR parse fail' } },
            workflow: { name: 'Chefin Agent v3' },
            executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: {
                instance: 'chefin',
                data: {
                    key: { id: 'img-1', remoteJid: '5491111111111@s.whatsapp.net' },
                    message: { imageMessage: { caption: 'pago de luz' } },
                    messageType: 'imageMessage'
                }
            } } }]] } }] } } }
        },
        expect: r => r.canReply === true && r.logEntry.user.userText === 'pago de luz'
    },
    {
        name: 'extendedTextMessage (link/forward de WA)',
        input: {
            execution: { id: 'exec-7', error: { message: 'fetch failed' } },
            workflow: { name: 'Chefin Agent v3' },
            executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: {
                instance: 'chefin',
                data: {
                    key: { id: 'fwd-1', remoteJid: '5491122222222@s.whatsapp.net' },
                    message: { extendedTextMessage: { text: 'mostrame los gastos del mes' } },
                    messageType: 'extendedTextMessage'
                }
            } } }]] } }] } } }
        },
        expect: r => r.logEntry.user.userText === 'mostrame los gastos del mes' && /conexión/i.test(r.userReply)
    },
    {
        name: 'Stack trace gigante — se trunca a 30 líneas',
        input: {
            execution: {
                id: 'exec-8',
                error: {
                    message: 'kaboom',
                    stack: 'Error: kaboom\n' + Array.from({ length: 200 }, (_, i) => `    at frame${i} (file:${i})`).join('\n')
                }
            },
            workflow: { name: 'Chefin Agent v3' }
        },
        expect: r => {
            const lines = r.logEntry.error.stack.split('\n');
            return lines.length === 30; // capped
        }
    },
    {
        name: 'Error message vacío / undefined — fallback al mensaje genérico',
        input: {
            execution: { id: 'exec-9', error: {} },
            workflow: { name: 'Chefin Agent v3' },
            executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: sampleBody } }]] } }] } } }
        },
        expect: r => r.canReply === true && /no pude resolver/i.test(r.userReply)
    },
    {
        name: 'userText muy largo — se trunca a 300 chars',
        input: {
            execution: { id: 'exec-10', error: { message: 'x' } },
            workflow: { name: 'Chefin Agent v3' },
            executionData: { resultData: { runData: { 'Webhook': [{ data: { main: [[{ json: { body: {
                instance: 'chefin',
                data: {
                    key: { id: 'long-1', remoteJid: '5491133333333@s.whatsapp.net' },
                    message: { conversation: 'a'.repeat(2000) },
                    messageType: 'conversation'
                }
            } } }]] } }] } } }
        },
        expect: r => r.logEntry.user.userText.length === 300
    },
    {
        name: 'Item completamente vacío — no debe explotar',
        input: {},
        expect: r => r.canReply === false && typeof r.userReply === 'string' && r.userReply.length > 0
    },
    {
        name: 'Item null-ish — no debe explotar',
        input: null,
        expect: r => r.canReply === false
    },
    {
        name: 'Webhook node nombrado "WhatsApp Webhook" (case insensitive)',
        input: {
            execution: { id: 'exec-11', error: { message: 'x' } },
            workflow: { name: 'Chefin Agent v3' },
            runData: { 'WhatsApp Webhook': [{ data: { main: [[{ json: { body: sampleBody } }]] } }] }
        },
        expect: r => r.canReply === true && r.phone === '5491112345678'
    }
];

// ---------------------------------------------------------------------------
// CASOS — Write Error Log
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chefin-err-test-'));

const writeCases = [
    {
        name: 'Escribe a /tmp (override LOG_DIR via require trick) — happy path',
        // Sustituimos /data/logs por TMP en el JS para poder testear localmente.
        codeTransform: code => code.replace("'/data/logs'", JSON.stringify(TMP)),
        input: {
            canReply: true, phone: '5491112345678', instance: 'chefin',
            userReply: 'reply',
            logEntry: { timestamp: '2026-04-30T10:00:00.000Z', error: { message: 'x' }, user: { phone: '5491112345678' } }
        },
        verify: () => {
            const file = path.join(TMP, 'errors-2026-04-30.jsonl');
            if (!fs.existsSync(file)) return 'log file not created';
            const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[lines.length - 1]);
            if (entry.error.message !== 'x') return 'log entry mismatch';
            return null;
        }
    },
    {
        name: 'Append múltiples entradas en el mismo día — todas persisten',
        codeTransform: code => code.replace("'/data/logs'", JSON.stringify(TMP)),
        input: {
            canReply: true,
            logEntry: { timestamp: '2026-04-30T11:00:00.000Z', error: { message: 'second' }, user: {} }
        },
        verify: () => {
            const file = path.join(TMP, 'errors-2026-04-30.jsonl');
            const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
            if (lines.length !== 2) return `expected 2 lines, got ${lines.length}`;
            const second = JSON.parse(lines[1]);
            if (second.error.message !== 'second') return 'second entry not appended';
            return null;
        }
    },
    {
        name: 'Día distinto — archivo nuevo',
        codeTransform: code => code.replace("'/data/logs'", JSON.stringify(TMP)),
        input: {
            canReply: false,
            logEntry: { timestamp: '2026-05-01T08:00:00.000Z', error: { message: 'tomorrow' }, user: {} }
        },
        verify: () => {
            const file = path.join(TMP, 'errors-2026-05-01.jsonl');
            if (!fs.existsSync(file)) return 'second-day file not created';
            return null;
        }
    },
    {
        name: 'logEntry sin timestamp — usa now() y no explota',
        codeTransform: code => code.replace("'/data/logs'", JSON.stringify(TMP)),
        input: { canReply: false, logEntry: { error: { message: 'no-ts' }, user: {} } },
        verify: r => {
            // Acepta cualquier nombre errors-YYYY-MM-DD.jsonl que se haya creado hoy
            const today = new Date().toISOString().slice(0, 10);
            const file = path.join(TMP, `errors-${today}.jsonl`);
            return fs.existsSync(file) ? null : 'today file not created';
        }
    },
    {
        name: 'Carpeta no existe — la crea (mkdir recursive)',
        codeTransform: code => code.replace("'/data/logs'", JSON.stringify(path.join(TMP, 'nested', 'deep'))),
        input: {
            canReply: false,
            logEntry: { timestamp: '2026-04-30T12:00:00.000Z', error: { message: 'nested' }, user: {} }
        },
        verify: () => {
            const file = path.join(TMP, 'nested', 'deep', 'errors-2026-04-30.jsonl');
            return fs.existsSync(file) ? null : 'nested log file not created';
        }
    },
    {
        name: 'Write a path inválido — NO explota (silently skips, deja pasar item)',
        // path con caracter inválido en Windows / null byte en Linux
        codeTransform: code => code.replace("'/data/logs'", JSON.stringify(' /invalid/path')),
        input: {
            canReply: true, phone: '5491112345678', instance: 'chefin', userReply: 'still works',
            logEntry: { timestamp: '2026-04-30T13:00:00.000Z', error: { message: 'fs-fail' }, user: {} }
        },
        verify: r => {
            // El node debe pasar el item adelante igual (item original + logFile)
            if (!r) return 'no return value';
            if (r.canReply !== true) return 'canReply lost';
            if (r.userReply !== 'still works') return 'userReply lost';
            return null;
        }
    }
];

// ---------------------------------------------------------------------------
// EJECUCIÓN
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;

console.log('=== Extract Error Context ===');
for (const c of extractCases) {
    let result, err;
    try {
        const out = runCode(extractNode.parameters.jsCode, c.input);
        result = (Array.isArray(out) && out[0] ? out[0].json : undefined);
    } catch (e) { err = e; }

    if (err) {
        console.log(`✗ ${c.name}\n    THREW: ${err.message}`);
        fail++; continue;
    }
    let okExpect;
    try { okExpect = c.expect(result); } catch (e) { okExpect = false; err = e; }

    if (okExpect) {
        console.log(`✓ ${c.name}`);
        pass++;
    } else {
        console.log(`✗ ${c.name}`);
        console.log(`    got: ${JSON.stringify(result, null, 2).slice(0, 400)}`);
        if (err) console.log(`    in expect: ${err.message}`);
        fail++;
    }
}

console.log('\n=== Write Error Log ===');
for (const c of writeCases) {
    let returned, err;
    try {
        const code = c.codeTransform ? c.codeTransform(writeNode.parameters.jsCode) : writeNode.parameters.jsCode;
        const out = runCode(code, c.input);
        returned = (Array.isArray(out) && out[0] ? out[0].json : undefined);
    } catch (e) { err = e; }

    if (err) {
        console.log(`✗ ${c.name}\n    THREW: ${err.message}`);
        fail++; continue;
    }
    const verifyErr = c.verify(returned);
    if (verifyErr) {
        console.log(`✗ ${c.name}\n    ${verifyErr}`);
        fail++;
    } else {
        console.log(`✓ ${c.name}`);
        pass++;
    }
}

// Cleanup tmp dir
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
