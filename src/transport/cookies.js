const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      // Malformed cookies are ignored rather than failing the whole request.
    }
  }
  return cookies;
}

export function readSessionToken(request, name) {
  const token = parseCookies(request.headers.cookie).get(name);
  return typeof token === "string" && TOKEN_PATTERN.test(token) ? token : null;
}

export function serializeSessionCookie(name, value, {
  maxAge,
  secure = false
} = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
