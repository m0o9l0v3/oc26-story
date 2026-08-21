import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTION_ERROR_CODE,
  POLLING_STALE_MS,
  connectionRecoveryMarkup,
  shouldUsePolling
} from "../public/connection-policy.js";

test("SSE状態を一定時間受信しなければ予備ポーリングへ切り替える", () => {
  const now = 100_000;
  assert.equal(shouldUsePolling(0, now), true);
  assert.equal(shouldUsePolling(now - POLLING_STALE_MS + 1, now), false);
  assert.equal(shouldUsePolling(now - POLLING_STALE_MS, now), true);
});

test("参加者向け障害表示にエラー番号と再読み込み導線を含める", () => {
  const markup = connectionRecoveryMarkup();
  assert.match(markup, new RegExp(CONNECTION_ERROR_CODE));
  assert.match(markup, /再読み込み/);
  assert.match(markup, /<button/);
});
