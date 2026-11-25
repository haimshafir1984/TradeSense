// Freezes protocol.json by hash BEFORE any data download or return. Local preregistration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const out = path.join(__dirname, 'registration.json');
if (fs.existsSync(out)) { console.log('registration.json already exists: not overwritten'); process.exit(0); }
const buf = fs.readFileSync(path.join(__dirname, 'protocol.json'));
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), note: 'Local preregistration. Hash frozen BEFORE any data download or return.', files: { 'protocol.json': { sha256: crypto.createHash('sha256').update(buf).digest('hex') } } }, null, 2));
console.log('registered');
