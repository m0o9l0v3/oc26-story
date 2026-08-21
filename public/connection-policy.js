export const POLLING_STALE_MS = 18_000;
export const CONNECTION_ERROR_CODE = "ERR-SSE-01";

export function shouldUsePolling(lastRealtimeAt, now = Date.now()) {
  return !lastRealtimeAt || now - lastRealtimeAt >= POLLING_STALE_MS;
}

export function connectionRecoveryMarkup() {
  return `<strong>接続できません（${CONNECTION_ERROR_CODE}）</strong><span>ページを再読み込みしてください。</span><button type="button">再読み込み</button>`;
}
