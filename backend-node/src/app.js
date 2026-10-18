import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { HttpError, fail } from "./errors.js";
import { loadConfig, serviceRoot } from "./config.js";
import { createLogger } from "./log.js";
import { acquireLock } from "./lock.js";
import { DatabasePool } from "./db/pool.js";
import { createPasswordHasher } from "./security/passwords.js";
import { createLoginThrottle, createRateLimiter } from "./security/throttle.js";
import { createSessions } from "./domain/sessions.js";
import { createLaneResets } from "./domain/resets.js";
import { clientAddress } from "./http/address.js";
import { readJson } from "./http/body.js";
import { cors } from "./http/cors.js";
import { createStatic } from "./http/static.js";
import { parseParam, validate } from "./http/validate.js";
import { buildRoutes, numberParams } from "./routes.js";
import { attachWebSockets, createHub } from "./ws/hub.js";

const version = JSON.parse(fs.readFileSync(path.join(serviceRoot, "package.json"), "utf8")).version;

function qrScriptFolder() {
  return path.dirname(createRequire(import.meta.url).resolve("qrcode-generator"));
}

// Build the server. The result has `listen()` and `close()`. Nothing runs before `listen()`.
export function createApp(overrides = {}) {
  const { log: customLog, ...settings } = overrides;
  const config = loadConfig(settings);
  const log = customLog ?? createLogger(config.logLevel);

  const hub = createHub({ log });
  const pool = new DatabasePool({
    dir: config.dataDir,
    max: config.openDatabases,
    idleMs: config.databaseIdleMs,
    publish: hub.publish,
    revoke: hub.revoke,
    log,
  });
  const hasher = createPasswordHasher({ cost: config.passwordCost, maxQueue: config.hashQueue });
  const throttle = createLoginThrottle({ addressLimit: config.loginFailureLimit });
  const sessions = createSessions({ hasher, throttle, sessionDays: config.sessionDays });
  const resets = createLaneResets({ sessions, hasher, throttle, ttlMs: config.resetTtlMs });
  const creations = createRateLimiter({ max: config.eventCreateLimit });
  const router = buildRoutes({ pool, hasher, sessions, resets, creations, config, version });
  const serveStatic = createStatic([
    { prefix: "/", dir: config.frontendDir },
    { prefix: "/vendor/", dir: qrScriptFolder(), files: new Set(["qrcode.js"]) },
  ], { recheckMs: config.staticRecheckMs });

  const send = (res, status, value, headers = {}) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  };

  // Handle one API request: check the numbers, read the body, open the event, check the session.
  async function api(req, res, url) {
    const found = router.match(req.method, url.pathname);
    if (!found) fail(404, "Not Found");
    const { route } = found;
    const params = {};
    for (const [name, raw] of Object.entries(found.params)) {
      let value;
      try {
        value = decodeURIComponent(raw);
      } catch {
        fail(404, "Not Found");
      }
      params[name] = name in numberParams ? parseParam(name, value, "path", numberParams[name]) : value;
    }
    const query = {};
    for (const [name, limits] of Object.entries(route.query ?? {})) {
      const values = url.searchParams.getAll(name);
      if (values.length) query[name] = parseParam(name, values.at(-1), "query", limits);
    }
    let body;
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const raw = await readJson(req, route.limit ?? config.maxBodyBytes);
      if (route.body) {
        if (raw === undefined && route.emptyBody === undefined)
          fail(422, [{ loc: ["body"], msg: "Field required" }]);
        body = validate(route.body, raw === undefined ? route.emptyBody : raw, ["body"]);
      }
    }
    const db = params.code === undefined ? undefined : pool.get(params.code);
    // The handler can wait (a password check). The pool must not close the database meanwhile.
    db?.pin();
    try {
      const token = req.headers["x-session-id"];
      const auth = db && route.auth !== "none" ? sessions.authenticate(db, token) : null;
      if (route.auth === "host") sessions.requireRole(auth, token, "host");
      const result = await route.handler({
        db,
        params,
        query,
        body,
        auth,
        token,
        address: clientAddress(req, config.trustedProxies),
      });
      send(res, 200, result);
    } finally {
      db?.unpin();
    }
  }

  async function handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (config.contentSecurityPolicy) res.setHeader("Content-Security-Policy", config.contentSecurityPolicy);
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, { detail: "Bad Request" });
    }
    if (cors(req, res, config.origins)) return;
    const started = performance.now();
    res.on("finish", () =>
      log.debug(`${req.method} ${url.pathname} ${res.statusCode} ${(performance.now() - started).toFixed(1)}ms`),
    );
    try {
      if (url.pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        await api(req, res, url);
      } else if (!(await serveStatic(req, res, url.pathname))) fail(404, "Not Found");
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) send(res, error.status, { detail: error.detail }, error.headers);
      else if (error?.code === "ECONNRESET" || error?.message === "aborted") res.destroy();
      else {
        log.error(`Request failed: ${req.method} ${url.pathname}`, error);
        send(res, 500, { detail: "Internal Server Error" });
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.error("Unhandled request error", error);
      res.destroy();
    });
  });
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 75_000;
  const closeSockets = attachWebSockets(server, { hub, pool, sessions, config, log });

  let lock = null;
  return {
    server,
    config,
    pool,
    hub,
    resets,
    version,
    // Take the data directory and listen. Return the port.
    async listen(port = config.port, host = config.host) {
      lock = await acquireLock(config.dataDir, {
        waitMs: config.lockWaitMs,
        staleMs: config.lockStaleMs,
        heartbeatMs: config.lockBeatMs,
      });
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        lock.release();
        lock = null;
        throw error;
      }
      return server.address().port;
    },
    // Stop in an orderly way: refuse new connections, close the sockets and the databases.
    async close() {
      await closeSockets();
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 2000).unref();
      });
      pool.closeAll();
      lock?.release();
      lock = null;
    },
  };
}
