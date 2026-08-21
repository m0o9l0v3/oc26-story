import test from "node:test";
import assert from "node:assert/strict";
import {
  ExpiringSessionStore,
  FixedWindowRateLimiter,
  LoginAttemptLimiter,
  pinsEqual
} from "../src/transport/auth-sessions.js";

test("PIN比較は長さの異なる入力も安全に比較する", () => {
  assert.equal(pinsEqual("1234", "1234"), true);
  assert.equal(pinsEqual("1", "1234"), false);
});

test("運営者セッションは期限を過ぎると拒否される", () => {
  let now = 1_000;
  const sessions = new ExpiringSessionStore(100, () => now);
  const token = sessions.create();
  assert.equal(sessions.has(token), true);
  now = 1_100;
  assert.equal(sessions.has(token), false);
});

test("ログイン試行制限は時間経過または成功で解除できる", () => {
  let now = 1_000;
  const limiter = new LoginAttemptLimiter({ maxFailures: 2, lockMs: 100, now: () => now });
  assert.equal(limiter.recordFailure("client"), false);
  assert.equal(limiter.recordFailure("client"), true);
  assert.equal(limiter.isLocked("client"), true);
  now = 1_100;
  assert.equal(limiter.isLocked("client"), false);
  limiter.recordFailure("client");
  limiter.reset("client");
  assert.equal(limiter.isLocked("client"), false);
});

test("固定窓レート制限は上限と窓の更新を処理する", () => {
  let now = 0;
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 100, now: () => now });
  assert.equal(limiter.consume("participant"), true);
  assert.equal(limiter.consume("participant"), true);
  assert.equal(limiter.consume("participant"), false);
  now = 100;
  assert.equal(limiter.consume("participant"), true);
});
