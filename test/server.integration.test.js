import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;
let serverProcess;

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/state`);
      if (response.ok) return;
    } catch {
      // 起動完了まで待機する。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("test server did not start");
}

async function operator(action, extra = {}, pin = "1234") {
  return fetch(`${BASE}/api/operator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operator-pin": pin
    },
    body: JSON.stringify({ action, ...extra })
  });
}

before(async () => {
  serverProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), OPERATOR_PIN: "1234" },
    stdio: "ignore"
  });
  await waitForServer();
});

after(() => {
  serverProcess?.kill("SIGTERM");
});

test("3画面と静的ファイルを配信できる", async () => {
  for (const path of ["/participant", "/display", "/operator"]) {
    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
  }

  const script = await fetch(`${BASE}/app.js`);
  const stylesheet = await fetch(`${BASE}/styles.css`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /^text\/css/);
});

test("誤ったPINでは運営操作を拒否する", async () => {
  const response = await operator("advance", {}, "wrong");
  assert.equal(response.status, 401);
});

test("HTTP APIで投票、変更、締切、抽選まで進行できる", async () => {
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await operator("advance")).status, 200);
  }
  assert.equal((await operator("open-vote")).status, 200);

  const castVote = (participantId, choiceId) =>
    fetch(`${BASE}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId, choiceId })
    });

  assert.equal((await castVote("device-a", "r1-envelope")).status, 200);
  assert.equal((await castVote("device-b", "r1-envelope")).status, 200);
  assert.equal((await castVote("device-c", "r1-cat")).status, 200);
  assert.equal((await castVote("device-c", "r1-message")).status, 200);
  assert.equal((await operator("close-vote")).status, 200);
  assert.equal((await operator("draw")).status, 200);

  const state = await fetch(`${BASE}/api/state?role=display`).then((response) => response.json());
  assert.equal(state.phase, "revealed");
  assert.deepEqual(state.counts, [
    { choiceId: "r1-envelope", count: 2 },
    { choiceId: "r1-cat", count: 0 },
    { choiceId: "r1-message", count: 1 }
  ]);
  assert.equal(state.history.length, 1);
  assert.ok(state.lastDraw.choiceId);
});

function readFirstSseState(role) {
  const controller = new AbortController();
  const promise = (async () => {
    const response = await fetch(`${BASE}/api/events?role=${role}`, {
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const eventEnd = buffer.indexOf("\n\n");
        if (eventEnd !== -1) {
          const event = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const dataLine = event.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
          continue;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE connection ended before a state event");
        buffer += decoder.decode(value, { stream: true });
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  })();
  return promise;
}

test("状態APIは役割ごとに投票途中の情報を分離する", async () => {
  assert.equal((await operator("reset")).status, 200);
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await operator("advance")).status, 200);
  }
  assert.equal((await operator("open-vote")).status, 200);
  assert.equal((await fetch(`${BASE}/api/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participantId: "privacy-device", choiceId: "r1-envelope" })
  })).status, 200);

  const participant = await fetch(`${BASE}/api/state`).then((response) => response.json());
  const display = await fetch(`${BASE}/api/state?role=display`).then((response) => response.json());
  const operatorState = await fetch(`${BASE}/api/state?role=operator`).then((response) => response.json());

  for (const field of ["counts", "totalVotes", "probabilities", "lastDraw", "mode", "beta"]) {
    assert.equal(field in participant, false, `participant state must not include ${field}`);
  }
  for (const field of ["phase", "story", "currentNode", "history", "storyText", "connectedParticipants", "updatedAt"]) {
    assert.ok(field in participant, `participant state must include ${field}`);
  }
  assert.equal(display.totalVotes, 1);
  assert.equal(display.counts[0].count, 1);
  assert.equal(operatorState.totalVotes, 1);
  assert.equal(operatorState.probabilities["r1-envelope"] > 0, true);

  const invalid = await fetch(`${BASE}/api/state?role=untrusted`);
  assert.equal(invalid.status, 400);
});

test("SSEはクライアントごとの役割に応じた状態を送る", async () => {
  const [participant, display, operatorState] = await Promise.all([
    readFirstSseState("participant"),
    readFirstSseState("display"),
    readFirstSseState("operator")
  ]);

  for (const field of ["counts", "totalVotes", "probabilities", "lastDraw"]) {
    assert.equal(field in participant, false, `participant SSE must not include ${field}`);
  }
  assert.equal(display.totalVotes, 1);
  assert.equal(display.counts[0].count, 1);
  assert.equal(operatorState.totalVotes, 1);
  assert.ok("lastDraw" in operatorState);

  const invalid = await fetch(`${BASE}/api/events?role=untrusted`);
  assert.equal(invalid.status, 400);
});
