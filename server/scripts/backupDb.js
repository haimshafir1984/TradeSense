// Consistent online backup of the autopilot SQLite database (safe while the server is running).
// Usage: node scripts/backupDb.js <output-file> [source-file] [--compact]
// --compact also VACUUMs the copy (not the live database), dropping free pages after a large prune.
// The source defaults to AUTOPILOT_DB_PATH, then to the same location the server would choose.
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync, backup } = require("node:sqlite");

async function main() {
  const args = process.argv.slice(2);
  const compact = args.includes("--compact");
  const [outArg, sourceArg] = args.filter((arg) => arg !== "--compact");
  if (!outArg) {
    console.error("Usage: node scripts/backupDb.js <output-file> [source-file] [--compact]");
    process.exit(2);
  }
  const store = require("../src/autopilot/store");
  const source = path.resolve(sourceArg || store.resolveDatabaseFile());
  const target = path.resolve(outArg);
  if (!fs.existsSync(source)) throw new Error(`Source database not found: ${source}`);
  if (source === target) throw new Error("Output file must differ from the source database");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  fs.rmSync(partial, { force: true });
  const db = new DatabaseSync(source);
  try {
    await backup(db, partial);
  } finally {
    db.close();
  }
  const check = new DatabaseSync(partial);
  try {
    if (compact) check.exec("VACUUM;");
    const result = check.prepare("PRAGMA integrity_check").get();
    if (Object.values(result)[0] !== "ok") throw new Error(`Backup failed integrity check: ${JSON.stringify(result)}`);
  } finally {
    check.close();
  }
  fs.renameSync(partial, target);
  console.log(`Backup written to ${target} (${(fs.statSync(target).size / 1048576).toFixed(2)} MB) from ${source}`);
}

main().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
});
