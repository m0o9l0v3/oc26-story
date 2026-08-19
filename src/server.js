import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { story } from "./story-data.js";
import { StorySession } from "./session.js";

const PORT = Number(process.env.PORT || 3000);
const OPERATOR_PIN = process.env.OPERATOR_PIN || "260822";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const session = new StorySession(story);
const eventClients = new Set();
const participantConnections = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function connectedParticipantCount() {
  return participantConnections.size;
}

function publicState() {
  return session.getPublicState(connectedParticipantCount());
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("request body is too large");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("invalid JSON");
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const client of eventClients) client.response.write(payload);
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

function handleEvents(request, response, url) {
  const role = url.searchParams.get("role") || "participant";
  const clientId = url.searchParams.get("clientId") || "";
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write("retry: 2000\n\n");

  const client = { response, role, clientId };
  eventClients.add(client);
  if (role === "participant") addParticipantConnection(clientId);
  broadcast();

  request.on("close", () => {
    eventClients.delete(client);
    if (role === "participant") removeParticipantConnection(clientId);
    broadcast();
  });
}

function requireOperator(request) {
  return request.headers["x-operator-pin"] === OPERATOR_PIN;
}

async function handleVote(request, response) {
  const body = await readJson(request);
  session.castVote(body.participantId, body.choiceId);
  broadcast();
  sendJson(response, 200, { ok: true });
}

async function handleOperator(request, response) {
  if (!requireOperator(request)) {
    sendJson(response, 401, { error: "運営者PINが違います" });
    return;
  }

  const body = await readJson(request);
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
    case "set-manual-counts":
      session.setManualCounts(body.counts ?? {});
      break;
    case "reset":
      session.reset();
      break;
    default:
      throw new Error("unknown operator action");
  }

  broadcast();
  sendJson(response, 200, { ok: true, state: publicState() });
}

function serveStatic(response, pathname) {
  const requestedPath = ["/", "/participant", "/display", "/operator"].includes(pathname)
    ? "/index.html"
    : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "not found" });
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
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, publicState());
    } else if (request.method === "GET" && url.pathname === "/api/events") {
      handleEvents(request, response, url);
    } else if (request.method === "POST" && url.pathname === "/api/vote") {
      await handleVote(request, response);
    } else if (request.method === "POST" && url.pathname === "/api/operator") {
      await handleOperator(request, response);
    } else if (request.method === "GET") {
      serveStatic(response, url.pathname);
    } else {
      sendJson(response, 405, { error: "method not allowed" });
    }
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "unknown error" });
  }
});

const heartbeat = setInterval(() => {
  for (const client of eventClients) client.response.write(": heartbeat\n\n");
}, 15_000);
heartbeat.unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OC26 Story: http://localhost:${PORT}`);
  console.log(`参加者: http://localhost:${PORT}/participant`);
  console.log(`中央表示: http://localhost:${PORT}/display`);
  console.log(`運営者: http://localhost:${PORT}/operator`);
  if (!process.env.OPERATOR_PIN) {
    console.warn("警告: OPERATOR_PINが未設定のため、開発用PIN 260822 を使用しています");
  }
});
