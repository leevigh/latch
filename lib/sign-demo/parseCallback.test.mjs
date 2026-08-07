import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCallbackResult, stellarExpertTxUrl } from "./parseCallback.core.mjs";

describe("parseCallback", () => {
  it("parses signed status from query", () => {
    const result = parseCallbackResult(
      "requestId=abc&status=signed&txHash=hash123&network=testnet",
      ""
    );
    assert.equal(result.status, "signed");
    assert.equal(result.requestId, "abc");
    assert.equal(result.txHash, "hash123");
    assert.equal(result.network, "testnet");
  });

  it("parses rejected status", () => {
    const result = parseCallbackResult("status=rejected&requestId=r1", "");
    assert.equal(result.status, "rejected");
  });

  it("parses error with code and message", () => {
    const result = parseCallbackResult(
      "status=error&code=user_rejected&message=User+declined",
      ""
    );
    assert.equal(result.status, "error");
    assert.equal(result.code, "user_rejected");
    assert.equal(result.message, "User declined");
  });

  it("reads signedAuthEntry from hash", () => {
    const result = parseCallbackResult(
      "status=signed",
      "#signedAuthEntry=entryXdr123"
    );
    assert.equal(result.signedAuthEntry, "entryXdr123");
  });

  it("defaults to error when status missing", () => {
    const result = parseCallbackResult("requestId=x", "");
    assert.equal(result.status, "error");
  });

  it("stellarExpertTxUrl uses testnet by default", () => {
    assert.equal(
      stellarExpertTxUrl(undefined, "abc"),
      "https://stellar.expert/explorer/testnet/tx/abc"
    );
  });
});
