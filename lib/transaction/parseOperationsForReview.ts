import { Address, scValToNative, type Transaction } from "@stellar/stellar-sdk";
import {
  formatAmountFromI128,
  getAssetCatalog,
  type CatalogAsset,
} from "@/lib/stellar-assets";
import {
  extractTargetContractId,
  getInvokeHostFunctionOps,
  invokeFunctionArgs,
  invokeFunctionName,
} from "@/lib/transaction/validateExternalTx";

export type PreparedSignOperation = {
  type: string;
  summary: string;
  details?: Record<string, string>;
};

export function truncateAddress(addr: string): string {
  if (addr.length <= 11) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-3)}`;
}

function findAssetByContract(
  contractId: string,
  networkPassphrase: string
): CatalogAsset | undefined {
  return getAssetCatalog(networkPassphrase).find((a) => a.contractId === contractId);
}

function parseTransferOperation(
  contractId: string,
  args: unknown[],
  networkPassphrase: string
): PreparedSignOperation | null {
  if (args.length < 3) return null;

  const from = String(args[0]);
  const to = String(args[1]);
  const amountRaw =
    typeof args[2] === "bigint" ? args[2] : BigInt(String(args[2]));

  const asset = findAssetByContract(contractId, networkPassphrase);
  const symbol = asset?.symbol ?? "Token";
  const decimals = asset?.decimals ?? 7;
  const amount = formatAmountFromI128(amountRaw, decimals);

  return {
    type: "sac_transfer",
    summary: `Transfer ${amount} ${symbol} to ${truncateAddress(to)}`,
    details: {
      asset: symbol,
      amount,
      recipient: to,
      sender: from,
      contractId,
    },
  };
}

export function parseOperationsForReview(
  tx: Transaction,
  networkPassphrase: string
): PreparedSignOperation[] {
  const ops = getInvokeHostFunctionOps(tx);
  const rows: PreparedSignOperation[] = [];

  for (const op of ops) {
    const contractId = extractTargetContractIdFromOp(op);
    if (!contractId) {
      rows.push({
        type: "unknown",
        summary: "Contract interaction",
      });
      continue;
    }

    const fnName = invokeFunctionName(op);
    const args = invokeFunctionArgs(op).map((arg) => scValToNative(arg));

    if (fnName === "transfer") {
      const transferRow = parseTransferOperation(contractId, args, networkPassphrase);
      if (transferRow) {
        rows.push(transferRow);
        continue;
      }
    }

    if (fnName) {
      rows.push({
        type: "contract_call",
        summary: `Call ${truncateAddress(contractId)}::${fnName}`,
        details: {
          contractId,
          function: fnName,
        },
      });
    } else {
      rows.push({
        type: "contract_call",
        summary: `Call ${truncateAddress(contractId)}`,
        details: { contractId },
      });
    }
  }

  if (rows.length === 0) {
    const fallbackContract = extractTargetContractId(tx);
    rows.push({
      type: "unknown",
      summary: fallbackContract
        ? `Contract interaction (${truncateAddress(fallbackContract)})`
        : "Contract interaction",
      details: fallbackContract ? { contractId: fallbackContract } : undefined,
    });
  }

  return rows;
}

function extractTargetContractIdFromOp(
  op: import("@stellar/stellar-sdk").Operation.InvokeHostFunction
): string | null {
  const func = op.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") return null;
  try {
    return Address.fromScAddress(func.invokeContract().contractAddress()).toString();
  } catch {
    return null;
  }
}

export function buildReviewWarnings(params: {
  validUntilLedger: number;
  latestLedger: number;
  tx: Transaction;
  networkPassphrase: string;
}): string[] {
  const warnings: string[] = [];
  const { validUntilLedger, latestLedger, tx, networkPassphrase } = params;

  if (validUntilLedger - latestLedger < 100) {
    warnings.push("validUntilLedger is fewer than 100 ledgers away");
  }

  const catalog = getAssetCatalog(networkPassphrase);
  const knownContracts = new Set(catalog.map((a) => a.contractId));

  for (const op of getInvokeHostFunctionOps(tx)) {
    const contractId = extractTargetContractIdFromOp(op);
    if (contractId && !knownContracts.has(contractId)) {
      const smartAccountOnTx = op.source;
      if (contractId !== smartAccountOnTx) {
        warnings.push("unknown contract — review carefully");
        break;
      }
    }
  }

  return warnings;
}
