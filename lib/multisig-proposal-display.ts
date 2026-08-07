import { formatAmountFromI128 } from "@/lib/stellar-assets";

export type ProposalOperationParams = {
  tokenContractId?: string;
  recipient?: string;
  amountI128?: string;
  assetId?: string;
  symbol?: string;
  amount?: string;
};

function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function formatProposalTitle(
  operationKind: string,
  operationParams: ProposalOperationParams = {}
): string {
  if (operationKind === "counter_increment") {
    return "Counter increment";
  }
  if (operationKind === "sac_transfer") {
    const symbol = operationParams.symbol ?? operationParams.assetId ?? "token";
    const amount =
      operationParams.amount ??
      (operationParams.amountI128
        ? formatAmountFromI128(BigInt(operationParams.amountI128), 7)
        : "?");
    const recipient = operationParams.recipient
      ? truncateAddress(operationParams.recipient)
      : "…";
    return `Send ${amount} ${symbol} → ${recipient}`;
  }
  return operationKind;
}

export function formatSacTransferDetail(
  operationParams: ProposalOperationParams
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (operationParams.symbol || operationParams.assetId) {
    rows.push({
      label: "Asset",
      value: operationParams.symbol ?? operationParams.assetId ?? "—",
    });
  }
  if (operationParams.amount) {
    rows.push({ label: "Amount", value: operationParams.amount });
  } else if (operationParams.amountI128) {
    rows.push({
      label: "Amount",
      value: formatAmountFromI128(BigInt(operationParams.amountI128), 7),
    });
  }
  if (operationParams.recipient) {
    rows.push({ label: "Recipient", value: operationParams.recipient });
  }
  if (operationParams.tokenContractId) {
    rows.push({ label: "Token contract", value: operationParams.tokenContractId });
  }
  return rows;
}
