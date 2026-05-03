// Borra los JSON de workflow generados antes de regenerarlos. Lo corremos como
// `prebuild` para que `npm run build` siempre arranque desde estado limpio:
// si en el futuro se renombra un workflow o se elimina uno, no queda el JSON
// viejo en `workflows/` confundiendo al deploy.
//
// Solo toca los 4 outputs conocidos — NO borra la carpeta entera por si el
// usuario tiene archivos manuales ahí.

const fs = require('fs');
const path = require('path');

const FILES = [
    'workflows/chefin-tools-v3.json',
    'workflows/chefin-error-v3.json',
    'workflows/chefin-agent-v3.json',
    'workflows/chefin-cron-v3.json'
];

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });

for (const rel of FILES) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        console.log(`[clean] removed ${rel}`);
    }
}
