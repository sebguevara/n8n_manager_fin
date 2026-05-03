// Test del Chunk Reply node — corre el JS de chunking en aislamiento
// con casos de input variados para validar la lógica multi-mensaje.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'));
const WORKFLOW_PATH = path.resolve(ROOT, '../../workflows/chefin-agent-v3.json');

const wf = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const node = wf.nodes.find(n => n.name === 'Chunk Reply');
if (!node) {
    console.error('Node "Chunk Reply" no encontrado');
    process.exit(1);
}

// El código del node usa $input.first().json. Lo wrapeamos en un sandbox simple.
const code = node.parameters.jsCode;

function runChunker(replyText, extra = {}) {
    const ctx = { replyText, replyKind: 'text', shouldReact: false, reactionEmoji: '', ...extra };
    const $input = { first: () => ({ json: ctx }) };
    const fn = new Function('$input', code);
    return fn($input);
}

const cases = [
    {
        name: 'Mensaje corto, una sola sección → 1 chunk',
        input: '✅ Anotado: $2.500 en Comida — café',
        expectChunks: 1
    },
    {
        name: 'Mensaje corto con 2 párrafos pero <350 chars → 1 chunk (no spammeamos)',
        input: '✅ Anotado: $2.500 en Comida.\n\n¿Querés ver el total del mes?',
        expectChunks: 1
    },
    {
        name: 'Mensaje multi-sección largo (>350 chars, 3 párrafos) → 3 chunks',
        input: '📊 Resumen de abril: gastaste $120.000 en 23 movimientos. Tu categoría más alta fue Comida con $45.000 (38% del total).\n\n💡 Subiste un 22% comparado con marzo. La causa principal son los gastos de Salidas que pasaron de $8k a $18k. Cuidá ese rubro la primera quincena de mayo si querés mantener el promedio.\n\n¿Querés que te grafique el desglose por categoría o preferís que te arme un breakdown por día?',
        expectChunks: 3
    },
    {
        name: 'Marcador [SPLIT] explícito → respeta los cortes',
        input: 'Primera parte importante.\n[SPLIT]\nSegunda parte.\n[SPLIT]\nTercera parte.',
        expectChunks: 3
    },
    {
        name: 'Mensaje SIN [SPLIT], 2 párrafos largos (>350) → 2 chunks',
        input: 'Esta es la primera sección con bastante contenido como para que valga la pena partirla. Tiene varias oraciones para asegurar que supere el threshold mínimo y dispare el split por bloques.\n\nEsta es la segunda sección, también con varias oraciones que justifican mandarla aparte. El bot va a sentir más natural si llega como mensaje separado en WhatsApp.',
        expectChunks: 2
    },
    {
        name: 'Mensaje >1500 sin párrafos → corte duro',
        input: 'a'.repeat(2500),
        expectChunks: 2
    },
    {
        name: 'Lista numerada (un solo bloque) NO se parte aunque sea largo',
        input: 'Estos son los últimos 5 movimientos:\n1. 2026-04-29 · 💸 comida · $2.500 — café\n2. 2026-04-28 · 🚗 transporte · $5.000 — uber\n3. 2026-04-27 · 🛒 supermercado · $15.000 — compra mensual\n4. 2026-04-26 · 💸 comida · $3.500 — almuerzo\n5. 2026-04-25 · 🎬 entretenimiento · $4.000 — cine',
        expectChunks: 1
    },
    {
        name: 'Lista + pregunta SIN superar 350 chars → 1 chunk (no spammy)',
        input: 'Últimos 3 movs:\n1. 2026-04-29 · 💸 comida · $2.500 — café\n2. 2026-04-28 · 🚗 transporte · $5.000 — uber\n3. 2026-04-27 · 🛒 supermercado · $15.000 — compra mensual\n\n¿Cuál querés borrar?',
        expectChunks: 1
    },
    {
        name: 'Lista + análisis + pregunta (>350 chars, 3 paras) → 3 chunks',
        input: 'Últimos 5 movs del mes:\n1. 2026-04-29 · 💸 comida · $2.500 — café del día\n2. 2026-04-28 · 🚗 transporte · $5.000 — uber al centro\n3. 2026-04-27 · 🛒 supermercado · $15.000 — compra mensual del mes\n4. 2026-04-26 · 🎬 entretenimiento · $4.000 — cine con amigos\n5. 2026-04-25 · 💸 comida · $3.500 — almuerzo en oficina\n\n💡 Total de los 5: $30.000. Predomina supermercado y comida (60% del subtotal). Si querés cuidar el mes, ojo con los almuerzos sueltos.\n\n¿Cuál querés borrar o editar? Decime el número.',
        expectChunks: 3
    },
    {
        name: 'Vacío → 1 chunk con fallback',
        input: '',
        expectChunks: 1
    },
    {
        // 🐛 REGRESSION: el agente respondía "Aquí están tus categorías:\n\n1. ...\n2. ..."
        // y el chunker viejo partía en chunk[0]="Aquí están tus categorías:" + chunk[1]=lista.
        // Combinado con el bug de Send Text usando $('Save Context').first(), llegaba SOLO
        // el intro y la lista se perdía. El chunker ahora MERGEA intro+lista en un bloque
        // (mismo chunk) cuando el primer párrafo es corto y termina en ":".
        name: 'Lista con intro corto que termina en ":" + lista numerada → 1 chunk (no separar)',
        input: 'Aquí están tus categorías:\n\n1. ☕ Café\n2. 🍽️ Comida\n3. 📚 Educación\n4. 🏠 Hogar\n5. 🧾 Impuestos\n6. 🐾 Mascotas\n7. 🎬 Ocio\n8. 📦 Otros\n9. 🎁 Regalos\n10. 👕 Ropa\n11. 🏥 Salud\n12. 💡 Servicios\n13. 🛒 Supermercado\n14. 📺 Suscripciones\n15. 🚗 Transporte\n16. ✈️ Viajes',
        expectChunks: 1
    },
    {
        name: 'Lista con bullets (-) e intro → 1 chunk (no separar)',
        input: 'Tus recurrentes activas:\n\n- Netflix · $5.500 · próx 15/05\n- Spotify · $3.200 · próx 20/05\n- Alquiler · $340.000 · próx 01/05\n- Internet · $9.000 · próx 03/05\n- Gimnasio · $7.800 · próx 10/05\n- Telefonía · $4.200 · próx 12/05',
        expectChunks: 1
    },
    {
        // 🐛 REGRESSION: categorías reales usan emojis arbitrarios (🛒🚗🏥💊...)
        // que no estaban en la lista hardcodeada del antiguo startsWithList.
        // El merge fallaba y el usuario veía solo "Aquí están tus categorías:".
        name: 'Lista con intro + items que arrancan con emojis arbitrarios (sin numerar) → 1 chunk',
        input: 'Aquí están tus categorías:\n\n🛒 Supermercado\n🚗 Transporte\n🏥 Salud\n💊 Farmacia\n⚽ Deporte\n🎮 Gaming\n🐾 Mascotas\n🏠 Hogar\n👕 Ropa\n💡 Servicios\n📺 Suscripciones\n✈️ Viajes\n🎁 Regalos\n📚 Educación',
        expectChunks: 1
    }
];

let pass = 0, fail = 0;
console.log(`\n=== Chunker tests — ${cases.length} casos ===\n`);

for (const c of cases) {
    const out = runChunker(c.input);
    const got = out.length;
    const ok = got === c.expectChunks;
    if (ok) {
        pass++;
        console.log(`✓ ${c.name}  (${got} chunks)`);
    } else {
        fail++;
        console.log(`✗ ${c.name}  expected=${c.expectChunks}, got=${got}`);
        out.forEach((p, i) => console.log(`    [${i}] (${p.json.replyText.length} chars): ${p.json.replyText.slice(0, 80).replace(/\n/g, '⏎')}${p.json.replyText.length > 80 ? '...' : ''}`));
    }
}

console.log(`\n=== ${pass} pass · ${fail} fail ===`);
process.exit(fail ? 1 : 0);
