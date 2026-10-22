import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startApp } from "./helpers.js";
import { defaultPolicy } from "../src/config.js";

const scoringRoot = new URL("../../frontend/scoring/", import.meta.url);

test("the home page links to the separate Scoring application", async (t) => {
  const { base } = await startApp(t);
  const home = await (await fetch(base)).text();
  assert.match(home, /<a[^>]+href="scoring\/"[^>]*>\s*Scoring\s*</);
  assert.equal((await fetch(`${base}/client.html`)).status, 200);
  const response = await fetch(`${base}/scoring/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<base href="\/scoring\/">/);
  assert.match(html, /<title>Archery Scoring<\/title>/);
});

test("the folder URL redirects with its query and uses only the same origin", async (t) => {
  const { base } = await startApp(t);
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${base}/scoring?example=1`, { method, redirect: "manual" });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "/scoring/?example=1");
  }
});

test("Flutter files, fonts, images, and WebAssembly have the required content types", async (t) => {
  const { base } = await startApp(t);
  const resources = [
    ["flutter_bootstrap.js", "text/javascript"],
    ["main.dart.js", "text/javascript"],
    ["app_shell.css", "text/css"],
    ["manifest.json", "application/json"],
    ["assets/FontManifest.json", "application/json"],
    ["assets/fonts/fallback/Roboto-Regular.ttf", "font/ttf"],
    ["assets/fonts/MaterialIcons-Regular.otf", "font/otf"],
    ["assets/images/3d_buck.jpg", "image/jpeg"],
    ["canvaskit/canvaskit.wasm", "application/wasm"],
    ["canvaskit/chromium/canvaskit.wasm", "application/wasm"],
  ];
  for (const [resource, type] of resources) {
    const response = await fetch(`${base}/scoring/${resource}`, { method: "HEAD" });
    assert.equal(response.status, 200, resource);
    assert.equal(response.headers.get("content-type").split(";")[0], type, resource);
    assert.ok(Number(response.headers.get("content-length")) > 0, resource);
  }
  const wasm = await (await fetch(`${base}/scoring/canvaskit/canvaskit.wasm`)).arrayBuffer();
  assert.equal(WebAssembly.validate(wasm), true);
});

test("all referenced HTML, manifest, and Flutter font files are in the separate folder", () => {
  const html = fs.readFileSync(new URL("index.html", scoringRoot), "utf8");
  const references = [...html.matchAll(/(?:src|href)="([^"/][^"]*)"/g)].map(match => match[1]);
  const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", scoringRoot)));
  const fonts = JSON.parse(fs.readFileSync(new URL("assets/FontManifest.json", scoringRoot)));
  references.push(...manifest.icons.map(icon => icon.src));
  references.push(...fonts.flatMap(family => family.fonts.map(font => `assets/${font.asset}`)));
  for (const file of references) assert.ok(fs.existsSync(new URL(file, scoringRoot)), file);
  assert.equal(manifest.start_url, "/scoring/");
  assert.equal(manifest.scope, "/scoring/");
  assert.equal(manifest.id, "/scoring/");
  const bootstrap = fs.readFileSync(new URL("flutter_bootstrap.js", scoringRoot), "utf8");
  assert.match(bootstrap, /"useLocalCanvasKit":true/);
  assert.match(bootstrap, /_flutter\.loader\.load\(\);\s*$/);
  assert.ok(fs.existsSync(new URL("main.dart.js", scoringRoot)));
});

test("the Flutter policy permits WebAssembly only in the separate application", async (t) => {
  const { base } = await startApp(t);
  for (const resource of ["/scoring/", "/scoring/index.html", "/scoring/flutter_bootstrap.js", "/scoring%2Findex.html"]) {
    const response = await fetch(`${base}${resource}`);
    const policy = response.headers.get("content-security-policy");
    assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.doesNotMatch(policy, /(?:^|\s)'unsafe-eval'/);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  }
  for (const resource of ["/", "/host.html", "/client.html", "/api/health", "/scoring/%2F..%2Fhost.html"]) {
    const response = await fetch(`${base}${resource}`);
    assert.equal(response.headers.get("content-security-policy"), defaultPolicy, resource);
  }
});

test("the Scoring application respects a custom or disabled policy", async (t) => {
  const custom = await startApp(t, { contentSecurityPolicy: "default-src 'none'" });
  const disabled = await startApp(t, { contentSecurityPolicy: "" });
  assert.equal((await fetch(`${custom.base}/scoring/`)).headers.get("content-security-policy"), "default-src 'none'");
  assert.equal((await fetch(`${disabled.base}/scoring/`)).headers.get("content-security-policy"), null);
});
