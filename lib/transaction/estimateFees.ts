import type { rpc } from "@stellar/stellar-sdk";

export type FeeEstimate = {
  estimatedFeeXlm: string;
  estimatedFeeUsd?: string;
  feeLabel: string;
};

const STROOPS_PER_XLM = 10_000_000n;

function formatXlmFromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

export function estimateFees(
  simResult: rpc.Api.SimulateTransactionSuccessResponse,
  txBaseFee: string
): FeeEstimate {
  const resourceFee = BigInt(simResult.minResourceFee ?? "0");
  const baseFee = BigInt(txBaseFee || "0");
  const totalStroops = resourceFee + baseFee;

  return {
    estimatedFeeXlm: formatXlmFromStroops(totalStroops),
    feeLabel: "Fast",
  };
}
