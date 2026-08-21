import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PORT = 3223;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health/live`)).ok) return;
    } catch {
      // 起動完了を待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("mutation serialization test server did not start");
}

async function stop(processHandle) {
  if (processHandle.exitCode !== null) return;
  const exited = new Promise((resolve) => processHandle.once("exit", resolve));
  processHandle.kill("SIGTERM");
  await exited;
}

async function jsonRequest(pathname, { body, cookie = "", method = "POST" }) {
  return fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

async function login() {
  const response = await jsonRequest("/api/operator/login", { body: { pin: "6789" } });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function operatorAction(cookie, action, extra = {}) {
  const state = await fetch(`${BASE}/api/state?role=operator`, { headers: { cookie } })
    .then((response) => response.json());
  return jsonRequest("/api/operator/actions", {
    cookie,
    body: { action, expectedRevision: state.revision, ...extra }
  });
}

test("保存失敗のrollback中に到着した投票を直列化して保持する", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "oc26-mutation-serialization-"));
  const dataDirectory = path.join(rootDirectory, "data");
  const backupDirectory = path.join(rootDirectory, "data-backup");
  const processHandle = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDirectory,
      OPERATOR_PIN: "6789",
      NODE_ENV: "test",
      TEST_SNAPSHOT_SAVE_DELAY_MS: "150"
    },
    stdio: "ignore"
  });

  try {
    await waitForServer();
    const operatorCookie = await login();
    assert.equal((await operatorAction(operatorCookie, "reset")).status, 200);
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await operatorAction(operatorCookie, "advance")).status, 200);
    }
    assert.equal((await operatorAction(operatorCookie, "open-vote")).status, 200);

    const participantSession = await jsonRequest("/api/participants/session", { body: {} });
    assert.equal(participantSession.status, 200);
    const participantCookie = participantSession.headers.get("set-cookie").split(";", 1)[0];
    const before = await fetch(`${BASE}/api/state?role=operator`, {
      headers: { cookie: operatorCookie }
    }).then((response) => response.json());

    await rename(dataDirectory, backupDirectory);
    await writeFile(dataDirectory, "保存先を意図的に書き込み不能にする", "utf8");

    const failedOperatorAction = jsonRequest("/api/operator/actions", {
      cookie: operatorCookie,
      body: { action: "set-beta", beta: 2, expectedRevision: before.revision }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    let voteSettled = false;
    const vote = jsonRequest("/api/vote", {
      method: "PUT",
      cookie: participantCookie,
      body: { choiceId: "r1-envelope" }
    }).finally(() => {
      voteSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(voteSettled, false, "保存中の投票はrollback完了まで待機する");

    const [operatorResponse, voteResponse] = await Promise.all([failedOperatorAction, vote]);
    assert.equal(operatorResponse.status, 503);
    assert.equal(voteResponse.status, 200);

    const after = await fetch(`${BASE}/api/state?role=operator`, {
      headers: { cookie: operatorCookie }
    }).then((response) => response.json());
    assert.equal(after.beta, 1, "失敗した運営操作は元に戻る");
    assert.equal(after.totalVotes, 1, "rollback後に受理した投票は保持される");
    assert.deepEqual(after.counts, [
      { choiceId: "r1-envelope", count: 1 },
      { choiceId: "r1-cat", count: 0 },
      { choiceId: "r1-message", count: 0 }
    ]);
  } finally {
    await stop(processHandle);
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("運営APIの低速なリクエスト本文は参加者投票のキューを塞がない", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "oc26-slow-operator-body-"));
  const processHandle = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDirectory,
      OPERATOR_PIN: "6789",
      NODE_ENV: "test"
    },
    stdio: "ignore"
  });

  let slowRequest;
  try {
    await waitForServer();
    const operatorCookie = await login();
    assert.equal((await operatorAction(operatorCookie, "reset")).status, 200);
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await operatorAction(operatorCookie, "advance")).status, 200);
    }
    assert.equal((await operatorAction(operatorCookie, "open-vote")).status, 200);

    const participantSession = await jsonRequest("/api/participants/session", { body: {} });
    const participantCookie = participantSession.headers.get("set-cookie").split(";", 1)[0];

    slowRequest = httpRequest(`${BASE}/api/operator/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1000",
        origin: BASE,
        cookie: operatorCookie
      }
    });
    slowRequest.on("error", () => {});
    slowRequest.write('{"action":"set-beta",');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const vote = await Promise.race([
      jsonRequest("/api/vote", {
        method: "PUT",
        cookie: participantCookie,
        body: { choiceId: "r1-envelope" }
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("低速な運営リクエストが参加者投票をブロックしました")),
        750
      ))
    ]);
    assert.equal(vote.status, 200);
  } finally {
    slowRequest?.destroy();
    await stop(processHandle);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
