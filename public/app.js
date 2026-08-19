const pathRole = location.pathname === "/operator"
  ? "operator"
  : location.pathname === "/display"
    ? "display"
    : "participant";

document.body.dataset.role = pathRole;

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const participantId = getParticipantId();
let state = null;
let selectedChoiceId = sessionStorage.getItem("selected-choice") || "";

function getParticipantId() {
  const existing = sessionStorage.getItem("participant-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem("participant-id", created);
  return created;
}

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

async function post(path, body, operator = false) {
  const headers = { "content-type": "application/json" };
  if (operator) headers["x-operator-pin"] = sessionStorage.getItem("operator-pin") || "";
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "操作に失敗しました");
  return result;
}

function header(label) {
  if (label === "参加者画面") {
    return `
      <header class="topbar participant-topbar">
        <div class="brand"><span class="participant-brand-mark" aria-hidden="true"></span><span>OC26&nbsp;&nbsp;STORY VOTE</span></div>
        <div class="role-label">参加者画面</div>
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
        await post("/api/vote", { participantId, choiceId });
        selectedChoiceId = choiceId;
        sessionStorage.setItem("selected-choice", choiceId);
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
    content = `${storyBlock()}<section class="round-panel"><div class="round-heading"><div><p class="round-chip">第${state.currentNode.round}ラウンド</p><h1>${titles[phase]}</h1></div><div class="connection-pill">参加 ${state.connectedParticipants}台</div></div><p class="prompt">${escapeHtml(state.currentNode.prompt)}</p>${phase === "round-ready" ? `<div class="choice-grid">${state.currentNode.choices.map((choice, index) => `<article class="choice-card"><span class="choice-letter">${String.fromCharCode(65 + index)}</span><span>${escapeHtml(choice.text)}</span></article>`).join("")}</div>` : `<div class="results">${resultBars(phase !== "voting")}</div>`}${phase === "voting" ? `<p class="live-label"><span></span>リアルタイム集計中・${state.totalVotes}票</p>` : ""}${state.lastDraw?.usedUniformFallback ? `<p class="warning">投票が0票だったため、3候補を同じ確率で抽選しました。</p>` : ""}</section>`;
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
  if (state.phase === "voting") actions.push(["close-vote", "投票締切", "danger"]);
  if (state.phase === "closed") actions.push(["draw", "抽選実行", "primary"]);
  return actions.map(([action, label, kind]) => `<button class="control-button ${kind}" data-action="${action}">${label}</button>`).join("");
}

function renderOperator() {
  const pin = sessionStorage.getItem("operator-pin") || "";
  const phaseLabels = {
    waiting: "待機中", intro: "導入説明", "token-demo": "トークン説明", "round-ready": "投票準備", voting: "投票中", closed: "締切済み", revealed: "結果発表", finished: "終了"
  };
  const manualInputs = state.mode === "manual" && state.currentNode && ["voting", "closed"].includes(state.phase)
    ? `<section class="operator-card"><h2>挙手数を入力</h2><div class="manual-inputs">${state.currentNode.choices.map((choice, index) => `<label><span>${String.fromCharCode(65 + index)}</span><input type="number" min="0" max="999" value="${state.counts.find((item) => item.choiceId === choice.id)?.count ?? 0}" data-manual-count="${choice.id}"></label>`).join("")}</div><button class="secondary-button" data-save-counts>挙手数を反映</button></section>`
    : "";

  app.innerHTML = `${header("運営者パネル")}<div class="operator-shell">
    <section class="operator-summary">
      <div><span>現在の状態</span><strong>${phaseLabels[state.phase]}</strong></div>
      <div><span>参加端末</span><strong>${state.connectedParticipants}台</strong></div>
      <div><span>投票数</span><strong>${state.totalVotes}票</strong></div>
      <div><span>ラウンド</span><strong>${state.currentNode?.round ?? "—"}</strong></div>
    </section>
    <div class="operator-grid">
      <section class="operator-card main-controls"><h2>進行操作</h2><div class="control-row">${actionButtons()}</div><p class="operator-hint">スペースキーでも、現在表示されている主操作を実行できます。</p></section>
      <section class="operator-card"><h2>運営者PIN</h2><label class="pin-field"><span>PIN</span><input type="password" value="${escapeHtml(pin)}" data-pin autocomplete="off"></label></section>
      <section class="operator-card"><h2>抽選の偏り β</h2><div class="preset-row">${[0.5, 1, 2].map((beta) => `<button class="preset ${state.beta === beta ? "active" : ""}" data-beta="${beta}">β = ${beta}</button>`).join("")}</div><p>${state.beta === 1 ? "得票率をそのまま反映" : state.beta === 2 ? "得票の多い候補を強く優先" : "少数票の候補も選ばれやすくする"}</p></section>
      <section class="operator-card"><h2>投票方式</h2><div class="preset-row"><button class="preset ${state.mode === "online" ? "active" : ""}" data-mode="online">PC投票</button><button class="preset ${state.mode === "manual" ? "active" : ""}" data-mode="manual">挙手投票</button></div><p>通信に問題がある場合は、挙手投票へ切り替えます。</p></section>
      ${manualInputs}
      <section class="operator-card danger-zone"><h2>全体リセット</h2><button class="secondary-button danger" data-action="reset">最初の状態に戻す</button></section>
    </div>
    ${state.currentNode ? `<section class="operator-script"><p class="eyebrow">読み上げ用</p><h2>${escapeHtml(state.currentNode.prompt)}</h2>${state.currentNode.choices.map((choice, index) => `<p><strong>${String.fromCharCode(65 + index)}.</strong> ${escapeHtml(choice.text)}</p>`).join("")}</section>` : ""}
  </div>`;

  document.querySelector("[data-pin]")?.addEventListener("input", (event) => {
    sessionStorage.setItem("operator-pin", event.target.value);
  });
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => runOperatorAction(button.dataset.action)));
  document.querySelectorAll("[data-beta]").forEach((button) => button.addEventListener("click", () => runOperatorAction("set-beta", { beta: Number(button.dataset.beta) })));
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => runOperatorAction("set-mode", { mode: button.dataset.mode })));
  document.querySelector("[data-save-counts]")?.addEventListener("click", () => {
    const counts = Object.fromEntries([...document.querySelectorAll("[data-manual-count]")].map((input) => [input.dataset.manualCount, Number(input.value)]));
    runOperatorAction("set-manual-counts", { counts });
  });
}

async function runOperatorAction(action, extra = {}) {
  if (action === "reset" && !confirm("物語・投票・設定をすべて最初に戻しますか？")) return;
  try {
    await post("/api/operator", { action, ...extra }, true);
    showToast("操作を反映しました", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function render() {
  if (!state) return;
  if (pathRole === "operator") renderOperator();
  else if (pathRole === "display") renderDisplay();
  else renderParticipant();
}

const events = new EventSource(`/api/events?role=${pathRole}&clientId=${encodeURIComponent(participantId)}`);
events.addEventListener("message", (event) => {
  state = JSON.parse(event.data);
  if (state.phase !== "voting") {
    selectedChoiceId = "";
    sessionStorage.removeItem("selected-choice");
  }
  render();
});
events.addEventListener("error", () => showToast("再接続しています…", "error"));

document.addEventListener("keydown", (event) => {
  if (pathRole !== "operator" || event.code !== "Space" || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  event.preventDefault();
  const mainAction = document.querySelector(".main-controls [data-action]");
  if (mainAction) runOperatorAction(mainAction.dataset.action);
});
