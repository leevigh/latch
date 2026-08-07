"use client";

import type { PoolSnapshotResponse } from "@/lib/on-ramp/types";

export function PoolBalancePanel({
  snapshot,
  loading,
  error,
  onRefresh,
}: {
  snapshot: PoolSnapshotResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Developer verification — pool deposits on Stellar testnet
        </p>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {snapshot ? (
        <div className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Pool G-address</span>
            <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-xs">
              {snapshot.poolAddress}
            </code>
          </div>
          <div>
            <span className="text-muted-foreground">XLM balance</span>
            <p className="font-medium">{snapshot.xlmBalance} XLM</p>
          </div>
          <div>
            <span className="text-muted-foreground">Recent transactions</span>
            {snapshot.recentTransactions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No transactions yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {snapshot.recentTransactions.map((tx) => (
                  <li
                    key={tx.transactionId}
                    className="rounded border px-2 py-2 text-xs"
                  >
                    <div>Memo: {tx.memo ?? "(none)"}</div>
                    <div>Type: {tx.memoType}</div>
                    <div>At: {tx.createdAt}</div>
                    <div className="break-all">Tx: {tx.transactionId}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
