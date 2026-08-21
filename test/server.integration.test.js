import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;
const SAME_ORIGIN = { origin: BASE };
let serverProcess;
let operatorCookie;
let dataDirectory;

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/state?role=display`);
      if (response.ok) return;
    } catch {
      // 起動完了まで待機する。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("test server did not start");
}

async function jsonRequest(path, {
  method = "POST",
  body = {},
  cookie = "",
  origin = BASE,
  contentType = "application/json"
} = {}) {
  const headers = {};
  if (contentType) headers["content-type"] = contentType;
  if (cookie) headers.cookie = cookie;
  if (origin !== undefined) headers.origin = origin;
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function createParticipant(extraHeaders = {}) {
  const response = await fetch(`${BASE}/api/participants/session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...SAME_ORIGIN, ...extraHeaders },
    body: "{}"
  });
  assert.equal(response.status, 200);
  const cookie = cookieFrom(response);
  assert.match(cookie, /^oc26_participant=/);
  return { cookie, response };
}

function requestWithoutOrigin(pathname, { method, cookie, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${BASE}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie,
        "content-length": Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        json: () => Promise.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function login(pin = "1234") {
  const response = await jsonRequest("/api/operator/login", { body: { pin } });
  if (response.ok) operatorCookie = cookieFrom(response);
  return response;
}

async function operator(action, extra = {}, cookie = operatorCookie) {
  const operatorState = await fetch(`${BASE}/api/state?role=operator`, {
    headers: { cookie }
  }).then((response) => response.json());
  return jsonRequest("/api/operator/actions", {
    cookie,
    body: { action, expectedRevision: operatorState.revision, ...extra }
  });
}

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "oc26-server-test-"));
  serverProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), OPERATOR_PIN: "1234", DATA_DIR: dataDirectory },
    stdio: "ignore"
  });
  await waitForServer();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = new Promise((resolve) => serverProcess.once("exit", resolve));
    serverProcess.kill("SIGTERM");
    await exited;
  }
  await rm(dataDirectory, { recursive: true, force: true });
});

test("4画面と静的ファイルを配信できる", async () => {
  for (const path of ["/participant", "/display", "/operator", "/support"]) {
    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
  }

  const script = await fetch(`${BASE}/app.js`);
  const stylesheet = await fetch(`${BASE}/styles.css`);
  const supportScript = await fetch(`${BASE}/support.js`);
  const connectionPolicy = await fetch(`${BASE}/connection-policy.js`);
  const supportStylesheet = await fetch(`${BASE}/support.css`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /^text\/css/);
  assert.match(supportScript.headers.get("content-type"), /^text\/javascript/);
  assert.match(connectionPolicy.headers.get("content-type"), /^text\/javascript/);
  assert.match(supportStylesheet.headers.get("content-type"), /^text\/css/);
});

test("healthとsupport状態は認証なしで安全な情報だけを返す", async () => {
  assert.equal((await fetch(`${BASE}/health/live`)).status, 200);
  assert.equal((await fetch(`${BASE}/health/ready`)).status, 200);

  const support = await fetch(`${BASE}/api/state?role=support`).then((response) => response.json());
  for (const field of ["phase", "mode", "connectedParticipants", "revision", "updatedAt"]) {
    assert.ok(field in support, field);
  }
  for (const field of ["counts", "totalVotes", "probabilities", "lastDraw", "beta"]) {
    assert.equal(field in support, false, field);
  }
  const event = await readFirstSseState("support");
  assert.equal("counts" in event, false);
});

test("未認証クライアントは参加者・運営者状態とSSEへ到達できない", async () => {
  for (const path of [
    "/api/state",
    "/api/state?role=operator",
    "/api/events?role=participant",
    "/api/events?role=operator"
  ]) {
    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 401, path);
    const result = await response.json();
    assert.equal(typeof result.error.code, "string");
    assert.equal(typeof result.error.message, "string");
  }
  assert.equal((await operator("advance", {}, "")).status, 401);
});

test("PINログインでHttpOnly運営者セッションを発行しログアウトできる", async () => {
  const wrong = await login("wrong");
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), {
    error: { code: "INVALID_OPERATOR_PIN", message: "PINが違います" }
  });

  const response = await login();
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /oc26_operator=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Max-Age=7200/i);
  assert.equal((await fetch(`${BASE}/api/state?role=operator`, {
    headers: { cookie: operatorCookie }
  })).status, 200);

  const logout = await jsonRequest("/api/operator/logout", { cookie: operatorCookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/i);
  assert.equal((await operator("advance")).status, 401);
  assert.equal((await login()).status, 200);
});

test("HTTP APIで投票、変更、締切、抽選まで進行できる", async () => {
  assert.equal((await operator("reset")).status, 200);
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await operator("advance")).status, 200);
  }
  assert.equal((await operator("open-vote")).status, 200);

  const participantA = await createParticipant();
  const participantB = await createParticipant();
  const castVote = (cookie, choiceId, participantId = undefined) =>
    jsonRequest("/api/vote", {
      method: "PUT",
      cookie,
      body: { choiceId, ...(participantId ? { participantId } : {}) }
    });

  assert.equal((await castVote(participantA.cookie, "r1-envelope", "forged-1")).status, 200);
  assert.equal((await castVote(participantA.cookie, "r1-cat", "forged-2")).status, 200);
  assert.equal((await castVote(participantB.cookie, "r1-message", "forged-1")).status, 200);

  const ownState = await fetch(`${BASE}/api/state?role=participant`, {
    headers: { cookie: participantA.cookie }
  }).then((response) => response.json());
  assert.equal(ownState.selectedChoiceId, "r1-cat");

  assert.equal((await operator("close-vote")).status, 200);
  assert.equal((await operator("draw")).status, 200);
  const state = await fetch(`${BASE}/api/state?role=display`).then((response) => response.json());
  assert.equal(state.phase, "revealed");
  assert.deepEqual(state.counts, [
    { choiceId: "r1-envelope", count: 0 },
    { choiceId: "r1-cat", count: 1 },
    { choiceId: "r1-message", count: 1 }
  ]);
  assert.equal(state.history.length, 1);
});

