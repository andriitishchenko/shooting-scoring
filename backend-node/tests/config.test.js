import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { listenUrls, loadConfig, serviceRoot } from "../src/config.js";

const load = (env, overrides) => loadConfig(overrides, env);

test("the default settings suit a local event", () => {
  const config = load({});
  assert.equal(config.port, 8000);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.dataDir, path.join(serviceRoot, "data"));
  assert.equal(config.frontendDir, path.join(serviceRoot, "..", "frontend"));
  assert.deepEqual([config.origins, config.trustedProxies], [[], []]);
  assert.equal(config.maxBodyBytes, 256 * 1024);
  assert.equal(config.loginFailureLimit, 100);
  assert.equal(config.eventCreateLimit, 60);
  assert.equal(config.sessionDays, 14);
  assert.equal(config.passwordCost, 15);
  assert.equal(config.logLevel, "info");
  assert.equal(config.lockWaitMs, 5000);
  assert.equal(config.hashQueue, 50);
  assert.match(config.contentSecurityPolicy, /^default-src 'self'/);
  assert.ok(Object.isFrozen(config));
});

test("the settings come from the environment", () => {
  const config = load({
    PORT: "9000", HOST: "127.0.0.1", DATA_DIR: "/tmp/shooting-data", ALLOWED_ORIGINS: '["https://a.example"]',
    TRUSTED_PROXIES: '["10.0.0.1"]', MAX_BODY_BYTES: "4096", LOGIN_FAILURE_LIMIT: "5", EVENT_CREATE_LIMIT: "0",
    SESSION_DAYS: "3", PASSWORD_COST: "12", LOG_LEVEL: "debug", MAX_SOCKETS: "7", OPEN_DATABASES: "4",
  });
  assert.deepEqual(
    [config.port, config.host, config.dataDir, config.origins, config.trustedProxies, config.maxBodyBytes],
    [9000, "127.0.0.1", "/tmp/shooting-data", ["https://a.example"], ["10.0.0.1"], 4096],
  );
  assert.deepEqual(
    [config.loginFailureLimit, config.eventCreateLimit, config.sessionDays, config.passwordCost, config.logLevel, config.maxSockets, config.openDatabases],
    [5, 0, 3, 12, "debug", 7, 4],
  );
});

test("the content security policy comes from the environment, and \"off\" turns it off", () => {
  assert.equal(load({ CONTENT_SECURITY_POLICY: "default-src 'none'" }).contentSecurityPolicy, "default-src 'none'");
  assert.equal(load({ CONTENT_SECURITY_POLICY: "off" }).contentSecurityPolicy, "");
});

test("IP is the old name of HOST and HOST wins", () => {
  assert.equal(load({ IP: "10.1.1.1" }).host, "10.1.1.1");
  assert.equal(load({ IP: "10.1.1.1", HOST: "10.2.2.2" }).host, "10.2.2.2");
});

test("a relative data directory is made absolute", () => {
  assert.equal(load({ DATA_DIR: "relative/data" }).dataDir, path.resolve("relative/data"));
});

for (const [name, env, message] of [
  ["a text port", { PORT: "abc" }, /PORT/],
  ["a port above 65535", { PORT: "70000" }, /PORT/],
  ["a small body limit", { MAX_BODY_BYTES: "10" }, /MAX_BODY_BYTES/],
  ["a zero login limit", { LOGIN_FAILURE_LIMIT: "0" }, /LOGIN_FAILURE_LIMIT/],
  ["a negative creation limit", { EVENT_CREATE_LIMIT: "-1" }, /EVENT_CREATE_LIMIT/],
  ["a low password cost", { PASSWORD_COST: "5" }, /PASSWORD_COST/],
  ["a session time of zero days", { SESSION_DAYS: "0" }, /SESSION_DAYS/],
  ["origins that are not JSON", { ALLOWED_ORIGINS: "https://a.example" }, /ALLOWED_ORIGINS/],
  ["origins that are not a list", { ALLOWED_ORIGINS: '"https://a.example"' }, /ALLOWED_ORIGINS/],
  ["an origin that is not text", { ALLOWED_ORIGINS: "[1]" }, /ALLOWED_ORIGINS/],
  ["a wildcard origin", { ALLOWED_ORIGINS: '["*"]' }, /wildcard CORS/],
  ["proxies that are not a list", { TRUSTED_PROXIES: "{}" }, /TRUSTED_PROXIES/],
  ["an unknown log level", { LOG_LEVEL: "loud" }, /LOG_LEVEL/],
  ["a negative lock wait", { LOCK_WAIT_MS: "-1" }, /LOCK_WAIT_MS/],
  ["a hash queue of zero", { HASH_QUEUE: "0" }, /HASH_QUEUE/],
]) {
  test(`the settings are rejected for ${name}`, () => {
    assert.throws(() => load(env), message);
  });
}

test("an override has priority over the environment", () => {
  assert.equal(load({ PORT: "9000" }, { port: 1234 }).port, 1234);
  assert.deepEqual(load({ ALLOWED_ORIGINS: '["https://a.example"]' }, { origins: ["https://b.example"] }).origins, ["https://b.example"]);
});

test("the start message shows the local address and each network address", () => {
  assert.deepEqual(listenUrls("127.0.0.1", 8000), ["http://127.0.0.1:8000"]);
  const urls = listenUrls("0.0.0.0", 8000);
  assert.equal(urls[0], "http://localhost:8000");
  assert.ok(urls.slice(1).every((url) => /^http:\/\/\d+\.\d+\.\d+\.\d+:8000$/.test(url)));
});
