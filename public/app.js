import { connectionRecoveryMarkup, shouldUsePolling } from "./connection-policy.js";

const pathRole = location.pathname === "/operator"
  ? "operator"
  : location.pathname === "/display"
    ? "display"
    : "participant";

document.body.dataset.role = pathRole;

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
let state = null;
let selectedChoiceId = "";
let events = null;
let connectionState = "reconnecting";
let disconnectTimer = null;
let lastRevision = -1;
let lastServerInstanceId = "";
let participantRecoveryInFlight = false;
let participantRecoveryAttempted = false;
let operatorActionInFlight = false;
let pollTimer = null;
let pollInFlight = false;
let lastRealtimeAt = 0;

const connectionLabels = {
  connected: "接続済み",
  fallback: "予備接続中",
  reconnecting: "再接続中",
  disconnected: "接続できません"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function showToast(message, kind = "info") {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2600);
}

async function requestJson(path, { method = "GET", body } = {}) {
  const headers = body === undefined ? {} : { "content-type": "application/json" };
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || "操作に失敗しました");
    error.code = result.error?.code;
    error.status = response.status;
    throw error;
  }
  return result;
}

function header(label) {
  if (["参加者画面", "運営者画面"].includes(label)) {
    const roleClass = label === "参加者画面" ? "participant" : "operator";
    return `
      <header class="topbar ${roleClass}-topbar">
        <div class="brand"><span class="${roleClass}-brand-mark" aria-hidden="true"></span><span>OC26&nbsp;&nbsp;STORY VOTE</span></div>
        <div class="topbar-status"><span class="connection-indicator ${connectionState}">${connectionLabels[connectionState]}</span><div class="role-label">${escapeHtml(label)}</div></div>
      </header>`;
  }
  return `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">OC</span><span>想像力が、カタチになる。</span></div>
      <div class="role-label">${escapeHtml(label)}</div>
    </header>`;
}

function storyBlock() {
  return `<section class="story-panel"><p class="eyebrow">現在までの物語</p><p class="story-text">${escapeHtml(state.storyText)}</p></section>`;
}

function renderParticipant() {
  const phase = state.phase;
  let content = "";

  if (phase === "voting") {
    content = `
      <section class="participant-hero">
        <p class="round-chip">ROUND ${state.currentNode.round} / 4</p>
        <h1>${escapeHtml(state.currentNode.prompt)}</h1>
        <p class="hint">気になる選択肢を1つ選んでください。物語はみんなの投票で変わります。</p>
      </section>
      <section class="choice-grid participant-choices">
        ${state.currentNode.choices.map((choice, index) => `
          <button class="choice-card ${selectedChoiceId === choice.id ? "selected" : ""}" data-vote="${escapeHtml(choice.id)}" aria-pressed="${selectedChoiceId === choice.id}">
            <span class="choice-card-top">
              <span class="choice-letter">${String.fromCharCode(65 + index)}</span>
              <span class="selected-label">${selectedChoiceId === choice.id ? "選択済み" : "選択する"}</span>
            </span>
            <span class="choice-copy">${escapeHtml(choice.text)}</span>
          </button>`).join("")}
      </section>
      <p class="participant-vote-note">投票は締め切りまで何度でも変更できます</p>`;
  } else {
    const messages = {
      waiting: ["まもなく始まります", "中央モニターを見てお待ちください。"],
      intro: ["生成AIの仕組みを体験します", "説明は中央モニターで行います。"],
      "token-demo": ["まずは短い単位から", "AIが次の言葉を選ぶ様子を見てみましょう。"],
      "round-ready": [`第${state.currentNode?.round ?? 1}ラウンド`, "まもなく投票が始まります。"],
      closed: ["投票を締め切りました", "結果は中央モニターで発表します。"],
      revealed: ["物語の続きが決まりました", "次のラウンドまでお待ちください。"],
      finished: ["物語が完成しました！", "みんなで作った結末を中央モニターで確認しましょう。"]
    };
    const [title, description] = messages[phase] ?? ["お待ちください", "中央モニターをご覧ください。"];
    content = `<section class="waiting-card"><div class="pulse-orb"></div><p class="eyebrow">STORY VOTE</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></section>`;
  }

  app.innerHTML = `${header("参加者画面")}<div class="participant-shell">${content}</div>`;
  document.querySelectorAll("[data-vote]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const choiceId = button.dataset.vote;
        await requestJson("/api/vote", { method: "PUT", body: { choiceId } });
        selectedChoiceId = choiceId;
        renderParticipant();
        showToast("投票しました。締切までは変更できます。", "success");
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  });
}

