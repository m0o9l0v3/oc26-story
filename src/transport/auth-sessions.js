import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function randomToken() {
  return randomBytes(32).toString("base64url");
}

export function pinsEqual(actual, expected) {
  const actualHash = createHash("sha256").update(String(actual), "utf8").digest();
  const expectedHash = createHash("sha256").update(String(expected), "utf8").digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export class ExpiringSessionStore {
  constructor(ttlMs, now = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  create() {
    this.prune();
    const token = randomToken();
    this.sessions.set(token, this.now() + this.ttlMs);
    return token;
  }

  has(token) {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  delete(token) {
    if (token) this.sessions.delete(token);
  }

  prune() {
    const now = this.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export class LoginAttemptLimiter {
  constructor({ maxFailures = 5, lockMs = 5 * 60_000, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.now = now;
    this.attempts = new Map();
  }

  isLocked(key) {
    const entry = this.attempts.get(key);
    if (!entry?.lockedUntil) return false;
    if (entry.lockedUntil <= this.now()) {
      this.attempts.delete(key);
      return false;
    }
    return true;
  }

  recordFailure(key) {
    const current = this.attempts.get(key);
    const failures = (current?.failures ?? 0) + 1;
    const lockedUntil = failures >= this.maxFailures ? this.now() + this.lockMs : null;
    this.attempts.set(key, { failures, lockedUntil });
    return Boolean(lockedUntil);
  }

  reset(key) {
    this.attempts.delete(key);
  }
}

export class FixedWindowRateLimiter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  consume(key) {
    const now = this.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}
