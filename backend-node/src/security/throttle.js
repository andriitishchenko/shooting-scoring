import { fail } from "../errors.js";

const WINDOW_MS = 15 * 60 * 1000;
const KEY_LIMIT = 10;
const MAX_ENTRIES = 20_000;

// Limit failed logins. The state is in memory, because the server is one process.
// A login attempt is counted before the slow password check starts. Parallel
// requests cannot pass the limit together. A correct password refunds the attempt.
export function createLoginThrottle({ addressLimit = 100, now = Date.now } = {}) {
  const entries = new Map();

  function sweep(time) {
    for (const [key, entry] of entries)
      if (entry.lockedUntil <= time && time - entry.started >= WINDOW_MS) entries.delete(key);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  }
  function touch(key, limit, time) {
    let entry = entries.get(key);
    if (!entry || time - entry.started >= WINDOW_MS) {
      entry = { count: 0, started: time, lockedUntil: entry?.lockedUntil ?? 0 };
      entries.set(key, entry);
    }
    entry.count++;
    if (entry.count >= limit) entry.lockedUntil = time + WINDOW_MS;
  }
  const keysFor = (role, id, address) => [
    [`${role}:${id}:${address}`, KEY_LIMIT],
    [`*:*:${address}`, addressLimit],
  ];

  return {
    get size() {
      return entries.size;
    },
    // Throw status 429 when the address is locked. Count this attempt.
    reserve(role, id, address) {
      const time = now();
      if (entries.size > MAX_ENTRIES / 2) sweep(time);
      const keys = keysFor(role, id, address);
      for (const [key] of keys) {
        const entry = entries.get(key);
        if (entry && entry.lockedUntil > time)
          fail(429, "Too many failed login attempts. Try again later.", {
            "Retry-After": String(Math.max(1, Math.ceil((entry.lockedUntil - time) / 1000))),
          });
      }
      for (const [key, limit] of keys) touch(key, limit, time);
    },
    // The check did not run (the server was busy). Give the attempt back.
    release(role, id, address) {
      for (const [key] of keysFor(role, id, address)) {
        const entry = entries.get(key);
        if (entry && entry.count > 0) entry.count--;
      }
    },
    // The password was correct. Remove the failures for this account.
    succeed(role, id, address) {
      const [account, total] = keysFor(role, id, address);
      entries.delete(account[0]);
      const entry = entries.get(total[0]);
      if (entry && entry.count > 0) entry.count--;
    },
  };
}

// Allow at most `max` events in `windowMs` for each key. `max` 0 turns the limit off.
export function createRateLimiter({ max, windowMs = 60 * 60 * 1000, now = Date.now }) {
  const taken = new Map();
  return {
    // Reserve a slot. Return a function that gives the slot back.
    take(key, message = "Too many requests. Try again later.") {
      if (!max) return () => {};
      const time = now();
      const recent = (taken.get(key) ?? []).filter((moment) => time - moment < windowMs);
      if (recent.length >= max)
        fail(429, message, {
          "Retry-After": String(Math.max(1, Math.ceil((recent[0] + windowMs - time) / 1000))),
        });
      recent.push(time);
      taken.set(key, recent);
      if (taken.size > 10_000) taken.delete(taken.keys().next().value);
      return () => {
        const list = taken.get(key) ?? [];
        const index = list.indexOf(time);
        if (index >= 0) list.splice(index, 1);
        if (!list.length) taken.delete(key);
      };
    },
  };
}
