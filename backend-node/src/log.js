const levels = { error: 0, warn: 1, info: 2, debug: 3 };

// A small logger. A sink is an object with the methods `error`, `warn`, `log`.
export function createLogger(level = "info", sink = console) {
  const limit = levels[level];
  const write = (name, method) => (message, detail) => {
    if (levels[name] > limit) return;
    const time = new Date().toISOString();
    const extra =
      detail instanceof Error ? ` ${detail.stack ?? detail.message}` : detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
    sink[method](`${time} ${name.toUpperCase()} ${message}${extra}`);
  };
  return {
    error: write("error", "error"),
    warn: write("warn", "warn"),
    info: write("info", "log"),
    debug: write("debug", "log"),
  };
}
