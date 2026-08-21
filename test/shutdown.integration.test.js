import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PORT = 3224;
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
  throw new Error("shutdown test server did not start");
}

test("SIGTERM終了時にmutation queueを待って最終保存し、正常終了する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oc26-shutdown-"));
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: directory,
      OPERATOR_PIN: "9753",
      NODE_ENV: "test"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitForServer();
    const exited = new Promise((resolve) => server.once("exit", (code) => resolve(code)));
    server.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.doesNotMatch(stderr, /ReferenceError|終了時に進行状態を保存できませんでした/);
  } finally {
    if (server.exitCode === null) server.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
