import { createReadStream, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { story } from "./story-data.js";
import { StorySession } from "./session.js";
import { projectStateForRole, resolveStateRole } from "./application/state-projections.js";
import { SnapshotStore } from "./infrastructure/snapshot-store.js";
import { ApiError, toApiError } from "./transport/api-error.js";
import {
  ExpiringSessionStore,
  FixedWindowRateLimiter,
  LoginAttemptLimiter,
  pinsEqual
} from "./transport/auth-sessions.js";
import {
  readSessionToken,
  serializeSessionCookie
} from "./transport/cookies.js";
import {
  assertSameOrigin,
  clientAddress,
  isSecureRequest,
  readJson
} from "./transport/request-security.js";

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_OPERATOR_PIN = "260822";
const OPERATOR_PIN = process.env.OPERATOR_PIN || DEFAULT_OPERATOR_PIN;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const session = new StorySession(story);
const serverInstanceId = randomUUID();
const snapshotStore = new SnapshotStore({ directory: DATA_DIR, story });
let recoveryStatus = { status: "empty", resetIncompleteVote: false, issues: [] };
let persistenceError = null;
let operatorActionTail = Promise.resolve();
const eventClients = new Set();
const participantConnections = new Map();
const participantActivity = new Map();
const PARTICIPANT_ACTIVE_WINDOW_MS = 15_000;
const PARTICIPANT_COOKIE = "oc26_participant";
const OPERATOR_COOKIE = "oc26_operator";
function testDuration(name, fallback) {
  if (process.env.NODE_ENV !== "test") return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 10 ? value : fallback;
}
const PARTICIPANT_TTL_MS = testDuration("TEST_PARTICIPANT_TTL_MS", 12 * 60 * 60_000);
const OPERATOR_TTL_MS = testDuration("TEST_OPERATOR_TTL_MS", 2 * 60 * 60_000);
const HEARTBEAT_INTERVAL_MS = testDuration("TEST_HEARTBEAT_INTERVAL_MS", 15_000);
const participantSessions = new ExpiringSessionStore(PARTICIPANT_TTL_MS);
const operatorSessions = new ExpiringSessionStore(OPERATOR_TTL_MS);
const loginAttempts = new LoginAttemptLimiter();
const voteRateLimiter = new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000 });
const OPERATOR_ACTIONS = new Set([
  "advance",
  "open-vote",
  "close-vote",
  "draw",
  "set-beta",
  "set-mode",
  "emergency-manual",
  "set-manual-counts",
  "reset"
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function connectedParticipantCount() {
  const now = Date.now();
  for (const [participantId, lastSeenAt] of participantActivity) {
    if (now - lastSeenAt > PARTICIPANT_ACTIVE_WINDOW_MS && !participantConnections.has(participantId)) {
      participantActivity.delete(participantId);
    }
  }
  return new Set([...participantConnections.keys(), ...participantActivity.keys()]).size;
}

function fullState() {
  return session.getPublicState(connectedParticipantCount());
}

function stateForRole(role, participantId = null) {
  const projected = projectStateForRole(fullState(), role);
  if (role !== "participant") return { ...projected, serverInstanceId };
  return {
    ...projected,
    serverInstanceId,
    selectedChoiceId: participantId ? (session.votes.get(participantId) ?? null) : null
  };
}

function restoreBeforeFailedOperatorAction(snapshot, votes, manualCounts, recoveryNotice) {
  session.restoreSnapshot(snapshot);
  session.votes = votes;
  session.manualCounts = manualCounts;
  session.recoveryNotice = recoveryNotice;
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  const apiError = toApiError(error);
  sendJson(response, apiError.status, {
    error: { code: apiError.code, message: apiError.message }
  }, apiError.headers);
}

async function persistSession() {
  try {
    await snapshotStore.save(session.createSnapshot());
    persistenceError = null;
    recoveryStatus = { status: "restored", source: "current", resetIncompleteVote: false, issues: [] };
  } catch (error) {
    persistenceError = error instanceof Error ? error.message : "状態を保存できません";
    throw new ApiError(503, "SNAPSHOT_SAVE_FAILED", "進行状態を保存できませんでした。主担当へ確認してください");
  }
}

function broadcast() {
  for (const client of eventClients) {
    const state = stateForRole(client.role, client.participantId);
    const payload = `id: ${state.revision ?? session.revision}\nevent: message\ndata: ${JSON.stringify(state)}\n\n`;
    client.response.write(payload);
  }
}

function addParticipantConnection(clientId) {
  if (!clientId) return;
  participantConnections.set(clientId, (participantConnections.get(clientId) ?? 0) + 1);
}

function removeParticipantConnection(clientId) {
  if (!clientId) return;
  const next = (participantConnections.get(clientId) ?? 1) - 1;
  if (next <= 0) participantConnections.delete(clientId);
  else participantConnections.set(clientId, next);
}

function operatorToken(request) {
  return readSessionToken(request, OPERATOR_COOKIE);
}

function participantToken(request) {
  return readSessionToken(request, PARTICIPANT_COOKIE);
}

function requireOperator(request) {
  const token = operatorToken(request);
  if (!operatorSessions.has(token)) {
    throw new ApiError(401, "OPERATOR_AUTH_REQUIRED", "運営者としてログインしてください");
  }
  return token;
}

function requireParticipant(request) {
  const token = participantToken(request);
  if (!participantSessions.has(token)) {
    throw new ApiError(401, "PARTICIPANT_SESSION_REQUIRED", "参加者セッションを開始してください");
  }
  participantActivity.set(token, Date.now());
  return token;
}

function handleEvents(request, response, url) {
  const role = resolveStateRole(url.searchParams.get("role"));
  const participantId = role === "participant" ? requireParticipant(request) : null;
  if (role === "operator") requireOperator(request);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write("retry: 2000\n\n");

  const authToken = role === "participant" ? participantId : role === "operator" ? operatorToken(request) : null;
  const client = { response, role, participantId, authToken };
  eventClients.add(client);
  if (participantId) addParticipantConnection(participantId);
  broadcast();

  request.on("close", () => {
    eventClients.delete(client);
    if (participantId) removeParticipantConnection(participantId);
    broadcast();
  });
}

async function handleParticipantSession(request, response) {
  assertSameOrigin(request);
  await readJson(request);
  const existing = participantToken(request);
  const participantId = participantSessions.has(existing)
    ? existing
    : participantSessions.create();
  participantActivity.set(participantId, Date.now());
  const headers = existing === participantId
    ? {}
    : {
        "set-cookie": serializeSessionCookie(PARTICIPANT_COOKIE, participantId, {
          maxAge: PARTICIPANT_TTL_MS / 1000,
          secure: isSecureRequest(request)
        })
      };
  sendJson(response, 200, { ok: true }, headers);
}

async function handleVote(request, response) {
  assertSameOrigin(request);
  const participantId = requireParticipant(request);
  if (!voteRateLimiter.consume(participantId)) {
    throw new ApiError(429, "VOTE_RATE_LIMITED", "操作が多すぎます。少し待ってから再度お試しください", {
      headers: { "retry-after": "60" }
    });
  }
  const body = await readJson(request);
  session.castVote(participantId, body.choiceId);
  broadcast();
  sendJson(response, 200, { ok: true, selectedChoiceId: body.choiceId });
}

async function handleOperatorLogin(request, response) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const address = clientAddress(request);
  if (loginAttempts.isLocked(address)) {
    throw new ApiError(429, "OPERATOR_LOGIN_RATE_LIMITED", "PINが違います", {
      headers: { "retry-after": "300" }
    });
  }
  if (typeof body.pin !== "string" || body.pin.length > 128 || !pinsEqual(body.pin, OPERATOR_PIN)) {
    const locked = loginAttempts.recordFailure(address);
    throw new ApiError(
      locked ? 429 : 401,
      locked ? "OPERATOR_LOGIN_RATE_LIMITED" : "INVALID_OPERATOR_PIN",
      "PINが違います",
      locked ? { headers: { "retry-after": "300" } } : {}
    );
  }
  loginAttempts.reset(address);
  const token = operatorSessions.create();
  sendJson(response, 200, { ok: true }, {
    "set-cookie": serializeSessionCookie(OPERATOR_COOKIE, token, {
      maxAge: OPERATOR_TTL_MS / 1000,
      secure: isSecureRequest(request)
    })
  });
}

async function handleOperatorLogout(request, response) {
  assertSameOrigin(request);
  await readJson(request);
  operatorSessions.delete(operatorToken(request));
  sendJson(response, 200, { ok: true }, {
    "set-cookie": serializeSessionCookie(OPERATOR_COOKIE, "", {
      maxAge: 0,
      secure: isSecureRequest(request)
    })
  });
}

async function handleOperator(request, response) {
  assertSameOrigin(request);
  requireOperator(request);
  const body = await readJson(request);
  if (!OPERATOR_ACTIONS.has(body.action)) {
    throw new ApiError(400, "INVALID_OPERATOR_ACTION", "運営操作が正しくありません");
  }
  if (!Number.isSafeInteger(body.expectedRevision)) {
    throw new ApiError(400, "EXPECTED_REVISION_REQUIRED", "画面の状態番号がありません。画面を再読み込みしてください");
  }
  if (body.expectedRevision !== session.revision) {
    throw new ApiError(409, "STALE_OPERATOR_STATE", "別の操作が先に反映されました。最新画面を確認してください");
  }
  const before = session.createSnapshot();
  const beforeVotes = new Map(session.votes);
  const beforeManualCounts = new Map(session.manualCounts);
  const beforeRecoveryNotice = session.recoveryNotice;
  switch (body.action) {
    case "advance":
      session.advance();
      break;
    case "open-vote":
      session.openVote();
      break;
    case "close-vote":
      session.closeVote();
      break;
    case "draw":
      session.draw();
      break;
    case "set-beta":
      session.setBeta(body.beta);
      break;
    case "set-mode":
      session.setMode(body.mode);
      break;
    case "emergency-manual":
      session.switchToManualEmergency();
      break;
    case "set-manual-counts":
      if (!body.counts || typeof body.counts !== "object" || Array.isArray(body.counts)) {
        throw new ApiError(400, "INVALID_MANUAL_COUNTS", "挙手数の形式が正しくありません");
      }
      if (Object.keys(body.counts).some((key) => !session.currentNode?.choices.some((choice) => choice.id === key))) {
        throw new ApiError(400, "INVALID_MANUAL_COUNTS", "存在しない選択肢の挙手数が含まれています");
      }
      session.setManualCounts(body.counts ?? {});
      break;
    case "reset":
      session.reset();
      break;
  }

  try {
    await persistSession();
  } catch (error) {
    restoreBeforeFailedOperatorAction(before, beforeVotes, beforeManualCounts, beforeRecoveryNotice);
    throw error;
  }
  broadcast();
  sendJson(response, 200, { ok: true, state: stateForRole("operator") }, {
    "x-oc26-revision": String(session.revision)
  });
}

function enqueueOperatorAction(task) {
  const queued = operatorActionTail.then(task, task);
  operatorActionTail = queued.catch(() => {});
  return queued;
}

function serveStatic(response, pathname) {
  const requestedPath = pathname === "/support"
    ? "/support.html"
    : ["/", "/participant", "/display", "/operator"].includes(pathname)
      ? "/index.html"
      : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendError(response, new ApiError(404, "NOT_FOUND", "ページが見つかりません"));
    return;
  }

  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
    "cache-control": extname(filePath) === ".html" ? "no-store" : "public, max-age=300"
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/health/live") {
      sendJson(response, 200, { status: "ok" });
    } else if (request.method === "GET" && url.pathname === "/health/ready") {
      const insecureProductionPin = process.env.NODE_ENV === "production"
        && (!process.env.OPERATOR_PIN || OPERATOR_PIN === DEFAULT_OPERATOR_PIN);
      const ready = !insecureProductionPin && recoveryStatus.status !== "unrecoverable" && !persistenceError;
      sendJson(response, ready ? 200 : 503, ready
        ? { status: "ready" }
        : {
            error: {
              code: "NOT_READY",
              message: insecureProductionPin
                ? "本番用の運営者PINが設定されていないか、開発用PINのままです"
                : persistenceError || "保存された進行状態を復元できません"
            }
          });
    } else if (request.method === "GET" && url.pathname === "/api/state") {
      const role = resolveStateRole(url.searchParams.get("role"));
      const participantId = role === "participant" ? requireParticipant(request) : null;
      if (role === "operator") requireOperator(request);
      sendJson(response, 200, stateForRole(role, participantId));
    } else if (request.method === "GET" && url.pathname === "/api/events") {
      handleEvents(request, response, url);
    } else if (request.method === "POST" && url.pathname === "/api/participants/session") {
      await handleParticipantSession(request, response);
    } else if (request.method === "PUT" && url.pathname === "/api/vote") {
      await handleVote(request, response);
    } else if (request.method === "POST" && url.pathname === "/api/operator/login") {
      await handleOperatorLogin(request, response);
    } else if (request.method === "POST" && url.pathname === "/api/operator/logout") {
      await handleOperatorLogout(request, response);
    } else if (request.method === "POST" && ["/api/operator", "/api/operator/actions"].includes(url.pathname)) {
      await enqueueOperatorAction(() => handleOperator(request, response));
    } else if (request.method === "GET" && url.pathname === "/api/operator/export") {
      requireOperator(request);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="oc26-state-${Date.now()}.json"`,
        "cache-control": "no-store"
      });
      response.end(`${JSON.stringify(session.createSnapshot(), null, 2)}\n`);
    } else if (request.method === "GET") {
      serveStatic(response, url.pathname);
    } else {
      sendError(response, new ApiError(405, "METHOD_NOT_ALLOWED", "このHTTPメソッドは利用できません"));
    }
  } catch (error) {
    sendError(response, error);
  }
});

const heartbeat = setInterval(() => {
  for (const client of eventClients) {
    const expired = client.role === "operator"
      ? !operatorSessions.has(client.authToken)
      : client.role === "participant"
        ? !participantSessions.has(client.authToken)
        : false;
    if (expired) {
      client.response.end();
      eventClients.delete(client);
      if (client.participantId) removeParticipantConnection(client.participantId);
      continue;
    }
    client.response.write(`event: heartbeat\ndata: {"serverInstanceId":"${serverInstanceId}"}\n\n`);
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

async function start() {
  try {
    await snapshotStore.probe();
    persistenceError = null;
  } catch (error) {
    persistenceError = `保存先へ書き込めません: ${error instanceof Error ? error.message : "不明なエラー"}`;
    console.error(`警告: ${persistenceError}`);
  }
  recoveryStatus = await snapshotStore.load();
  if (recoveryStatus.status === "restored") {
    session.restoreSnapshot(recoveryStatus.snapshot, {
      resetIncompleteVote: recoveryStatus.resetIncompleteVote,
      source: recoveryStatus.source
    });
    console.warn(`進行状態を${recoveryStatus.source === "previous" ? "前世代から" : ""}復元しました`);
  } else if (recoveryStatus.status === "unrecoverable") {
    session.recoveryNotice = "保存データが壊れているため初期状態で起動しました。主担当は状態を確認してから操作してください。";
    console.error("警告: 保存された進行状態を復元できません。初期状態で起動します");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`OC26 Story: http://localhost:${PORT}`);
    console.log(`参加者: http://localhost:${PORT}/participant`);
    console.log(`中央表示: http://localhost:${PORT}/display`);
    console.log(`運営者: http://localhost:${PORT}/operator`);
    console.log(`スタッフ: http://localhost:${PORT}/support`);
    if (!process.env.OPERATOR_PIN || (process.env.NODE_ENV === "production" && OPERATOR_PIN === DEFAULT_OPERATOR_PIN)) {
      console.warn("警告: 開発用PIN 260822 が使用されています。本番公開時は別のPINを設定してください");
    }
  });
}

start().catch((error) => {
  console.error("サーバーを起動できません", error);
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await operatorActionTail;
    await snapshotStore.save(session.createSnapshot());
  } catch (error) {
    console.error("終了時に進行状態を保存できませんでした", error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
