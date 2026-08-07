import { Address, Keypair, xdr } from "@stellar/stellar-sdk";

/**
 * OpenZeppelin `Signer::Delegated` calls `require_auth_for_args((auth_digest,))`.
 * Build the unsigned entry so the client signs `hash(preimage)` for this row.
 */
export function buildUnsignedDelegatedGCheckAuthEntry(params: {
  smartAccountAddress: string;
  signerG: string;
  /** 32 bytes: auth_digest = sha256(signature_payload || context_rule_ids.to_xdr()). */
  authDigestHash: Buffer;
  signatureExpirationLedger: number;
}): xdr.SorobanAuthorizationEntry {
  if (params.authDigestHash.length !== 32) {
    throw new Error("authDigestHash must be 32 bytes");
  }
  const raw = Keypair.random().rawPublicKey();
  let nonce = 0;
  for (let i = 0; i < 6; i++) {
    nonce = (nonce << 8) | raw[i];
  }

  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(params.smartAccountAddress).toScAddress(),
    functionName: Buffer.from("__check_auth", "utf8"),
    args: [xdr.ScVal.scvBytes(params.authDigestHash)],
  });

  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs),
    subInvocations: [],
  });

  const addrCreds = new xdr.SorobanAddressCredentials({
    address: Address.fromString(params.signerG).toScAddress(),
    nonce: new xdr.Int64(nonce),
    signatureExpirationLedger: params.signatureExpirationLedger,
    signature: xdr.ScVal.scvVec([]),
  });

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(addrCreds),
    rootInvocation,
  });
}
