import { hash, xdr } from "@stellar/stellar-sdk";

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
