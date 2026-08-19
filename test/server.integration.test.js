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

  const state = await fetch(`${BASE}/api/state`).then((response) => response.json());
  assert.equal(state.phase, "revealed");
  assert.deepEqual(state.counts, [
    { choiceId: "r1-envelope", count: 2 },
    { choiceId: "r1-cat", count: 0 },
    { choiceId: "r1-message", count: 1 }
  ]);
  assert.equal(state.history.length, 1);
  assert.ok(state.lastDraw.choiceId);
});

