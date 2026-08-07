"use client";

import { useState } from "react";
import type { PrepareSignResponse } from "@/lib/sign-demo/types";
import { SignDemoApiError } from "@/lib/sign-demo/api";
import { isMissingContextRuleError } from "@/lib/context-rule-setup";

interface SignDemoApiResultProps {
  title: string;
  result?: PrepareSignResponse | Record<string, unknown> | null;
  error?: SignDemoApiError | Error | null;
}

function actionableHint(error: SignDemoApiError | Error): string | null {
  if (!(error instanceof SignDemoApiError) && error.name !== "SignDemoApiError") {
    return null;
  }
  const apiErr = error as SignDemoApiError;
  if (
    isMissingContextRuleError(
      apiErr.status,
      apiErr.code,
      apiErr.suggestedAction
    ) ||
    apiErr.suggestedAction === "setup_transfer_rule"
  ) {
    return "Missing CallContract send rule on-chain. Rebuild to auto-run setup-send-rules (you must approve the passkey/wallet prompt). Hitting setup-send-rules alone only builds the tx — it must be signed and submitted.";
  }
  if (apiErr.suggestedAction === "setup_swap_rule") {
    return "Run setup-swap-rules for this account, then retry.";
  }
  return null;
}

export function SignDemoApiResult({ title, result, error }: SignDemoApiResultProps) {
  const [showRaw, setShowRaw] = useState(false);

  if (error) {
    const code = error instanceof SignDemoApiError ? error.code : "error";
    const hint = actionableHint(error);
    return (
      <div className="rounded-xl border border-destructive/50 bg-destructive/5 p-3 space-y-2">
        <p className="text-sm font-medium text-destructive">{title} failed</p>
        <p className="text-xs font-mono text-destructive/80">code: {code}</p>
        <p className="text-sm text-destructive/90">{error.message}</p>
        {hint && (
          <p className="text-sm text-amber-800 dark:text-amber-300 border-t border-destructive/20 pt-2">
            {hint}
          </p>
        )}
      </div>
    );
  }

  if (!result) return null;

  const prep = result as PrepareSignResponse;
  const operations = prep.operations;
  const hasOperations = Array.isArray(operations) && operations.length > 0;

  return (
    <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
      <p className="text-sm font-medium">{title} — success</p>

      {hasOperations && (
        <ul className="space-y-1 text-sm">
          {operations.map((op, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground font-mono text-xs">{op.type}</span>
              <span>{op.summary}</span>
            </li>
          ))}
        </ul>
      )}

      {prep.estimatedFeeXlm && (
        <p className="text-sm">
          Fee: <span className="font-mono">{prep.estimatedFeeXlm}</span>
          {prep.feeLabel ? ` (${prep.feeLabel})` : ""}
        </p>
      )}

      {prep.validUntilLedger && (
        <p className="text-sm">
          Valid until ledger:{" "}
          <span className="font-mono">{prep.validUntilLedger}</span>
        </p>
      )}

      {prep.authDigestHex && (
        <p className="text-sm">
          Auth digest:{" "}
          <span className="font-mono text-xs break-all">
            {prep.authDigestHex.length > 32
              ? `${prep.authDigestHex.slice(0, 16)}…${prep.authDigestHex.slice(-16)}`
              : prep.authDigestHex}
          </span>
        </p>
      )}

      {prep.warnings && prep.warnings.length > 0 && (
        <ul className="text-sm text-amber-700 dark:text-amber-400 space-y-1">
          {prep.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="text-xs underline text-muted-foreground"
      >
        {showRaw ? "Hide" : "Show"} raw JSON
      </button>

      {showRaw && (
        <pre className="text-xs font-mono overflow-auto max-h-64 bg-background rounded-lg p-2 border">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
