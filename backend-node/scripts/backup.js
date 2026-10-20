// Make a consistent copy of event databases. The server can run during the copy.
// Usage: node scripts/backup.js <destination-folder> [EVENT_CODE ...]
// Without event codes, the script copies all events.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { loadConfig } from "../src/config.js";

const [destination, ...codes] = process.argv.slice(2);
if (!destination) {
  console.error("Usage: node scripts/backup.js <destination-folder> [EVENT_CODE ...]");
  process.exit(2);
}
const { dataDir } = loadConfig();
const wanted = codes.length
  ? codes.map((code) => `${code.toUpperCase()}.db`)
  : fs.readdirSync(dataDir).filter((name) => /^[A-Z0-9]{1,16}\.db$/.test(name));
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

let failed = 0;
for (const name of wanted) {
  const source = path.join(dataDir, name);
  if (!fs.existsSync(source)) {
    console.error(`${name}: not found in ${dataDir}`);
    failed++;
    continue;
  }
  const database = new DatabaseSync(source);
  try {
    const target = path.join(destination, name);
    await backup(database, target);
    fs.chmodSync(target, 0o600); // The copy has the lane passwords in the clear.
    console.log(`${name}: copied`);
  } catch (error) {
    console.error(`${name}: ${error.message}`);
    failed++;
  } finally {
    database.close();
  }
}
console.log(`${wanted.length - failed} of ${wanted.length} copied to ${path.resolve(destination)}`);
process.exit(failed ? 1 : 0);
