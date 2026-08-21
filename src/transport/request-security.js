import { ApiError } from "./api-error.js";

const MAX_JSON_BYTES = 64 * 1024;

export function isSecureRequest(request) {
  if (request.socket?.encrypted) return true;
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https";
}

export function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) {
    throw new ApiError(403, "ORIGIN_REQUIRED", "送信元を確認できないため操作を受け付けられません");
  }

  let originHost;
  try {
    originHost = new URL(String(origin)).host;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "この送信元からの操作は許可されていません");
  }

  const requestHost = String(request.headers.host ?? "").trim().toLowerCase();
  if (!requestHost || originHost.toLowerCase() !== requestHost) {
    throw new ApiError(403, "INVALID_ORIGIN", "この送信元からの操作は許可されていません");
  }
}

export function assertJsonContentType(request) {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (contentType.split(";", 1)[0].trim() !== "application/json") {
    throw new ApiError(
      415,
      "CONTENT_TYPE_REQUIRED",
      "Content-Type に application/json を指定してください"
    );
  }
}

export async function readJson(request) {
  assertJsonContentType(request);
  let byteLength = 0;
  const chunks = [];
  for await (const chunk of request) {
    byteLength += chunk.byteLength;
    if (byteLength > MAX_JSON_BYTES) {
      throw new ApiError(413, "REQUEST_TOO_LARGE", "リクエスト本文が大きすぎます");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("JSON object required");
    }
    return parsed;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "JSONの形式が正しくありません");
  }
}

export function clientAddress(request) {
  if (process.env.TRUST_CF_CONNECTING_IP === "true") {
    const cloudflareAddress = String(request.headers["cf-connecting-ip"] ?? "").trim();
    if (cloudflareAddress) return cloudflareAddress;
  }
  return request.socket?.remoteAddress ?? "unknown";
}
