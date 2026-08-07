import { xdr, Address } from "@stellar/stellar-sdk";
import { sortScMapEntries } from "@/lib/sc-map-utils";

export type WebauthnApprovalInput = {
  verifierAddress: string;
  keyDataHex: string;
  sigDataXdrHex: string;
};

export type DelegatedApprovalInput = {
  gAddress: string;
  // Delegated signers live in AuthPayload.signers with empty bytes.
};

export type BuildMultisigAuthPayloadParams = {
  contextRuleId: number;
  webauthn: WebauthnApprovalInput[];
  delegated: DelegatedApprovalInput[];
};

function normalizeHex(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

export function buildMultisigAuthPayload(params: BuildMultisigAuthPayloadParams): xdr.ScVal {
  const ruleId = Number(params.contextRuleId);
  if (!Number.isInteger(ruleId) || ruleId < 0) {
    throw new Error("contextRuleId must be a non-negative integer");
  }

  const entriesByKey = new Map<string, xdr.ScMapEntry>();

  // WebAuthn external signers
  for (const w of params.webauthn) {
    const keyDataBytes = Buffer.from(normalizeHex(w.keyDataHex), "hex");
    const sigDataBytes = Buffer.from(normalizeHex(w.sigDataXdrHex), "hex");
    const signerKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("External"),
      xdr.ScVal.scvAddress(Address.fromString(w.verifierAddress).toScAddress()),
      xdr.ScVal.scvBytes(keyDataBytes),
    ]);
    const k = `External:${w.verifierAddress}:${normalizeHex(w.keyDataHex)}`;
    entriesByKey.set(
      k,
      new xdr.ScMapEntry({
        key: signerKey,
        val: xdr.ScVal.scvBytes(sigDataBytes),
      })
    );
  }

  // Delegated G-address signers: value is empty bytes
  for (const d of params.delegated) {
    const signerKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Delegated"),
      new Address(d.gAddress).toScVal(),
    ]);
    const k = `Delegated:${d.gAddress}`;
    entriesByKey.set(
      k,
      new xdr.ScMapEntry({
        key: signerKey,
        val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
      })
    );
  }

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(ruleId)]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap(sortScMapEntries([...entriesByKey.values()])),
    }),
  ]);
}