function readFirstSseState(role, cookie = "") {
  const controller = new AbortController();
  const promise = (async () => {
    const response = await fetch(`${BASE}/api/events?role=${role}`, {
      headers: cookie ? { cookie } : {},
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

test("状態APIとSSEは役割ごとに投票情報を分離する", async () => {
  assert.equal((await operator("reset")).status, 200);
  for (let index = 0; index < 3; index += 1) assert.equal((await operator("advance")).status, 200);
  assert.equal((await operator("open-vote")).status, 200);
  const participantSession = await createParticipant();
  assert.equal((await jsonRequest("/api/vote", {
    method: "PUT",
    cookie: participantSession.cookie,
    body: { choiceId: "r1-envelope" }
  })).status, 200);

  const participant = await fetch(`${BASE}/api/state`, {
    headers: { cookie: participantSession.cookie }
  }).then((response) => response.json());
  const display = await fetch(`${BASE}/api/state?role=display`).then((response) => response.json());
  const operatorState = await fetch(`${BASE}/api/state?role=operator`, {
    headers: { cookie: operatorCookie }
  }).then((response) => response.json());

  for (const field of ["counts", "totalVotes", "probabilities", "lastDraw", "mode", "beta"]) {
    assert.equal(field in participant, false, `participant state must not include ${field}`);
  }
  assert.equal(participant.selectedChoiceId, "r1-envelope");
  assert.equal(display.totalVotes, 1);
  assert.equal("counts" in display, false);
  assert.equal(operatorState.totalVotes, 1);

  const [participantEvent, displayEvent, operatorEvent] = await Promise.all([
    readFirstSseState("participant", participantSession.cookie),
    readFirstSseState("display"),
    readFirstSseState("operator", operatorCookie)
  ]);
  assert.equal(participantEvent.selectedChoiceId, "r1-envelope");
  assert.equal("counts" in participantEvent, false);
  assert.equal(displayEvent.totalVotes, 1);
  assert.equal("counts" in displayEvent, false);
  assert.equal(operatorEvent.totalVotes, 1);

  assert.equal((await fetch(`${BASE}/api/state?role=untrusted`)).status, 400);
  assert.equal((await fetch(`${BASE}/api/events?role=untrusted`)).status, 400);
});

test("Cookie属性、Origin、Content-Type、JSON上限を検証する", async () => {
  const secureSession = await createParticipant({ "x-forwarded-proto": "https" });
  const cookieHeader = secureSession.response.headers.get("set-cookie");
  assert.match(cookieHeader, /Secure/i);
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  assert.match(cookieHeader, /Max-Age=43200/i);

  const invalidOrigin = await jsonRequest("/api/vote", {
    method: "PUT",
    cookie: secureSession.cookie,
    origin: "https://attacker.example",
    body: { choiceId: "r1-envelope" }
  });
  assert.equal(invalidOrigin.status, 403);
  assert.equal((await invalidOrigin.json()).error.code, "INVALID_ORIGIN");

  const missingOrigin = await requestWithoutOrigin("/api/vote", {
    method: "PUT",
    cookie: secureSession.cookie,
    body: JSON.stringify({ choiceId: "r1-envelope" })
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, "ORIGIN_REQUIRED");

  const noJson = await jsonRequest("/api/vote", {
    method: "PUT",
    cookie: secureSession.cookie,
    contentType: "text/plain",
    body: "{}"
  });
  assert.equal(noJson.status, 415);
  assert.equal((await noJson.json()).error.code, "CONTENT_TYPE_REQUIRED");

  const oversized = await jsonRequest("/api/vote", {
    method: "PUT",
    cookie: secureSession.cookie,
    body: JSON.stringify({ choiceId: "r1-envelope", padding: "x".repeat(65 * 1024) })
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "REQUEST_TOO_LARGE");
});

test("5回の誤PINで接続元を一時的に制限する", async () => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await login(`wrong-${attempt}`);
    assert.equal(response.status, 401);
  }
  const fifth = await login("wrong-5");
  assert.equal(fifth.status, 429);
  assert.equal((await fifth.json()).error.code, "OPERATOR_LOGIN_RATE_LIMITED");
  const correctDuringLock = await login("1234");
  assert.equal(correctDuringLock.status, 429);
});

test("同じrevisionの運営操作が同時送信されても一度だけ反映する", async () => {
  assert.equal((await operator("reset")).status, 200);
  const state = await fetch(`${BASE}/api/state?role=operator`, {
    headers: { cookie: operatorCookie }
  }).then((response) => response.json());

  const send = () => jsonRequest("/api/operator/actions", {
    cookie: operatorCookie,
    body: { action: "advance", expectedRevision: state.revision }
  });
  const responses = await Promise.all([send(), send()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

  const after = await fetch(`${BASE}/api/state?role=operator`, {
    headers: { cookie: operatorCookie }
  }).then((response) => response.json());
  assert.equal(after.phase, "intro");
});
