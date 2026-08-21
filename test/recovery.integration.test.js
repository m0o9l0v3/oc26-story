import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PORT = 3218;
const BASE = `http://127.0.0.1:${PORT}`;

function startServer(dataDirectory) {
  return spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      OPERATOR_PIN: "5678",
      DATA_DIR: dataDirectory
    },
    stdio: "ignore"
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health/live`)).ok) return;
    } catch {
      // 起動または再起動の完了を待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("recovery test server did not start");
}

function waitForExit(process) {
  if (process.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => process.once("exit", resolve));
}

async function login() {
  const response = await fetch(`${BASE}/api/operator/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ pin: "5678" })
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function action(cookie, action) {
  const state = await fetch(`${BASE}/api/state?role=operator`, {
    headers: { cookie }
  }).then((response) => response.json());
  const response = await fetch(`${BASE}/api/operator/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify({ action, expectedRevision: state.revision })
  });
  assert.equal(response.status, 200, action);
}

test("再起動後に履歴を復元し、投票途中のラウンドを安全に戻す", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "oc26-recovery-integration-"));
  let serverProcess = startServer(dataDirectory);
  try {
    await waitForServer();
    let cookie = await login();
    const beforeInstanceId = await fetch(`${BASE}/api/state?role=operator`, {
      headers: { cookie }
    }).then((response) => response.json()).then((state) => state.serverInstanceId);
    await action(cookie, "reset");
    await action(cookie, "advance");
    await action(cookie, "advance");
    await action(cookie, "advance");
    await action(cookie, "open-vote");
    await action(cookie, "close-vote");
    await action(cookie, "draw");
    await action(cookie, "advance");
    await action(cookie, "open-vote");

    const participantSession = await fetch(`${BASE}/api/participants/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: "{}"
    });
    const oldParticipantCookie = participantSession.headers.get("set-cookie").split(";", 1)[0];
    const votingState = await fetch(`${BASE}/api/state?role=participant`, {
      headers: { cookie: oldParticipantCookie }
    }).then((response) => response.json());
    const vote = await fetch(`${BASE}/api/vote`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: BASE, cookie: oldParticipantCookie },
      body: JSON.stringify({ choiceId: votingState.currentNode.choices[0].id })
    });
    assert.equal(vote.status, 200);

    serverProcess.kill("SIGKILL");
    await waitForExit(serverProcess);

    serverProcess = startServer(dataDirectory);
    await waitForServer();
    cookie = await login();
    const state = await fetch(`${BASE}/api/state?role=operator`, {
      headers: { cookie }
    }).then((response) => response.json());

    assert.equal(state.phase, "round-ready");
    assert.equal(state.currentNode.round, 2);
    assert.equal(state.history.length, 1);
    assert.equal(state.totalVotes, 0);
    assert.match(state.recoveryNotice, /もう一度投票/);
    assert.notEqual(state.serverInstanceId, beforeInstanceId);
    assert.equal((await fetch(`${BASE}/health/ready`)).status, 200);

    const exported = await fetch(`${BASE}/api/operator/export`, { headers: { cookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /attachment/);
    const snapshot = await exported.json();
    assert.equal(snapshot.storyId, "school-mystery-demo");
    assert.equal("votes" in snapshot, false);

    const oldParticipant = await fetch(`${BASE}/api/events?role=participant`, {
      headers: { cookie: oldParticipantCookie }
    });
    assert.equal(oldParticipant.status, 401);
    const newSession = await fetch(`${BASE}/api/participants/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: "{}"
    });
    assert.equal(newSession.status, 200);
    const newParticipantCookie = newSession.headers.get("set-cookie").split(";", 1)[0];
    const controller = new AbortController();
    const restoredStream = await fetch(`${BASE}/api/events?role=participant`, {
      headers: { cookie: newParticipantCookie },
      signal: controller.signal
    });
    assert.equal(restoredStream.status, 200);
    controller.abort();
  } finally {
    serverProcess?.kill("SIGTERM");
    await waitForExit(serverProcess).catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("抽選確定後の再起動でも票数と抽選確率を一貫して表示する", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "oc26-revealed-recovery-"));
  let serverProcess = startServer(dataDirectory);
  try {
    await waitForServer();
    let cookie = await login();
    await action(cookie, "reset");
    await action(cookie, "advance");
    await action(cookie, "advance");
    await action(cookie, "advance");
    await action(cookie, "open-vote");

    const participantCookies = [];
    for (let index = 0; index < 3; index += 1) {
      const participantSession = await fetch(`${BASE}/api/participants/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: "{}"
      });
      participantCookies.push(participantSession.headers.get("set-cookie").split(";", 1)[0]);
    }
    const votingState = await fetch(`${BASE}/api/state?role=participant`, {
      headers: { cookie: participantCookies[0] }
    }).then((response) => response.json());
    await Promise.all([
      fetch(`${BASE}/api/vote`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: BASE, cookie: participantCookies[0] },
        body: JSON.stringify({ choiceId: votingState.currentNode.choices[0].id })
      }),
      fetch(`${BASE}/api/vote`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: BASE, cookie: participantCookies[1] },
        body: JSON.stringify({ choiceId: votingState.currentNode.choices[0].id })
      }),
      fetch(`${BASE}/api/vote`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: BASE, cookie: participantCookies[2] },
        body: JSON.stringify({ choiceId: votingState.currentNode.choices[1].id })
      })
    ].map(async (response) => assert.equal((await response).status, 200)));

    await action(cookie, "close-vote");
    await action(cookie, "draw");
    const beforeRestart = await fetch(`${BASE}/api/state?role=operator`, {
      headers: { cookie }
    }).then((response) => response.json());
    assert.equal(beforeRestart.phase, "revealed");
    assert.equal(beforeRestart.totalVotes, 3);

    serverProcess.kill("SIGKILL");
    await waitForExit(serverProcess);
    serverProcess = startServer(dataDirectory);
    await waitForServer();
    cookie = await login();
    const afterRestart = await fetch(`${BASE}/api/state?role=operator`, {
      headers: { cookie }
    }).then((response) => response.json());

    assert.equal(afterRestart.phase, "revealed");
    assert.deepEqual(afterRestart.counts, beforeRestart.counts);
    assert.equal(afterRestart.totalVotes, beforeRestart.totalVotes);
    assert.deepEqual(afterRestart.probabilities, beforeRestart.probabilities);
    assert.deepEqual(afterRestart.lastDraw, beforeRestart.lastDraw);
  } finally {
    serverProcess?.kill("SIGTERM");
    await waitForExit(serverProcess).catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