function resultBars(showProbability = false) {
  const total = Math.max(state.totalVotes, 1);
  return state.currentNode.choices.map((choice, index) => {
    const count = state.counts.find((item) => item.choiceId === choice.id)?.count ?? 0;
    const rate = count / total;
    const drawRate = state.probabilities[choice.id] ?? 0;
    const winner = state.lastDraw?.choiceId === choice.id;
    return `
      <article class="result-row ${winner ? "winner" : ""}">
        <div class="result-copy"><span class="choice-letter">${String.fromCharCode(65 + index)}</span><p>${escapeHtml(choice.text)}</p><strong>${count}票</strong></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(rate * 100, count ? 3 : 0)}%"></div></div>
        <div class="result-meta"><span>得票率 ${percent(rate)}</span>${showProbability ? `<span>抽選確率 ${percent(drawRate)}</span>` : ""}</div>
      </article>`;
  }).join("");
}

function renderDisplay() {
  const phase = state.phase;
  let content = "";
  if (phase === "waiting") {
    content = `<section class="display-hero"><p class="eyebrow">30 MINUTES AI EXPERIENCE</p><h1>みんなの投票で<br><em>物語を作ろう</em></h1><p>参加端末 <strong>${state.connectedParticipants}</strong> 台</p></section>`;
  } else if (phase === "intro") {
    content = `<section class="explanation"><p class="eyebrow">最初に大切なこと</p><h1>今日は、あらかじめ用意した物語を使います</h1><p>本物の生成AIがその場で文章を作っているわけではありません。候補を選びながら、AIが文章を作る基本的な考え方を体験します。</p></section>`;
  } else if (phase === "token-demo") {
    const hasMeasuredProbabilities = state.story.tokenDemo.candidates.every(
      (candidate) => typeof candidate.probability === "number"
    );
    content = `<section class="token-demo"><p class="eyebrow">AIは「次に続きそうなもの」を選ぶ</p><h1>${escapeHtml(state.story.tokenDemo.context)} <span>＿＿＿</span></h1><div class="token-list">${state.story.tokenDemo.candidates.map((candidate) => `<div><strong>${escapeHtml(candidate.text)}</strong>${hasMeasuredProbabilities ? `<span>${percent(candidate.probability)}</span>` : ""}</div>`).join("")}</div><p class="note">${hasMeasuredProbabilities ? "表示している確率は、事前に実際のモデルから取得した値です。" : "現在は候補のみを表示しています。確率は、実際のモデルから取得できた場合だけ表示します。"}<br>実際のAIは、単語より細かい「トークン」という単位で、この選択を何度も繰り返します。</p></section>`;
  } else if (["round-ready", "voting", "closed", "revealed"].includes(phase)) {
    const titles = {
      "round-ready": "次の展開を選ぼう",
      voting: "投票受付中",
      closed: "投票結果と抽選確率",
      revealed: "選ばれた物語はこちら！"
    };
    const publicChoices = `<div class="choice-grid">${state.currentNode.choices.map((choice, index) => `<article class="choice-card"><span class="choice-letter">${String.fromCharCode(65 + index)}</span><span>${escapeHtml(choice.text)}</span></article>`).join("")}</div>`;
    content = `${storyBlock()}<section class="round-panel"><div class="round-heading"><div><p class="round-chip">第${state.currentNode.round}ラウンド</p><h1>${titles[phase]}</h1></div><div class="connection-pill">参加 ${state.connectedParticipants}台</div></div><p class="prompt">${escapeHtml(state.currentNode.prompt)}</p>${["round-ready", "voting"].includes(phase) ? publicChoices : `<div class="results">${resultBars(true)}</div>`}${phase === "voting" ? `<p class="live-label"><span></span>投票受付中・${state.totalVotes}票</p>` : ""}${state.lastDraw?.usedUniformFallback ? `<p class="warning">投票が0票だったため、3候補を同じ確率で抽選しました。</p>` : ""}</section>`;
  } else if (phase === "finished") {
    content = `<section class="finale"><p class="eyebrow">THE END</p><h1>みんなの物語が完成しました</h1><div class="final-story">${escapeHtml(state.storyText)}</div><div class="learning-grid"><div><strong>候補から選ぶ</strong><span>AIも次に続く候補を考えます</span></div><div><strong>選択が次を変える</strong><span>選ばれた内容で次の候補も変化します</span></div><div><strong>自然さと事実は別</strong><span>読みやすい文章でも正しいとは限りません</span></div></div></section>`;
  }
  app.innerHTML = `${header("中央モニター")}<div class="display-shell">${content}</div>`;
}

