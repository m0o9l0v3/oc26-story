import { shouldUsePolling } from "./connection-policy.js";

const connectionBadge = document.querySelector("#connection-badge");
const serverStatus = document.querySelector("#server-status");
const phaseStatus = document.querySelector("#phase-status");
const participantCount = document.querySelector("#participant-count");
const votingMode = document.querySelector("#voting-mode");
const guidanceTitle = document.querySelector("#guidance-title");
const guidanceBody = document.querySelector("#guidance-body");
const participantUrl = document.querySelector("#participant-url");
const copyButton = document.querySelector("#copy-url");
const toast = document.querySelector("#toast");

const participantPageUrl = `${location.origin}/participant`;
participantUrl.textContent = participantPageUrl;

const phaseGuidance = {
  waiting: ["開始まで待機中です", "参加者に中央モニターを見るよう案内してください。"],
  intro: ["説明中です", "参加者の操作はまだありません。中央モニターを見るよう案内してください。"],
  "token-demo": ["AIの仕組みを説明中です", "参加者の操作はまだありません。"],
  "round-ready": ["まもなく投票が始まります", "参加者画面を開いた状態で待つよう案内してください。"],
  voting: ["投票を受け付けています", "参加者がA・B・Cから1つ選べているか確認してください。"],
  closed: ["投票は締め切られました", "参加者には中央モニターを見るよう案内してください。"],
  revealed: ["結果を発表中です", "次のラウンドまで中央モニターを見るよう案内してください。"],
  finished: ["体験は終了しました", "参加者へ終了の案内をしてください。"]
};

const phaseLabels = {
  waiting: "待機中",
  intro: "導入説明",
  "token-demo": "AI説明",
  "round-ready": "投票準備",
  voting: "投票受付中",
  closed: "締切済み",
  revealed: "結果発表",
  finished: "終了"
};

let lastRevision = -1;
let lastServerInstanceId = "";
let lastRealtimeAt = 0;

function setConnection(kind, label) {
  connectionBadge.className = `status-badge ${kind}`;
  connectionBadge.textContent = label;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2200);
}

function render(state) {
  if (state.serverInstanceId && state.serverInstanceId !== lastServerInstanceId) {
    lastServerInstanceId = state.serverInstanceId;
    lastRevision = -1;
  }
  const revision = Number(state.revision ?? 0);
  if (revision && revision < lastRevision) return;
  lastRevision = Math.max(lastRevision, revision);

  phaseStatus.textContent = phaseLabels[state.phase] ?? "確認が必要";
  participantCount.textContent = Number.isFinite(Number(state.connectedParticipants))
    ? `${Number(state.connectedParticipants)}台`
    : "―";
  votingMode.textContent = state.mode === "manual" ? "挙手投票" : "PC投票";

  const [title, body] = phaseGuidance[state.phase] ?? [
    "主担当へ確認してください",
    "参加者には、そのまま少し待つよう案内してください。"
  ];
  guidanceTitle.textContent = title;
  guidanceBody.textContent = body;
}

async function checkHealth() {
  try {
    const response = await fetch("/health/ready", { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    serverStatus.textContent = response.ok ? "正常" : "主担当に確認";
    serverStatus.dataset.kind = response.ok ? "ok" : "error";
    if (!response.ok && result.error?.message) guidanceBody.textContent = result.error.message;
  } catch {
    serverStatus.textContent = "接続できません";
    serverStatus.dataset.kind = "error";
  }
}

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(participantPageUrl);
    showToast("参加者用URLをコピーしました");
  } catch {
    showToast("URLを長押ししてコピーしてください");
  }
});

const events = new EventSource("/api/events?role=support");
events.addEventListener("open", () => {
  checkHealth();
});
events.addEventListener("message", (event) => {
  try {
    lastRealtimeAt = Date.now();
    setConnection("connected", "接続済み");
    render(JSON.parse(event.data));
  } catch {
    setConnection("disconnected", "確認が必要");
  }
});
events.addEventListener("heartbeat", () => {
  lastRealtimeAt = Date.now();
  setConnection("connected", "接続済み");
});
events.addEventListener("error", () => {
  lastRealtimeAt = 0;
  if (!connectionBadge.classList.contains("fallback")) {
    setConnection("reconnecting", "再接続中");
    serverStatus.textContent = "再接続中";
  }
});

async function pollSupportState() {
  if (!shouldUsePolling(lastRealtimeAt)) return;
  try {
    const response = await fetch("/api/state?role=support", { cache: "no-store" });
    if (!response.ok) throw new Error("support state unavailable");
    render(await response.json());
    events.close();
    setConnection("fallback", "予備接続中");
  } catch {
    setConnection("disconnected", "接続できません");
  }
}

checkHealth();
pollSupportState();
setInterval(checkHealth, 15_000);
setInterval(pollSupportState, 3_000);
