import assert from "node:assert/strict";
import test from "node:test";
import { clientAddress } from "../src/transport/request-security.js";

test("Cloudflare接続元IPは明示的に信頼した場合だけ利用する", () => {
  const previous = process.env.TRUST_CF_CONNECTING_IP;
  const request = {
    headers: { "cf-connecting-ip": "203.0.113.25" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  try {
    process.env.TRUST_CF_CONNECTING_IP = "false";
    assert.equal(clientAddress(request), "127.0.0.1");
    process.env.TRUST_CF_CONNECTING_IP = "true";
    assert.equal(clientAddress(request), "203.0.113.25");
  } finally {
    if (previous === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
    else process.env.TRUST_CF_CONNECTING_IP = previous;
  }
});