function actionButtons() {
  const actions = [];
  if (["waiting", "intro", "token-demo", "revealed"].includes(state.phase)) {
    actions.push(["advance", state.phase === "waiting" ? "開始" : state.phase === "revealed" ? "次のラウンドへ" : "次へ", "primary"]);
  }
  if (state.phase === "round-ready") actions.push(["open-vote", "投票開始", "primary"]);
  if (state.phase === "voting") actions.push(["close-vote", "投票を締め切る", "primary"]);
  if (state.phase === "closed") actions.push(["draw", "抽選実行", "primary"]);
  return actions.map(([action, label, kind]) => `<button class="control-button ${kind}" data-action="${action}">${label}</button>`).join("");
}

function renderOperator() {
  const phaseLabels = {
    waiting: "待機中", intro: "導入説明", "token-demo": "トークン説明", "round-ready": "投票準備", voting: "投票中", closed: "締切済み", revealed: "結果発表", finished: "終了"
  };
  const manualInputs = state.mode === "manual" && state.currentNode && ["voting", "closed"].includes(state.phase)
    ? `<div class="operator-manual"><p class="operator-field-label">挙手数</p><div class="manual-inputs">${state.currentNode.choices.map((choice, index) => `<label><span>${String.fromCharCode(65 + index)}</span><input type="number" min="0" max="999" value="${state.counts.find((item) => item.choiceId === choice.id)?.count ?? 0}" data-manual-count="${choice.id}" aria-label="選択肢${String.fromCharCode(65 + index)}の挙手数"></label>`).join("")}</div><button class="operator-button secondary" data-save-counts>挙手数を反映</button></div>`
    : "";
  const currentAction = actionButtons();
  const choices = state.currentNode?.choices ?? [];
  const round = state.currentNode?.round;
  const maxRound = state.story?.maxRounds ?? 4;
  const modeLocked = !["waiting", "intro", "token-demo", "round-ready"].includes(state.phase);

  app.innerHTML = `${header("運営者画面")}<main class="operator-shell">
    ${state.recoveryNotice ? `<section class="recovery-banner" role="status"><strong>復旧のお知らせ</strong><span>${escapeHtml(state.recoveryNotice)}</span></section>` : ""}
    <section class="operator-summary">
      <div><span>現在の状態</span><strong>${phaseLabels[state.phase]}</strong></div>
      <div><span>参加端末</span><strong>${state.connectedParticipants}台</strong></div>
      <div><span>投票数</span><strong>${state.totalVotes}票</strong></div>
      <div><span>ラウンド</span><strong>${round ? `${round} / ${maxRound}` : "—"}</strong></div>
    </section>
    <div class="operator-workspace">
      <section class="operator-card main-controls">
        <div class="operator-card-heading"><h2>進行操作</h2>${state.phase === "voting" ? `<span class="voting-status">投票受付中</span>` : ""}</div>
        <div class="control-row">${currentAction || `<button class="operator-button secondary" disabled>現在実行できる操作はありません</button>`}</div>
        <p class="operator-hint">スペースキーでも、現在の主操作を実行できます</p>
        <hr>
        <p class="operator-read-label">読み上げ用</p>
        <h3>${escapeHtml(state.currentNode?.prompt ?? "中央モニターの案内に沿って進めます")}</h3>
        <div class="operator-choice-list">${choices.map((choice, index) => `<p>${String.fromCharCode(65 + index)}. ${escapeHtml(choice.text)}</p>`).join("") || `<p>参加者に開始まで待つよう案内してください。</p>`}</div>
      </section>
      <aside class="operator-settings">
        <section class="operator-card voting-settings">
          <h2>投票設定</h2>
          <p class="operator-field-label">集計の強さ（β）</p>
          <div class="preset-row beta-row">${[0.5, 1, 2].map((beta) => `<button class="preset ${state.beta === beta ? "active" : ""}" data-beta="${beta}">β = ${beta}</button>`).join("")}</div>
          <p class="operator-field-label">投票方法</p>
          <div class="preset-row"><button class="preset ${state.mode === "online" ? "active" : ""}" data-mode="online" ${modeLocked ? "disabled" : ""}>PC投票</button><button class="preset ${state.mode === "manual" ? "active" : ""}" data-mode="manual" ${modeLocked ? "disabled" : ""}>挙手投票</button></div>
          ${manualInputs}
          <p class="operator-setting-note">変更は次の投票から反映されます</p>
        </section>
        <section class="operator-card safety-card">
          <div class="operator-card-heading"><h2>安全・復旧</h2><span class="pin-status authenticated">ログイン済み</span></div>
          <button class="operator-button secondary" data-action="reset">全体をリセット</button>
          ${state.phase === "voting" && state.mode === "online" ? `<button class="operator-button emergency" data-action="emergency-manual">緊急時：挙手投票へ切り替える</button>` : ""}
          <a class="operator-button secondary" href="/api/operator/export" download>現在状態を保存</a>
          <button class="operator-button secondary" data-logout>ログアウト</button>
          <p class="operator-setting-note">物語と投票結果を最初の状態に戻します</p>
        </section>
      </aside>
    </div>
  </main>`;

  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => runOperatorAction(button.dataset.action)));
  document.querySelectorAll("[data-beta]").forEach((button) => button.addEventListener("click", () => runOperatorAction("set-beta", { beta: Number(button.dataset.beta) })));
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => runOperatorAction("set-mode", { mode: button.dataset.mode })));
  document.querySelector("[data-save-counts]")?.addEventListener("click", () => {
    const counts = Object.fromEntries([...document.querySelectorAll("[data-manual-count]")].map((input) => [input.dataset.manualCount, Number(input.value)]));
    runOperatorAction("set-manual-counts", { counts });
  });
  document.querySelector("[data-logout]")?.addEventListener("click", logoutOperator);
}

