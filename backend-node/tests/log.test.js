import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/log.js";

function sinkOf() {
  const lines = [];
  return { lines, error: (line) => lines.push(["error", line]), warn: (line) => lines.push(["warn", line]), log: (line) => lines.push(["log", line]) };
}

test("the logger writes only the levels that the setting allows", () => {
  const sink = sinkOf();
  const log = createLogger("warn", sink);
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assert.deepEqual(sink.lines.map(([method]) => method), ["warn", "error"]);
  const all = sinkOf();
  const verbose = createLogger("debug", all);
  verbose.debug("d");
  verbose.info("i");
  assert.deepEqual(all.lines.map(([method]) => method), ["log", "log"]);
});

test("a log line has the time, the level, the message, and the detail", () => {
  const sink = sinkOf();
  const log = createLogger("info", sink);
  log.info("started", { port: 8000 });
  log.error("failed", new Error("boom"));
  log.warn("plain");
  assert.match(sink.lines[0][1], /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO started \{"port":8000\}$/);
  assert.match(sink.lines[1][1], /^\S+ ERROR failed Error: boom\n\s+at /);
  assert.match(sink.lines[2][1], /^\S+ WARN plain$/);
});
