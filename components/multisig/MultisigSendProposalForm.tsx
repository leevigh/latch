"use client";

import React, { useCallback, useEffect, useState } from "react";
import { createSacTransferProposal } from "@/lib/multisig-wallet-client";
import { AlertTriangle, Loader2, Send } from "lucide-react";

type BalanceRow = {
  assetId: string;
  symbol: string;
  contractId: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
};

export type MultisigSendProposalFormProps = {
  smartAccountAddress: string;
  disabled?: boolean;
  balanceRefreshNonce?: number;
  onProposalCreated: (proposalId: string) => void;
  onError?: (message: string) => void;
};

export function MultisigSendProposalForm({
  smartAccountAddress,
  disabled = false,
  balanceRefreshNonce = 0,
  onProposalCreated,
  onError,
}: MultisigSendProposalFormProps) {
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState("native");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const fetchBalances = useCallback(async () => {
    if (!smartAccountAddress) return;
    setBalancesLoading(true);
    setBalancesError(null);
    try {
      const res = await fetch(
        `/api/smart-account/balances?smartAccountAddress=${encodeURIComponent(smartAccountAddress)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load balances");
      const rows: BalanceRow[] = data.balances ?? [];
      setBalances(rows);
      if (rows.length && !rows.find((b) => b.assetId === assetId)) {
        setAssetId(rows[0].assetId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load balances";
      setBalancesError(msg);
      setBalances([]);
    } finally {
      setBalancesLoading(false);
    }
  }, [smartAccountAddress, assetId]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances, balanceRefreshNonce]);

  const selectedBalance = balances.find((b) => b.assetId === assetId);

  const handlePropose = async () => {
    setFormError(null);
    setSuccess(false);
    setBusy(true);
    try {
      const { proposal } = await createSacTransferProposal({
        smartAccountAddress,
        assetId,
        recipient,
        amount,
      });
      setSuccess(true);
      setRecipient("");
      setAmount("");
      onProposalCreated(proposal.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Create send proposal failed";
      setFormError(msg);
      onError?.(msg);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !disabled &&
    !busy &&
    balances.length > 0 &&
    recipient.trim() &&
    amount.trim();

  return (
    <div className="space-y-3">
      {balancesLoading ? (
        <p className="text-xs font-mono text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading balances…
        </p>
      ) : balancesError ? (
        <p className="text-xs font-mono text-destructive">{balancesError}</p>
      ) : balances.length === 0 ? (
        <p className="text-xs font-mono text-muted-foreground">
          No token balances found. Fund this team wallet first.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {balances.map((b) => (
              <span
                key={b.assetId}
                className="text-[11px] font-mono rounded-full border border-border px-2 py-0.5 text-muted-foreground"
              >
                {b.symbol}: {b.balance}
              </span>
            ))}
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-mono text-muted-foreground uppercase">Asset</span>
            <select
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              disabled={disabled || busy}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
            >
              {balances.map((b) => (
                <option key={b.assetId} value={b.assetId}>
                  {b.symbol} — {b.balance}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-mono text-muted-foreground uppercase">
              Recipient (G or C)
            </span>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={disabled || busy}
              placeholder="G… or C…"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-mono text-muted-foreground uppercase">Amount</span>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={disabled || busy}
              placeholder="0.1"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
            />
            {selectedBalance ? (
              <span className="text-[11px] font-mono text-muted-foreground">
                Available: {selectedBalance.balance} {selectedBalance.symbol}
              </span>
            ) : null}
          </label>
        </>
      )}

      {formError ? (
        <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="font-mono text-xs break-words">{formError}</p>
        </div>
      ) : null}

      {success ? (
        <p className="text-xs font-mono text-emerald-600">
          Send proposal created — collect approvals on the right.
        </p>
      ) : null}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handlePropose}
        className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary h-11 font-mono text-sm text-primary-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Propose send
      </button>
    </div>
  );
}
