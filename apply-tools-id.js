// Replaces __TOOLS_WF_ID__ placeholders in chefin-agent-v3.json with the
// actual id of the imported chefin-tools-v3 sub-workflow.
//
// Usage:
//   node apply-tools-id.js <SUBWORKFLOW_ID>

const fs = require('fs');
const path = require('path');

const id = process.argv[2];
if (!id) {
    console.error('Usage: node apply-tools-id.js <SUBWORKFLOW_ID>');
    console.error('  After importing chefin-tools-v3.json into n8n, copy the workflow id');
    console.error('  from the URL bar (https://your-n8n/workflow/<ID>).');
    process.exit(1);
}

const file = path.join(__dirname, 'workflows', 'chefin-agent-v3.json');
let txt = fs.readFileSync(file, 'utf8');
const before = (txt.match(/__TOOLS_WF_ID__/g) || []).length;
txt = txt.replace(/__TOOLS_WF_ID__/g, id);
fs.writeFileSync(file, txt);
console.log(`Replaced ${before} placeholder(s) with id "${id}" in ${file}`);