function renderOperatorLogin(message = "運営者PINを入力してください") {
  app.innerHTML = `${header("運営者画面")}<main class="operator-shell">
    <section class="operator-card safety-card" style="max-width:520px;margin:48px auto">
      <h2>運営者ログイン</h2>
      <p class="operator-setting-note">${escapeHtml(message)}</p>
      <form data-login-form>
        <label class="pin-field"><span>運営者PIN</span><input type="password" data-login-pin autocomplete="current-password" inputmode="numeric" required autofocus></label>
        <button class="operator-button primary" type="submit">ログイン</button>
      </form>
    </section>
  </main>`;
  document.querySelector("[data-login-form]")?.addEventListener("submit", loginOperator);
}

async function loginOperator(event) {
  event.preventDefault();
  const pin = document.querySelector("[data-login-pin]")?.value ?? "";
  const submit = event.currentTarget.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;
  try {
    await requestJson("/api/operator/login", { method: "POST", body: { pin } });
    applyIncomingState(await requestJson("/api/state?role=operator"));
    connectEvents();
    startPolling();
    showToast("ログインしました", "success");
  } catch (error) {
    renderOperatorLogin(error.message);
    showToast(error.message, "error");
  }
}

async function logoutOperator() {
  try {
    await requestJson("/api/operator/logout", { method: "POST", body: {} });
  } finally {
    events?.close();
    events = null;
    stopPolling();
    state = null;
    renderOperatorLogin("ログアウトしました");
  }
}

