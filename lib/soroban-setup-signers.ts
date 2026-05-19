import { Address, Contract, nativeToScVal, Operation, xdr } from "@stellar/stellar-sdk";
import type { CatalogAsset } from "@/lib/stellar-assets";
import type { SignerType } from "@/lib/soroban-transaction-build";

/** OpenZeppelin stellar-accounts MAX_NAME_SIZE */
export const CONTEXT_RULE_NAME_MAX_LEN = 20;

export function buildContextRuleName(asset: CatalogAsset, prefix = "send"): string {
  const name = `${prefix}-${asset.assetId}`;
  if (name.length > CONTEXT_RULE_NAME_MAX_LEN) {
    throw new Error(
      `Context rule name "${name}" exceeds ${CONTEXT_RULE_NAME_MAX_LEN} chars (OZ SmartAccountError #3015). Use a shorter assetId in the allowlist.`
    );
  }
  return name;
}

export function buildCallContractContextType(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("CallContract"),
    new Address(contractId).toScVal(),
  ]);
}

export function buildAddContextRuleOperation(
  smartAccount: Contract,
  asset: CatalogAsset,
  signersVec: xdr.ScVal,
  namePrefix = "send"
): Operation {
  return smartAccount.call(
    "add_context_rule",
    buildCallContractContextType(asset.contractId),
    nativeToScVal(buildContextRuleName(asset, namePrefix), { type: "string" }),
    xdr.ScVal.scvVoid(),
    signersVec,
    xdr.ScVal.scvMap([])
  ) as Operation;
}

export function buildAddContextRuleOperations(
  smartAccount: Contract,
  assets: CatalogAsset[],
  signersVec: xdr.ScVal,
  namePrefix = "send"
): Operation[] {
  return assets.map((asset) =>
    buildAddContextRuleOperation(smartAccount, asset, signersVec, namePrefix)
  );
}

export function buildExternalSignerScVal(
  verifierAddress: string,
  keyData: Buffer
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(verifierAddress).toScVal(),
    xdr.ScVal.scvBytes(keyData),
  ]);
}

export function buildDelegatedSignerScVal(gAddress: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(gAddress).toScVal(),
  ]);
}

export function buildSignersVecForSetup(args: {
  signerType: SignerType;
  verifierAddress?: string;
  publicKeyHex?: string;
  keyDataHex?: string;
  gAddress?: string;
}): xdr.ScVal {
  const { signerType } = args;

  if (signerType === "phantom") {
    if (!args.verifierAddress || !args.publicKeyHex) {
      throw new Error("verifierAddress and publicKeyHex required for phantom setup");
    }
    if (args.publicKeyHex.length !== 64) {
      throw new Error("publicKeyHex must be 64 hex chars");
    }
    return xdr.ScVal.scvVec([
      buildExternalSignerScVal(
        args.verifierAddress,
        Buffer.from(args.publicKeyHex, "hex")
      ),
    ]);
  }

  if (signerType === "passkey") {
    if (!args.verifierAddress || !args.keyDataHex) {
      throw new Error("verifierAddress and keyDataHex required for passkey setup");
    }
    return xdr.ScVal.scvVec([
      buildExternalSignerScVal(
        args.verifierAddress,
        Buffer.from(args.keyDataHex, "hex")
      ),
    ]);
  }

  if (signerType === "freighter") {
    if (!args.gAddress) {
      throw new Error("gAddress required for freighter setup");
    }
    return xdr.ScVal.scvVec([buildDelegatedSignerScVal(args.gAddress)]);
  }

  throw new Error(`Unknown signerType: ${signerType}`);
}
