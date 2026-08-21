import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PORT = 3222;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health/live`)).ok) return;
    } catch {
      // 起動完了を待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("session expiry server did not start");
}

test("SSEは認証期限後に終了し、参加者は新しいセッションでポーリング復旧できる", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oc26-expiry-"));
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: directory,
      OPERATOR_PIN: "2468",
      NODE_ENV: "test",
      TEST_OPERATOR_TTL_MS: "200",
      TEST_PARTICIPANT_TTL_MS: "200",
      TEST_HEARTBEAT_INTERVAL_MS: "20"
    },
    stdio: "ignore"
  });
  try {
    await waitForServer();
    const login = await fetch(`${BASE}/api/operator/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ pin: "2468" })
    });
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const controller = new AbortController();
    const stream = await fetch(`${BASE}/api/events?role=operator`, {
      headers: { cookie },
      signal: controller.signal
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const ended = await Promise.race([
      (async () => {
        while (true) {
          const result = await reader.read();
          if (result.done) return true;
        }
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000))
    ]);
    controller.abort();
    assert.equal(ended, true);
    assert.equal((await fetch(`${BASE}/api/state?role=operator`, { headers: { cookie } })).status, 401);

    const participantSession = await fetch(`${BASE}/api/participants/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: "{}"
    });
    const expiredParticipantCookie = participantSession.headers.get("set-cookie").split(";", 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await fetch(`${BASE}/api/state?role=participant`, {
      headers: { cookie: expiredParticipantCookie }
    })).status, 401);

    const recoveredSession = await fetch(`${BASE}/api/participants/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie: expiredParticipantCookie
      },
      body: "{}"
    });
    const recoveredCookie = recoveredSession.headers.get("set-cookie").split(";", 1)[0];
    assert.notEqual(recoveredCookie, expiredParticipantCookie);
    assert.equal((await fetch(`${BASE}/api/state?role=participant`, {
      headers: { cookie: recoveredCookie }
    })).status, 200);
  } finally {
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
