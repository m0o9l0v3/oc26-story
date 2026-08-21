import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const participantTarget = Number(process.env.PARTICIPANTS || 100);
const port = Number(process.env.LOAD_TEST_PORT || 3220);
const base = process.env.LOAD_TARGET || `http://127.0.0.1:${port}`;
const externalTarget = Boolean(process.env.LOAD_TARGET);
let serverProcess = null;
let dataDirectory = null;

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) return;
    } catch {
      // 起動を待つ。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("load test server did not become ready");
}

async function createParticipant() {
  const response = await fetch(`${base}/api/participants/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: "{}"
  });
  assert.equal(response.status, 200);
  const cookie = cookieFrom(response);
  assert.match(cookie, /^oc26_participant=/);
  return cookie;
}

async function openParticipantStream(cookie) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?role=participant`, {
    headers: { cookie },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE ended before initial state");
    buffer += decoder.decode(value, { stream: true });
  }
  assert.match(buffer, /data: \{/);
  return { controller, reader };
}

async function inBatches(items, size, task) {
  const results = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...await Promise.all(items.slice(index, index + size).map(task)));
  }
  return results;
}

async function main() {
  const startedAt = performance.now();
  if (!externalTarget) {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "oc26-load-test-"));
    serverProcess = spawn(process.execPath, ["src/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        OPERATOR_PIN: "load-test-only",
        DATA_DIR: dataDirectory
      },
      stdio: "ignore"
    });
  }

  await waitForServer();
  const indexes = Array.from({ length: participantTarget }, (_, index) => index);
  const cookies = await inBatches(indexes, 20, createParticipant);
  const streams = await inBatches(cookies, 20, openParticipantStream);

  const support = await fetch(`${base}/api/state?role=support`).then((response) => response.json());
  assert.equal(support.connectedParticipants, participantTarget);
  assert.equal("counts" in support, false);

  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(JSON.stringify({
    result: "pass",
    participants: participantTarget,
    connectedParticipants: support.connectedParticipants,
    elapsedMs
  }, null, 2));

  for (const stream of streams) {
    stream.controller.abort();
    await stream.reader.cancel().catch(() => {});
  }
}

try {
  await main();
} finally {
  serverProcess?.kill("SIGTERM");
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
}
