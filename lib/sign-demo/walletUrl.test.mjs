import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHostedWalletSignUrl,
  callbackUrl,
  fromBase64Url,
  toBase64Url,
} from "./walletUrl.core.mjs";

describe("walletUrl", () => {
  it("toBase64Url strips padding and swaps chars", () => {
    const b64 = "SGVsbG8=";
    const url = toBase64Url(b64);
    assert.equal(url, "SGVsbG8");
    assert.equal(fromBase64Url(url), b64);
    assert.equal(toBase64Url("a+b/cA=="), "a-b_cA");
    assert.equal(fromBase64Url("a-b_cA"), "a+b/cA==");
  });

  it("buildHostedWalletSignUrl encodes params", () => {
    const url = buildHostedWalletSignUrl("http://localhost:3000", {
      network: "testnet",
      account: "CABC",
      callback: "http://localhost:3000/dev/sign-demo/callback",
      requestId: "req-1",
      submit: true,
      origin: "http://localhost:3000",
      xdr: "AAAA",
    });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/wallet/sign");
    assert.equal(parsed.searchParams.get("network"), "testnet");
    assert.equal(parsed.searchParams.get("account"), "CABC");
    assert.equal(parsed.searchParams.get("xdr"), "AAAA");
    assert.equal(parsed.searchParams.get("submit"), "true");
  });

  it("callbackUrl normalizes origin", () => {
    assert.equal(
      callbackUrl("http://localhost:3000/"),
      "http://localhost:3000/dev/sign-demo/callback"
    );
  });
});
