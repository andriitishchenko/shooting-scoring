import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { startApp } from "./helpers.js";

const rawRequest = (port, text, { wait = 1000 } = {}) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    let reply = "";
    socket.on("data", (data) => (reply += data));
    socket.on("error", () => {});
    socket.on("close", () => resolve(reply));
    setTimeout(() => socket.destroy(), wait);
  });

test("every answer has the security headers, and API answers are not cached", async (t) => {
  const { request } = await startApp(t);
  const api = await request("GET", "/api/health");
  const page = await fetch((await startApp(t)).base + "/client.html");
  for (const headers of [api.headers, page.headers]) {
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("x-frame-options"), "DENY");
    assert.equal(headers.get("referrer-policy"), "no-referrer");
    assert.match(headers.get("permissions-policy"), /camera=\(\)/);
  }
  assert.equal(api.headers.get("cache-control"), "no-store");
  assert.match(api.headers.get("content-type"), /^application\/json/);
});

test("the answers for errors are JSON with a detail", async (t) => {
  const { request } = await startApp(t);
  assert.deepEqual((await request("GET", "/api/nope")).data, { detail: "Not Found" });
  const method = await request("DELETE", "/api/events/ABC123");
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, PATCH");
  assert.equal((await request("POST", "/api/events/ABC123/extra", {})).status, 404);
});

