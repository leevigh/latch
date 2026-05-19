import { hash, xdr } from "@stellar/stellar-sdk";

/**
 * auth_digest = SHA256(signaturePayload || context_rule_ids.to_xdr())
 * Matches OZ smart account `do_check_auth` before verifier calls.
 */
export function computeAuthDigest(
  authEntry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
  contextRuleIds: number[]
): Buffer {
  const signaturePayload = hashSorobanAuthPayload(authEntry, networkPassphrase);
  const ruleIdsXdr = xdr.ScVal.scvVec(
    contextRuleIds.map((id) => xdr.ScVal.scvU32(id))
  ).toXDR();
  return hash(Buffer.concat([signaturePayload, Buffer.from(ruleIdsXdr)]));
}

export function computeAuthDigestHex(
  authEntry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
  contextRuleIds: number[]
): string {
  return computeAuthDigest(authEntry, networkPassphrase, contextRuleIds).toString("hex");
}

/**
 * SHA-256 of ENVELOPE_TYPE_SOROBAN_AUTHORIZATION preimage.
 * Must match stellar-base `authorizeEntry` (see @stellar/stellar-base/lib/auth.js).
 */
export function hashSorobanAuthPayload(
  authEntry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string
): Buffer {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(authEntry.toXDR());
  const addrAuth = clone.credentials().address();
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: addrAuth.nonce(),
      invocation: clone.rootInvocation(),
      signatureExpirationLedger: addrAuth.signatureExpirationLedger(),
    })
  );
  return hash(preimage.toXDR());
}
