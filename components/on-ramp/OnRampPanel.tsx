"use client";

import type { OnRampIntentResponse } from "@/lib/on-ramp/types";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <code className="break-all rounded bg-muted px-2 py-1 text-xs">{value}</code>
    </div>
  );
}

export function OnRampPanel({
  destinationCAddress,
  onDestinationChange,
  fiatAmount,
  onFiatAmountChange,
  memoId,
  intent,
  phase,
  error,
  onAddFunds,
  loading,
}: {
  destinationCAddress: string;
  onDestinationChange: (value: string) => void;
  fiatAmount: string;
  onFiatAmountChange: (value: string) => void;
  memoId: string | null;
  intent: OnRampIntentResponse | null;
  phase: string;
  error: string | null;
  onAddFunds: () => void;
  loading: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="destination-c-address">
          Destination C-address
        </label>
        <input
          id="destination-c-address"
          className="w-full rounded border bg-background px-3 py-2 text-sm"
          placeholder="C..."
          value={destinationCAddress}
          onChange={(e) => onDestinationChange(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Funds will be routed to this smart account after the pool deposit is
          processed. Users do not need to know the pool G-address.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="fiat-amount">
          Amount (USD)
        </label>
        <input
          id="fiat-amount"
          className="w-full rounded border bg-background px-3 py-2 text-sm"
          inputMode="decimal"
          value={fiatAmount}
          onChange={(e) => onFiatAmountChange(e.target.value)}
        />
      </div>

      {memoId ? <Row label="Memo reference ID" value={memoId} /> : null}

      {intent ? (
        <div className="space-y-2 rounded border p-3">
          <Row label="Intent ID" value={intent.id} />
          <Row label="Status" value={intent.status} />
          {intent.moonpayTransactionId ? (
            <Row label="MoonPay transaction" value={intent.moonpayTransactionId} />
          ) : null}
          {intent.moonpayTransactionStatus ? (
            <Row
              label="MoonPay tx status"
              value={intent.moonpayTransactionStatus}
            />
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">Flow phase: {phase}</p>

      <button
        type="button"
        className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={loading || !destinationCAddress.trim()}
        onClick={onAddFunds}
      >
        {loading ? "Starting on-ramp…" : "Add funds"}
      </button>
    </div>
  );
}