async function runOperatorAction(action, extra = {}) {
  if (operatorActionInFlight) return;
  if (action === "reset" && !confirm("物語・投票・設定をすべて最初に戻しますか？")) return;
  if (action === "emergency-manual" && !confirm("現在のPC投票をすべて破棄し、挙手投票へ切り替えますか？")) return;
  const actionButtons = [...document.querySelectorAll("[data-action], [data-beta], [data-mode], [data-save-counts]")];
  operatorActionInFlight = true;
  actionButtons.forEach((button) => { button.disabled = true; });
  try {
    const result = await requestJson("/api/operator/actions", {
      method: "POST",
      body: { action, expectedRevision: state?.revision, ...extra }
    });
    if (result.state) {
      // Apply the same monotonic revision rule as SSE and polling. A delayed
      // action response must never overwrite a newer operator state.
      applyIncomingState(result.state);
    }
    showToast("操作を反映しました", "success");
  } catch (error) {
    if (error.status === 401) {
      events?.close();
      events = null;
      state = null;
      renderOperatorLogin("セッションの有効期限が切れました。もう一度ログインしてください");
      return;
    }
    showToast(error.message, "error");
  } finally {
    operatorActionInFlight = false;
    actionButtons.forEach((button) => { button.disabled = false; });
  }
}

function render() {
  if (!state) return;
  if (pathRole === "operator") renderOperator();
  else if (pathRole === "display") renderDisplay();
  else renderParticipant();
}

function applyIncomingState(nextState) {
  if (nextState.serverInstanceId && nextState.serverInstanceId !== lastServerInstanceId) {
    lastServerInstanceId = nextState.serverInstanceId;
    lastRevision = -1;
  }
  const nextRevision = Number(nextState.revision ?? 0);
  if (nextRevision && nextRevision < lastRevision) return false;
  lastRevision = Math.max(lastRevision, nextRevision);
  state = nextState;
  if (pathRole === "participant") {
    selectedChoiceId = state.phase === "voting" ? (state.selectedChoiceId ?? "") : "";
  }
  render();
  return true;
}

async function recoverParticipantSession() {
  if (participantRecoveryInFlight) return;
  participantRecoveryInFlight = true;
  try {
    await requestJson("/api/participants/session", { method: "POST", body: {} });
  } finally {
    participantRecoveryInFlight = false;
  }
}

