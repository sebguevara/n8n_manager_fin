// Replaces workflow id placeholders en los JSONs ya buildeados con los ids
// reales que asignó n8n al importarlos.
//
// Placeholders soportados:
//   __TOOLS_WF_ID__   → id del sub-workflow chefin-tools-v3 (en agent JSON)
//   __ERROR_WF_ID__   → id del error handler chefin-error-v3 (en agent + cron)
//
// Usage:
//   node apply-tools-id.js --tools <ID> [--error <ID>]
//
// Backwards-compat: si se pasa un único arg posicional (sin flag) se asume
// que es el id del sub-workflow de tools, como en la versión vieja.

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const out = { tools: '', error: '' };
    const args = argv.slice(2);
    if (args.length === 1 && !args[0].startsWith('--')) {
        out.tools = args[0];
        return out;
    }
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--tools') out.tools = args[++i] || '';
        else if (args[i] === '--error') out.error = args[++i] || '';
    }
    return out;
}

const { tools, error } = parseArgs(process.argv);
if (!tools && !error) {
    console.error('Usage: node apply-tools-id.js --tools <TOOLS_ID> [--error <ERROR_ID>]');
    console.error('       node apply-tools-id.js <TOOLS_ID>   # legacy form');
    process.exit(1);
}

const targets = [
    { file: 'workflows/chefin-agent-v3.json', placeholder: '__TOOLS_WF_ID__', value: tools },
    { file: 'workflows/chefin-agent-v3.json', placeholder: '__ERROR_WF_ID__', value: error },
    { file: 'workflows/chefin-cron-v3.json',  placeholder: '__ERROR_WF_ID__', value: error }
];

for (const { file, placeholder, value } of targets) {
    if (!value) continue;
    const abs = path.join(__dirname, file);
    if (!fs.existsSync(abs)) {
        console.error(`[apply-tools-id] file not found: ${file} — skipping`);
        continue;
    }
    let txt = fs.readFileSync(abs, 'utf8');
    const matches = (txt.match(new RegExp(placeholder, 'g')) || []).length;
    if (matches === 0) {
        console.log(`[apply-tools-id] ${placeholder} not present in ${file} (already replaced?)`);
        continue;
    }
    txt = txt.split(placeholder).join(value);
    fs.writeFileSync(abs, txt);
    console.log(`[apply-tools-id] replaced ${matches}× ${placeholder} → "${value}" in ${file}`);
}
