// Freezes protocol.json by hash BEFORE any return is computed. Local preregistration, not third-party.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const file = path.join(__dirname, 'protocol.json');
const buf = fs.readFileSync(file);
const out = path.join(__dirname, 'registration.json');
if (fs.existsSync(out)) { console.log('registration.json already exists: not overwritten'); process.exit(0); }
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), note: 'Local preregistration. Hash frozen BEFORE any return was computed.', files: { 'protocol.json': { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length } } }, null, 2));
console.log('registered');
