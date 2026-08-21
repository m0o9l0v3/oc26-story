import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const port = 3224;
const base = `http://127.0.0.1:${port}`;
const participants = 100;
const rounds = 3;
const directory = await mkdtemp(path.join(os.tmpdir(), "oc26-poll-load-"));
const server = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), DATA_DIR: directory, OPERATOR_PIN: "load-test" },
  stdio: "ignore"
});

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) break;
    } catch {
      // 起動完了を待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const cookies = await Promise.all(Array.from({ length: participants }, async () => {
    const response = await fetch(`${base}/api/participants/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}"
    });
    assert.equal(response.status, 200);
    return cookieFrom(response);
  }));

  const startedAt = Date.now();
  for (let round = 0; round < rounds; round += 1) {
    const responses = await Promise.all(cookies.map((cookie) =>
      fetch(`${base}/api/state?role=participant`, { headers: { cookie } })
    ));
    assert.equal(responses.every((response) => response.status === 200), true);
  }
  const supportState = await fetch(`${base}/api/state?role=support`).then((response) => response.json());
  assert.equal(supportState.connectedParticipants, participants);

  console.log(JSON.stringify({
    result: "pass",
    participants,
    requests: participants * rounds,
    elapsedMs: Date.now() - startedAt
  }, null, 2));
} finally {
  if (server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
