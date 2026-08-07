import * as crypto from "crypto";
import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { computeAuthDigestHex } from "@/lib/soroban-auth-payload";

/**
 * OZ `do_check_auth` binds context rules into the digest delegated signers must prove:
 *   auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
 * Delegated(G) signers call `require_auth_for_args((auth_digest,))`, so the G auth entry
 * must authorize `smartAccount.__check_auth(auth_digest)` — not signature_payload.
 */
export function authDigestHexFromSmartAccountEntry(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
  contextRuleIds: number[]
): string {
  return computeAuthDigestHex(entry, networkPassphrase, contextRuleIds);
}

/** 32-byte arg to smartAccount.__check_auth from a delegated G auth entry template. */
export function delegatedCheckAuthArgHex(entry: xdr.SorobanAuthorizationEntry): string | null {
  try {
    const inv = entry.rootInvocation();
    const fn = inv.function();
    if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") return null;
    const args = fn.contractFn();
    const name = Buffer.from(args.functionName()).toString("utf8");
    if (name !== "__check_auth" || args.args().length !== 1) return null;
    const arg = args.args()[0];
    if (arg.switch().name !== "scvBytes") return null;
    return Buffer.from(arg.bytes()).toString("hex");
  } catch {
    return null;
  }
}

export function buildDelegatedCheckAuthTemplate(args: {
  networkPassphrase: string;
  smartAccountAddress: string;
  signerG: string;
  smartAccountAuthEntry: xdr.SorobanAuthorizationEntry;
  contextRuleIds: number[];
  validUntilLedger: number;
}): {
  authDigestHex: string;
  preimageXdrBase64: string;
  entryTemplateXdrBase64: string;
} {
  const authDigestHex = authDigestHexFromSmartAccountEntry(
    args.smartAccountAuthEntry,
    args.networkPassphrase,
    args.contextRuleIds
  );
  const authDigest = Buffer.from(authDigestHex, "hex");
  if (authDigest.length !== 32) {
    throw new Error("Computed auth_digest must be 32 bytes");
  }

  const nonceBytes = crypto.randomBytes(8);
  const nonce = nonceBytes.readBigInt64BE(0) as unknown as xdr.Int64;

  const gAddrInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(args.smartAccountAddress).toScAddress(),
        functionName: "__check_auth",
        args: [xdr.ScVal.scvBytes(authDigest)],
      })
    ),
    subInvocations: [],
  });

  const networkId = hash(Buffer.from(args.networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce,
      signatureExpirationLedger: args.validUntilLedger,
      invocation: gAddrInvocation,
    })
  );

  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(args.signerG).toScAddress(),
        nonce,
        signatureExpirationLedger: args.validUntilLedger,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: gAddrInvocation,
  });

  return {
    authDigestHex,
    preimageXdrBase64: preimage.toXDR("base64"),
    entryTemplateXdrBase64: entry.toXDR("base64"),
  };
}

export function verifyDelegatedFreighterSignature(args: {
  entryTemplateXdrBase64: string;
  signedAuthEntryBase64: string;
  signerAddress: string;
  networkPassphrase: string;
}): void {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(args.entryTemplateXdrBase64, "base64");
  const raw = Buffer.from(args.signedAuthEntryBase64, "base64");

  if (raw.length > 128) {
    xdr.SorobanAuthorizationEntry.fromXDR(raw);
    return;
  }
  if (raw.length !== 64) {
    throw new Error(`Expected a 64-byte Freighter signature, got ${raw.length} bytes`);
  }

  const addrAuth = entry.credentials().address();
  const networkId = hash(Buffer.from(args.networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: addrAuth.nonce(),
      signatureExpirationLedger: addrAuth.signatureExpirationLedger(),
      invocation: entry.rootInvocation(),
    })
  );
  const payload = hash(preimage.toXDR());
  const kp = Keypair.fromPublicKey(args.signerAddress);
  if (!kp.verify(payload, raw)) {
    throw new Error(
      "Freighter signature does not match this delegated approval template. Approve again with Freighter."
    );
  }
}

export function applyDelegatedFreighterSignature(
  entryTemplateXdrBase64: string,
  signedAuthEntryBase64: string,
  signerAddress: string
): xdr.SorobanAuthorizationEntry {
  const raw = Buffer.from(signedAuthEntryBase64, "base64");
  if (raw.length > 128) {
    return xdr.SorobanAuthorizationEntry.fromXDR(raw);
  }
  if (raw.length !== 64) {
    throw new Error(`Expected a 64-byte Freighter signature, got ${raw.length} bytes`);
  }

  const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryTemplateXdrBase64, "base64");
  const pubkeyBytes = StrKey.decodeEd25519PublicKey(signerAddress);
  const sigScVal = nativeToScVal(
    {
      public_key: pubkeyBytes,
      signature: raw,
    },
    {
      type: {
        public_key: ["symbol", null],
        signature: ["symbol", null],
      },
    }
  );
  entry.credentials().address().signature(xdr.ScVal.scvVec([sigScVal]));
  return entry;
}
