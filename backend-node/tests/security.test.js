import { test } from "node:test";
import assert from "node:assert/strict";
import { createPasswordHasher, hashToken, newToken, randomCode } from "../src/security/passwords.js";
import { createLoginThrottle, createRateLimiter } from "../src/security/throttle.js";
import { HttpError } from "../src/errors.js";

const hasher = createPasswordHasher({ cost: 10 });

test("a password hash verifies the password and nothing else", async () => {
  const stored = await hasher.hash("correct horse");
  assert.match(stored, /^scrypt\$10\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await hasher.verify("correct horse", stored), true);
  for (const wrong of ["correct horse ", "Correct horse", "", "x".repeat(1000)])
    assert.equal(await hasher.verify(wrong, stored), false);
});

test("two hashes of one password differ", async () => {
  assert.notEqual(await hasher.hash("same"), await hasher.hash("same"));
});

test("a broken stored hash never verifies", async () => {
  for (const bad of [null, undefined, "", "plain", "scrypt$10$zz$zz", "scrypt$5$" + "00".repeat(16) + "$" + "00".repeat(32), "scrypt$99$" + "00".repeat(16) + "$" + "00".repeat(32), "scrypt$10$" + "00".repeat(16), "bcrypt$10$" + "00".repeat(16) + "$" + "00".repeat(32), "scrypt$10$" + "00".repeat(16) + "$" + "00".repeat(8)])
    assert.equal(await hasher.verify("anything", bad), false, String(bad));
});

test("a hash made with another cost still verifies", async () => {
  const stored = await createPasswordHasher({ cost: 11 }).hash("value");
  assert.equal(await hasher.verify("value", stored), true);
});

test("hashing runs in the thread pool and does not stop the event loop", async () => {
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  const slow = createPasswordHasher({ cost: 15, concurrency: 2 });
  await Promise.all([slow.hash("a"), slow.hash("b"), slow.hash("c"), slow.hash("d")]);
  clearInterval(timer);
  assert.ok(longest < 80, `The event loop stopped for ${longest.toFixed(0)} ms`);
});

test("the hasher runs only a few hashes at the same time", async () => {
  const limited = createPasswordHasher({ cost: 10, concurrency: 1 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => limited.hash(`p${i}`)));
  assert.equal(new Set(results).size, 6);
});

test("codes and tokens use the right characters and are random", () => {
  assert.match(randomCode(16), /^[A-Z0-9]{16}$/);
  assert.equal(randomCode(6).length, 6);
  assert.equal(new Set(Array.from({ length: 200 }, () => newToken())).size, 200);
  assert.match(newToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(hashToken("a"), /^[0-9a-f]{64}$/);
  assert.equal(hashToken("a"), hashToken("a"));
  assert.notEqual(hashToken("a"), hashToken("b"));
});

function clock() {
  const state = { time: 1_000_000 };
  return { now: () => state.time, advance: (ms) => (state.time += ms) };
}
const throws429 = (fn) => assert.throws(fn, (error) => error instanceof HttpError && error.status === 429 && Number(error.headers["Retry-After"]) > 0);

test("the throttle locks an account after ten failed attempts and unlocks after 15 minutes", () => {
  const time = clock();
  const throttle = createLoginThrottle({ now: time.now });
  for (let i = 0; i < 10; i++) throttle.reserve("host", "-", "1.1.1.1");
  throws429(() => throttle.reserve("host", "-", "1.1.1.1"));
  throttle.reserve("host", "-", "2.2.2.2");
  throttle.reserve("viewer", "-", "1.1.1.1");
  time.advance(14 * 60_000);
  throws429(() => throttle.reserve("host", "-", "1.1.1.1"));
  time.advance(2 * 60_000);
  throttle.reserve("host", "-", "1.1.1.1");
});

test("the throttle gives back an attempt for a correct password", () => {
  const throttle = createLoginThrottle();
  for (let i = 0; i < 9; i++) throttle.reserve("lane", "3", "a");
  throttle.succeed("lane", "3", "a");
  for (let i = 0; i < 9; i++) throttle.reserve("lane", "3", "a");
});

test("the throttle limits one address across all accounts", () => {
  const throttle = createLoginThrottle({ addressLimit: 5 });
  for (const [role, id] of [["host", "-"], ["viewer", "-"], ["lane", "1"], ["lane", "2"], ["lane", "3"]]) throttle.reserve(role, id, "a");
  throws429(() => throttle.reserve("lane", "4", "a"));
  throttle.reserve("lane", "4", "b");
});

test("a failed window ends after 15 minutes without a lock", () => {
  const time = clock();
  const throttle = createLoginThrottle({ now: time.now });
  for (let i = 0; i < 9; i++) throttle.reserve("host", "-", "a");
  time.advance(16 * 60_000);
  for (let i = 0; i < 9; i++) throttle.reserve("host", "-", "a");
});

test("the throttle keeps its memory small", () => {
  const time = clock();
  const throttle = createLoginThrottle({ now: time.now });
  for (let i = 0; i < 30_000; i++) throttle.reserve("lane", String(i), `host-${i}`);
  assert.ok(throttle.size <= 20_000 + 2, `The throttle keeps ${throttle.size} entries`);
  time.advance(60 * 60_000);
  for (let i = 0; i < 10_001; i++) throttle.reserve("lane", `new${i}`, `next-${i}`);
  assert.ok(throttle.size <= 20_002, `Old entries stay: ${throttle.size}`);
});

test("the rate limiter allows a number of events in a window and can give a slot back", () => {
  const time = clock();
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: time.now });
  limiter.take("a");
  const release = limiter.take("a");
  throws429(() => limiter.take("a"));
  release();
  limiter.take("a");
  throws429(() => limiter.take("a"));
  limiter.take("b");
  time.advance(1001);
  limiter.take("a");
});

test("a rate limiter with no maximum allows everything", () => {
  const limiter = createRateLimiter({ max: 0 });
  for (let i = 0; i < 100; i++) limiter.take("a")();
});

test("the throttle can give an attempt back without clearing the failures", () => {
  const throttle = createLoginThrottle();
  for (let i = 0; i < 5; i++) throttle.reserve("host", "-", "a");
  throttle.reserve("host", "-", "a");
  throttle.release("host", "-", "a");
  for (let i = 0; i < 4; i++) throttle.reserve("host", "-", "a");
  throws429(() => { for (let i = 0; i < 2; i++) throttle.reserve("host", "-", "a"); });
  throttle.release("lane", "9", "unknown");
});

test("the hasher refuses new work when too many tasks wait", async () => {
  const limited = createPasswordHasher({ cost: 12, concurrency: 1, maxQueue: 2 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => limited.hash(`p${i}`)));
  const refused = results.filter((r) => r.status === "rejected");
  assert.ok(refused.length > 0);
  for (const r of refused) assert.ok(r.reason instanceof HttpError && r.reason.status === 503 && r.reason.headers["Retry-After"] === "5");
  assert.ok(results.filter((r) => r.status === "fulfilled").length >= 3);
  assert.match(await limited.hash("after"), /^scrypt\$12\$/);
});
