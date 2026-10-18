import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { fail } from "../errors.js";

const scryptAsync = promisify(scrypt);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const randomCode = (length) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

// Run at most `size` tasks at the same time. Hashing uses memory and the thread pool.
// When `maxQueue` tasks wait, a new task gets status 503. A flood of logins then
// cannot fill the memory of the server.
function limiter(size, maxQueue) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= size || !waiting.length) return;
    running++;
    waiting.shift()();
  };
  return async (task) => {
    if (waiting.length >= maxQueue)
      fail(503, "The server is busy. Try again in a few seconds.", { "Retry-After": "5" });
    await new Promise((resolve) => {
      waiting.push(resolve);
      next();
    });
    try {
      return await task();
    } finally {
      running--;
      next();
    }
  };
}

// Password hashes use scrypt. The stored text has the format
// `scrypt$<cost>$<salt>$<key>`. The cost is the base 2 logarithm of N.
export function createPasswordHasher({ cost = 15, concurrency = 2, maxQueue = 50 } = {}) {
  const run = limiter(concurrency, maxQueue);
  const derive = (value, salt, exponent) =>
    scryptAsync(value, salt, 32, {
      N: 2 ** exponent,
      r: 8,
      p: 1,
      maxmem: 128 * 8 * 2 ** exponent * 2 + 1024 * 1024,
    });
  return {
    hash: (value) =>
      run(async () => {
        const salt = randomBytes(16);
        const key = await derive(value, salt, cost);
        return `scrypt$${cost}$${salt.toString("hex")}$${key.toString("hex")}`;
      }),
    verify: (value, stored) =>
      run(async () => {
        const parts = typeof stored === "string" ? stored.split("$") : [];
        if (parts.length !== 4 || parts[0] !== "scrypt") return false;
        const exponent = Number(parts[1]);
        if (!Number.isInteger(exponent) || exponent < 10 || exponent > 20) return false;
        const expected = Buffer.from(parts[3], "hex");
        if (expected.length !== 32 || !/^[0-9a-f]{32}$/.test(parts[2])) return false;
        const key = await derive(value, Buffer.from(parts[2], "hex"), exponent);
        return timingSafeEqual(key, expected);
      }),
  };
}
