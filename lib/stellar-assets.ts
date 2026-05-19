import { Networks, StrKey } from "@stellar/stellar-sdk";

export type CatalogAsset = {
  assetId: string;
  symbol: string;
  name: string;
  contractId: string;
  decimals: number;
};

/** Testnet native XLM SAC (Stellar Asset Contract for XLM). */
export const TESTNET_NATIVE_XLM_SAC =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/**
 * Circle testnet USDC SAC (classic: USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5).
 * stellar contract id asset --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet
 */
export const TESTNET_USDC_SAC_DEFAULT =
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const TESTNET_CATALOG: CatalogAsset[] = [
  {
    assetId: "native",
    symbol: "XLM",
    name: "Stellar Lumens",
    contractId: TESTNET_NATIVE_XLM_SAC,
    decimals: 7,
  },
  {
    assetId: "USDC",
    symbol: "USDC",
    name: "USD Coin",
    contractId: TESTNET_USDC_SAC_DEFAULT,
    decimals: 7,
  },
];

function parseAllowlistJson(): CatalogAsset[] | null {
  const raw = process.env.NEXT_PUBLIC_ASSET_ALLOWLIST_JSON;
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as CatalogAsset[];
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (a) =>
        a &&
        typeof a.assetId === "string" &&
        typeof a.contractId === "string" &&
        typeof a.decimals === "number"
    );
  } catch {
    return null;
  }
}

function filterValidSacCatalog(assets: CatalogAsset[]): CatalogAsset[] {
  return assets.filter((a) => {
    if (StrKey.isValidContract(a.contractId)) return true;
    console.warn(
      `[stellar-assets] Dropping catalog entry ${a.assetId}: invalid contract id ${a.contractId}`
    );
    return false;
  });
}

export function getAssetCatalog(networkPassphrase: string): CatalogAsset[] {
  const allowlist = parseAllowlistJson();
  if (allowlist?.length) return filterValidSacCatalog(allowlist);

  if (networkPassphrase === Networks.TESTNET) {
    const nativeOverride = process.env.NEXT_PUBLIC_NATIVE_SAC_ADDRESS;
    const usdcOverride = process.env.NEXT_PUBLIC_USDC_SAC_ADDRESS;
    const catalog = TESTNET_CATALOG.map((a) => {
      if (a.assetId === "native" && nativeOverride) {
        return { ...a, contractId: nativeOverride };
      }
      if (a.assetId === "USDC" && usdcOverride) {
        return { ...a, contractId: usdcOverride };
      }
      return a;
    });
    return filterValidSacCatalog(catalog);
  }

  return filterValidSacCatalog(allowlist ?? []);
}

export function resolveAsset(
  networkPassphrase: string,
  assetId?: string,
  contractId?: string
): CatalogAsset {
  const catalog = getAssetCatalog(networkPassphrase);

  if (contractId) {
    const byContract = catalog.find((a) => a.contractId === contractId);
    if (byContract) return byContract;
    throw new Error(
      `contractId ${contractId} is not in the asset allowlist. Set NEXT_PUBLIC_ASSET_ALLOWLIST_JSON.`
    );
  }

  if (!assetId) {
    throw new Error("Provide assetId or contractId");
  }

  const asset = catalog.find((a) => a.assetId === assetId);
  if (!asset) {
    throw new Error(
      `Unknown assetId "${assetId}". Known: ${catalog.map((a) => a.assetId).join(", ")}`
    );
  }
  return asset;
}

/** Parse user amount string (human units) to i128 stroops/minimal units. */
export function parseAmountToI128(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("amount must be a positive decimal number");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places`);
  }
  const fracPadded = frac.padEnd(decimals, "0");
  const combined = whole + fracPadded;
  const value = BigInt(combined.replace(/^0+/, "") || "0");
  if (value <= 0n) {
    throw new Error("amount must be greater than zero");
  }
  return value;
}

export function formatAmountFromI128(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