test("CORS allows only the listed origins", async (t) => {
  const { base } = await startApp(t, { origins: ["https://allowed.example"] });
  const send = (origin, method = "GET") =>
    fetch(`${base}/api/health`, { method, headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });
  const good = await send("https://allowed.example");
  assert.equal(good.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.equal((await send("https://evil.example")).headers.get("access-control-allow-origin"), null);
  const preflight = await send("https://allowed.example", "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-Session-Id/);
  assert.match(preflight.headers.get("access-control-allow-methods"), /PATCH/);
  assert.equal((await send("https://evil.example", "OPTIONS")).status, 403);
  assert.equal((await fetch(`${base}/api/health`, { method: "OPTIONS" })).status, 405);
});

test("the default CORS setting allows no other origin", async (t) => {
  const { base } = await startApp(t);
  const answer = await fetch(`${base}/api/health`, { headers: { Origin: "https://other.example" } });
  assert.equal(answer.headers.get("access-control-allow-origin"), null);
});

test("a wildcard CORS origin is not accepted", async (t) => {
  await assert.rejects(startApp(t, { origins: ["*"] }), /wildcard CORS/);
});

test("a body above the limit is rejected before it is read", async (t) => {
  const { request, base, errors } = await startApp(t, { maxBodyBytes: 1024 });
  const declared = await request("POST", "/api/events/create", { code: "BIG001", pad: "x".repeat(2000) });
  assert.deepEqual([declared.status, declared.data], [413, { detail: "Request body too large" }]);
  const chunked = await fetch(`${base}/api/events/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    duplex: "half",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.alloc(600, 32));
        controller.enqueue(Buffer.alloc(600, 32));
        controller.close();
      },
    }),
  });
  assert.equal(chunked.status, 413);
  assert.equal((await request("POST", "/api/events/create", { code: "OK0001" })).status, 200);
  assert.deepEqual(errors, []);
});

test("a client that disconnects during an upload does not create an error", async (t) => {
  const { port, errors } = await startApp(t);
  await rawRequest(
    port,
    "POST /api/events/create HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{}",
    { wait: 200 },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(errors, []);
});

test("malformed requests get client errors and never a server error", async (t) => {
  const { request, port, createEvent, errors } = await startApp(t);
  const { host } = await createEvent("MAL001");
  assert.equal((await request("POST", "/api/events/create", "[".repeat(200_000))).status, 400);
  assert.equal((await request("PATCH", "/api/events/MAL001", "null", host)).status, 422);
  assert.equal((await request("POST", "/api/sessions/MAL001/lane/1", "[]")).status, 422);
  assert.equal((await request("GET", "/%2e%2e/package.json")).status, 404);
  assert.equal((await request("GET", "/client.html%00.js")).status, 404);
  assert.equal((await request("GET", "/api/events/%ZZ")).status, 404);
  assert.equal((await request("GET", "/api/participants/MAL001?lane_number=abc")).status, 422);
  assert.equal((await request("GET", "/api/results/MAL001/state/99999999999999999999999")).status, 422);
  assert.equal((await request("DELETE", "/api/events/MAL001", undefined, host)).status, 405);
  assert.match(await rawRequest(port, "GET /../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), / 404 /);
  assert.match(await rawRequest(port, `GET /api/events/${"A".repeat(20_000)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), / 431 /);
  assert.match(await rawRequest(port, "GET http://[bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), / 400 /);
  assert.deepEqual(errors, []);
});

test("an unexpected failure gives 500 JSON and is logged", async (t) => {
  const { app, request, errors } = await startApp(t);
  app.pool.get = () => {
    throw new Error("broken");
  };
  const answer = await request("GET", "/api/events/ABC123");
  assert.deepEqual([answer.status, answer.data], [500, { detail: "Internal Server Error" }]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /Request failed/);
});

test("the server serves the pages with a cache check and compression", async (t) => {
  const { base } = await startApp(t);
  const page = await fetch(`${base}/host.html`, { headers: { "Accept-Encoding": "identity" } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const etag = page.headers.get("etag");
  const text = await page.text();
  assert.match(text, /<title>/);
  assert.equal((await fetch(`${base}/host.html`, { headers: { "If-None-Match": etag } })).status, 304);
  const gzip = await fetch(`${base}/host.html`, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.equal(await gzip.text(), text);
  const head = await fetch(`${base}/host.html`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/index.html`)).status, 200);
  assert.equal((await fetch(`${base}/js/api.js`)).headers.get("content-type").startsWith("text/javascript"), true);
  assert.equal((await fetch(`${base}/no-such-file`)).status, 404);
  assert.equal((await fetch(`${base}/client.html`, { method: "POST" })).status, 405);
});

test("a changed page is read again", async (t) => {
  const frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-"));
  t.after(() => fs.rmSync(frontendDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(frontendDir, "index.html"), "<p>one</p>");
  const { base } = await startApp(t, { frontendDir, staticRecheckMs: 0 });
  assert.equal(await (await fetch(base + "/")).text(), "<p>one</p>");
  fs.writeFileSync(path.join(frontendDir, "index.html"), "<p>second version</p>");
  assert.equal(await (await fetch(base + "/")).text(), "<p>second version</p>");
});

test("a file above 2 MB is streamed and not kept in memory", async (t) => {
  const frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-"));
  t.after(() => fs.rmSync(frontendDir, { recursive: true, force: true }));
  const big = Buffer.alloc(3 * 1024 * 1024, "abcdefghij");
  fs.writeFileSync(path.join(frontendDir, "big.txt"), big);
  fs.writeFileSync(path.join(frontendDir, "index.html"), "ok");
  const { base } = await startApp(t, { frontendDir });
  const answer = await fetch(base + "/big.txt", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("content-encoding"), null);
  assert.equal(Number(answer.headers.get("content-length")), big.length);
  assert.ok(Buffer.from(await answer.arrayBuffer()).equals(big));
  const head = await fetch(base + "/big.txt", { method: "HEAD" });
  assert.equal(Number(head.headers.get("content-length")), big.length);
  assert.equal((await fetch(base + "/big.txt", { headers: { "If-None-Match": answer.headers.get("etag") } })).status, 304);
});

test("a page that was checked a short time ago is not checked again", async (t) => {
  const frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-"));
  t.after(() => fs.rmSync(frontendDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(frontendDir, "index.html"), "<p>one</p>");
  const { base } = await startApp(t, { frontendDir, staticRecheckMs: 300 });
  assert.equal(await (await fetch(base + "/")).text(), "<p>one</p>");
  fs.writeFileSync(path.join(frontendDir, "index.html"), "<p>second version</p>");
  assert.equal(await (await fetch(base + "/")).text(), "<p>one</p>");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await (await fetch(base + "/")).text(), "<p>second version</p>");
  fs.rmSync(path.join(frontendDir, "index.html"));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((await fetch(base + "/")).status, 404);
});

test("the server does not follow a link out of the frontend folder", async (t) => {
  const frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  t.after(() => {
    fs.rmSync(frontendDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(frontendDir, "link.txt"));
  fs.writeFileSync(path.join(frontendDir, "index.html"), "ok");
  const { base } = await startApp(t, { frontendDir });
  assert.equal((await fetch(base + "/link.txt")).status, 404);
  assert.equal((await fetch(base + "/")).status, 200);
});

test("the server provides the QR generator and nothing else from vendor", async (t) => {
  const { base } = await startApp(t);
  const response = await fetch(`${base}/vendor/qrcode.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/javascript/);
  const sandbox = {};
  vm.runInNewContext(await response.text(), sandbox);
  const qr = sandbox.qrcode(0, "M");
  qr.addData("https://scores.example/viewer.html?code=ABC123");
  qr.make();
  assert.match(qr.createSvgTag({ cellSize: 4, scalable: true }), /^<svg /);
  for (const other of ["/vendor/other.js", "/vendor/", "/vendor/..%2Fpackage.json", "/vendor/qrcode.mjs", "/vendor/qrcode.d.ts"])
    assert.equal((await fetch(base + other)).status, 404, other);
});

test("the host page loads the QR generator before the host script", () => {
  const html = fs.readFileSync(new URL("../../frontend/host.html", import.meta.url), "utf8");
  const generator = html.indexOf('src="vendor/qrcode.js"');
  assert.ok(generator > 0);
  assert.ok(generator < html.indexOf('src="js/host.js"'));
});

test("the server logs each request at the debug level", async (t) => {
  const lines = [];
  const log = { error() {}, warn() {}, info() {}, debug: (line) => lines.push(line) };
  const { request } = await startApp(t, { log });
  await request("GET", "/api/health");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(lines[0], /^GET \/api\/health 200 \d/);
});

const directives = (policy) => Object.fromEntries(policy.split(";").map((part) => part.trim().split(/\s+/)).filter((part) => part[0]).map(([name, ...values]) => [name, values]));

test("every answer has a strict Content-Security-Policy", async (t) => {
  const { base, request } = await startApp(t);
  for (const response of [await fetch(`${base}/host.html`), await fetch(`${base}/vendor/qrcode.js`), await fetch(`${base}/missing`), (await request("GET", "/api/health"))]) {
    const policy = directives(response.headers.get("content-security-policy"));
    assert.deepEqual(policy["default-src"], ["'self'"]);
    assert.deepEqual(policy["script-src"], ["'self'"]);
    assert.deepEqual(policy["connect-src"], ["'self'", "ws:", "wss:"]);
    assert.deepEqual(policy["img-src"], ["'self'", "data:"]);
    assert.deepEqual(policy["object-src"], ["'none'"]);
    assert.deepEqual(policy["frame-ancestors"], ["'none'"]);
    assert.deepEqual(policy["base-uri"], ["'self'"]);
    assert.deepEqual(policy["form-action"], ["'self'"]);
    assert.ok(!JSON.stringify(policy).includes("unsafe-eval"));
    assert.ok(!policy["script-src"].includes("'unsafe-inline'"));
  }
});

test("the policy can be changed or turned off in the settings", async (t) => {
  const custom = await startApp(t, { contentSecurityPolicy: "default-src 'none'" });
  assert.equal((await fetch(`${custom.base}/host.html`)).headers.get("content-security-policy"), "default-src 'none'");
  const off = await startApp(t, { contentSecurityPolicy: "" });
  assert.equal((await fetch(`${off.base}/host.html`)).headers.get("content-security-policy"), null);
});

test("the pages of the application use only what the policy allows", () => {
  const frontend = path.join(path.dirname(new URL(import.meta.url).pathname), "../../frontend");
  for (const name of fs.readdirSync(frontend).filter((file) => file.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(frontend, name), "utf8");
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false, `${name} has an inline script`);
    assert.equal(/\son[a-z]+\s*=\s*["']/i.test(html), false, `${name} has an inline handler`);
    assert.equal(/(?:src|href)="https?:/i.test(html), false, `${name} loads an outside resource`);
  }
});
