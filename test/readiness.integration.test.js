import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function startServer({ port, dataDirectory, pin = "9876", nodeEnv = "test" }) {
  const processHandle = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDirectory,
      OPERATOR_PIN: pin,
      NODE_ENV: nodeEnv
    },
    stdio: "ignore"
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health/live`)).ok) return { processHandle, base };
    } catch {
      // 起動完了を待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  processHandle.kill("SIGKILL");
  throw new Error("readiness test server did not start");
}

async function stop(processHandle) {
  if (processHandle.exitCode !== null) return;
  const exited = new Promise((resolve) => processHandle.once("exit", resolve));
  processHandle.kill("SIGTERM");
  await exited;
}

async function login(base, pin) {
  const response = await fetch(`${base}/api/operator/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ pin })
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("書き込み不能な保存先ではreadyを返さない", async () => {
  const { processHandle, base } = await startServer({
    port: 3219,
    dataDirectory: "/dev/null"
  });
  try {
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /保存先/);

    const cookie = await login(base, "9876");
    const before = await fetch(`${base}/api/state?role=operator`, { headers: { cookie } })
      .then((stateResponse) => stateResponse.json());
    const failedAction = await fetch(`${base}/api/operator/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ action: "advance", expectedRevision: before.revision })
    });
    assert.equal(failedAction.status, 503);
    const after = await fetch(`${base}/api/state?role=operator`, { headers: { cookie } })
      .then((stateResponse) => stateResponse.json());
    assert.equal(after.phase, before.phase);
    assert.equal(after.revision, before.revision);
  } finally {
    await stop(processHandle);
  }
});

test("本番環境では開発用PINのままreadyにならない", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oc26-production-pin-"));
  const { processHandle, base } = await startServer({
    port: 3220,
    dataDirectory: directory,
    pin: "260822",
    nodeEnv: "production"
  });
  try {
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /開発用PIN/);
  } finally {
    await stop(processHandle);
    await rm(directory, { recursive: true, force: true });
  }
});

test("現在・前世代が破損している場合は警告し、正常保存後にreadyへ戻る", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oc26-corrupt-snapshot-"));
  await writeFile(path.join(directory, "session-state.json"), "{broken", "utf8");
  await writeFile(path.join(directory, "session-state.previous.json"), "{also-broken", "utf8");
  const { processHandle, base } = await startServer({ port: 3221, dataDirectory: directory });
  try {
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    const cookie = await login(base, "9876");
    const state = await fetch(`${base}/api/state?role=operator`, { headers: { cookie } })
      .then((response) => response.json());
    assert.match(state.recoveryNotice, /壊れている/);

    const saved = await fetch(`${base}/api/operator/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({ action: "reset", expectedRevision: state.revision })
    });
    assert.equal(saved.status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  } finally {
    await stop(processHandle);
    await rm(directory, { recursive: true, force: true });
  }
});
