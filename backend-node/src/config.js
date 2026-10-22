import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const projectRoot = path.resolve(serviceRoot, "..");

function integer(source, name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(source[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function list(source, name) {
  let value;
  try {
    value = JSON.parse(source[name] || "[]");
  } catch {
    value = null;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be a JSON array of strings`);
  return value;
}

// The browser pages use no inline script and no outside resource. `style-src`
// allows inline styles, because some elements have a style attribute.
export const defaultPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The separate Flutter page uses WebAssembly and local image blobs.
export const scoringPolicy = defaultPolicy
  .replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")
  .replace("img-src 'self' data:", "img-src 'self' data: blob:")
  .replace("connect-src 'self' ws: wss:", "connect-src 'self' ws: wss: https://fonts.gstatic.com")
  + "; font-src 'self' data: https://fonts.gstatic.com; worker-src 'self' blob:";

// Read the settings from the environment and from `.env` in the service folder.
// An environment variable has priority over `.env`. `overrides` has priority over both.
export function loadConfig(overrides = {}, env = process.env) {
  const file = path.join(serviceRoot, ".env");
  const source = { ...(fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {}), ...env };
  const origins = overrides.origins ?? list(source, "ALLOWED_ORIGINS");
  if (origins.includes("*"))
    throw new Error("ALLOWED_ORIGINS must list explicit origins; wildcard CORS is disabled");
  const levels = ["error", "warn", "info", "debug"];
  const logLevel = overrides.logLevel ?? source.LOG_LEVEL ?? "info";
  if (!levels.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${levels.join(", ")}`);
  const config = {
    host: source.HOST || source.IP || "0.0.0.0",
    port: integer(source, "PORT", 8000, 0, 65535),
    dataDir: path.resolve(source.DATA_DIR || path.join(serviceRoot, "data")),
    frontendDir: path.join(projectRoot, "frontend"),
    trustedProxies: list(source, "TRUSTED_PROXIES"),
    maxBodyBytes: integer(source, "MAX_BODY_BYTES", 256 * 1024, 1024),
    importBodyBytes: integer(source, "IMPORT_BODY_BYTES", 2 * 1024 * 1024, 1024),
    loginFailureLimit: integer(source, "LOGIN_FAILURE_LIMIT", 100, 1),
    eventCreateLimit: integer(source, "EVENT_CREATE_LIMIT", 60, 0),
    sessionDays: integer(source, "SESSION_DAYS", 14, 1, 365),
    passwordCost: integer(source, "PASSWORD_COST", 15, 10, 20),
    maxSockets: integer(source, "MAX_SOCKETS", 5000, 1),
    openDatabases: integer(source, "OPEN_DATABASES", 32, 1),
    databaseIdleMs: 60_000,
    heartbeatMs: 30_000,
    authTimeoutMs: 10_000,
    staticRecheckMs: 1000,
    contentSecurityPolicy:
      source.CONTENT_SECURITY_POLICY === undefined
        ? defaultPolicy
        : source.CONTENT_SECURITY_POLICY === "off"
          ? ""
          : source.CONTENT_SECURITY_POLICY,
    resetTtlMs: integer(source, "LANE_RESET_MINUTES", 15, 1) * 60_000,
    hashQueue: integer(source, "HASH_QUEUE", 50, 1),
    lockWaitMs: integer(source, "LOCK_WAIT_MS", 5000, 0),
    lockStaleMs: 15_000,
    lockBeatMs: 5000,
    logLevel,
    ...overrides,
    origins,
  };
  return Object.freeze(config);
}

// Addresses to show at start: the local address and each network address.
export function listenUrls(host, port) {
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}`];
  const urls = [`http://localhost:${port}`];
  for (const addresses of Object.values(os.networkInterfaces()))
    for (const entry of addresses ?? [])
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${port}`);
  return urls;
}
