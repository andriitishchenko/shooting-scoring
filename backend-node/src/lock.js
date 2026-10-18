import fs from "node:fs";
import path from "node:path";

const held = new Set(); // data folders that this process locks

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function read(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(owner?.pid) && Number.isFinite(owner?.time) ? owner : null;
  } catch {
    return null;
  }
}

// One server process owns a data folder. The lock file has the process id of
// the owner and a time. The owner writes the time again every few seconds.
// A lock is stale, and the next start takes it at once, when:
//   - the file is empty, damaged, or in an old format,
//   - the process does not run any more (a crash, a stop, a restart of the computer), or
//   - the time is old or far in the future. A new program can use the process id.
// So nobody needs to delete the file. A lock of a running server with a fresh
// time is real. The start waits a short time for that server to stop.
export async function acquireLock(dir, { waitMs = 5000, staleMs = 15_000, heartbeatMs = 5000 } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folder = path.resolve(dir);
  if (held.has(folder)) throw new Error(`This process already uses the data directory ${dir}.`);
  const file = path.join(folder, ".server.lock");
  const write = (flag) =>
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, time: Date.now() }), { flag, mode: 0o600 });
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      write("wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const owner = read(file);
    const stale =
      !owner ||
      owner.pid === process.pid ||
      !alive(owner.pid) ||
      Math.abs(Date.now() - owner.time) > staleMs;
    if (stale) {
      // Delete the file only when nobody changed it since we read it.
      const now = read(file);
      if (!now || (now.pid === owner?.pid && now.time === owner?.time)) fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `Another server (process ${owner.pid}) uses the data directory ${dir}. ` +
          "Stop it. If no server runs, wait 15 seconds and start again.",
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  held.add(folder);
  const timer = setInterval(() => {
    try {
      const owner = read(file);
      // Write the time again. Write the file when it is gone. Do not take it from another server.
      if (!owner || owner.pid === process.pid) write("w");
    } catch {
      // The next beat tries again.
    }
  }, heartbeatMs);
  timer.unref();

  return {
    timer,
    release() {
      clearInterval(timer);
      held.delete(folder);
      try {
        if (read(file)?.pid === process.pid) fs.rmSync(file);
      } catch {
        // The file is already gone.
      }
    },
  };
}