async function pollState() {
  if (pollInFlight || (pathRole === "operator" && !state)) return;
  if (!shouldUsePolling(lastRealtimeAt)) return;
  pollInFlight = true;
  try {
    const nextState = await requestJson(`/api/state?role=${pathRole}`);
    participantRecoveryAttempted = false;
    applyIncomingState(nextState);
    events?.close();
    events = null;
    setConnectionState("fallback");
  } catch (error) {
    if (pathRole === "participant" && error.status === 401) {
      if (participantRecoveryAttempted) {
        setConnectionState("disconnected");
        return;
      }
      participantRecoveryAttempted = true;
      try {
        await recoverParticipantSession();
      } catch {
        setConnectionState("disconnected");
      }
    } else if (pathRole === "operator" && error.status === 401) {
      events?.close();
      events = null;
      stopPolling();
      state = null;
      renderOperatorLogin("セッションの有効期限が切れました。もう一度ログインしてください");
    } else {
      setConnectionState("disconnected");
    }
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollState, 3_000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function switchToPollingFallback() {
  // EventSource は内部で再接続を試みる。ここで新しい EventSource を作り直すと、
  // トンネルやプロキシが SSE を扱えない場合に、再接続と参加者セッション作成が
  // error のたびに連鎖してしまうため、SSE は明示的に止めてポーリングへ切り替える。
  events?.close();
  events = null;
  lastRealtimeAt = 0;
  if (connectionState !== "fallback") setConnectionState("reconnecting");
  startPolling();
  void pollState();
}

function connectEvents() {
  events?.close();
  setConnectionState("reconnecting");
  const source = new EventSource(`/api/events?role=${pathRole}`);
  events = source;
  source.addEventListener("open", () => {
    if (events !== source) return;
    if (!lastRealtimeAt) setConnectionState("reconnecting");
  });
  source.addEventListener("message", (event) => {
    if (events !== source) return;
    const nextState = JSON.parse(event.data);
    lastRealtimeAt = Date.now();
    setConnectionState("connected");
    applyIncomingState(nextState);
  });
  source.addEventListener("heartbeat", () => {
    if (events !== source) return;
    lastRealtimeAt = Date.now();
    setConnectionState("connected");
  });
  source.addEventListener("error", () => {
    if (events !== source) return;
    switchToPollingFallback();
    showToast("再接続しています…", "error");
  });
}

function setConnectionState(nextState) {
  connectionState = nextState;
  clearTimeout(disconnectTimer);
  if (nextState === "reconnecting") {
    disconnectTimer = setTimeout(() => setConnectionState("disconnected"), 10_000);
  }
  const indicator = document.querySelector(".connection-indicator");
  if (indicator) {
    indicator.className = `connection-indicator ${nextState === "fallback" ? "connected fallback" : nextState}`;
    indicator.textContent = connectionLabels[nextState];
  }
  let recovery = document.querySelector("#connection-recovery");
  if (nextState === "disconnected" && pathRole === "participant") {
    if (!recovery) {
      recovery = document.createElement("aside");
      recovery.id = "connection-recovery";
      recovery.className = "connection-recovery";
      recovery.innerHTML = connectionRecoveryMarkup();
      recovery.querySelector("button").addEventListener("click", () => location.reload());
      document.body.append(recovery);
    }
  } else {
    recovery?.remove();
  }
}

async function initialize() {
  try {
    if (pathRole === "participant") {
      await requestJson("/api/participants/session", { method: "POST", body: {} });
      applyIncomingState(await requestJson("/api/state?role=participant"));
      connectEvents();
      startPolling();
      return;
    }
    if (pathRole === "operator") {
      try {
        applyIncomingState(await requestJson("/api/state?role=operator"));
      } catch (error) {
        if (error.status === 401) {
          renderOperatorLogin();
          return;
        }
        throw error;
      }
    }
    if (pathRole === "display") {
      applyIncomingState(await requestJson("/api/state?role=display"));
    }
    connectEvents();
    startPolling();
  } catch (error) {
    app.innerHTML = `${header(pathRole === "participant" ? "参加者画面" : "中央モニター")}<section class="waiting-card"><h1>接続できません</h1><p>${escapeHtml(error.message)}</p><button class="operator-button" onclick="location.reload()">再読み込み</button></section>`;
  }
}

initialize();

document.addEventListener("keydown", (event) => {
  if (pathRole !== "operator" || event.code !== "Space" || event.repeat || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  event.preventDefault();
  const mainAction = document.querySelector(".main-controls [data-action]");
  if (mainAction) runOperatorAction(mainAction.dataset.action);
});
