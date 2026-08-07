"use client";

import React, { useState } from "react";
import Link from "next/link";
import { CheckCircle, Copy, Loader2, Rocket } from "lucide-react";

type SerializedDraft = {
  id: string;
  threshold: number;
  canDeploy: boolean;
  validMemberCount: number;
  predictedAddress: string | null;
  smartAccountAddress: string | null;
  status: string;
};

type Props = {
  draft: SerializedDraft;
  onDraftChange: (draft: SerializedDraft) => void;
};

export function CreateDeployStep({ draft, onDraftChange }: Props) {
  const [busy, setBusy] = useState<"predict" | "deploy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const address = draft.smartAccountAddress ?? draft.predictedAddress;

  const predict = async () => {
    setError(null);
    setBusy("predict");
    try {
      const res = await fetch(`/api/multisig/drafts/${draft.id}/predict`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Predict failed");
      onDraftChange(data.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Predict failed");
    } finally {
      setBusy(null);
    }
  };

  const deploy = async () => {
    setError(null);
    setBusy("deploy");
    try {
      const res = await fetch(`/api/multisig/drafts/${draft.id}/deploy`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Deploy failed");
      onDraftChange(data.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Deploy failed");
    } finally {
      setBusy(null);
    }
  };

  const copyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Set how many approvals are required ({draft.threshold} of {draft.validMemberCount}),
        preview the shared C-address, then deploy once everyone has joined.
      </p>

      {!draft.canDeploy ? (
        <p className="text-xs font-mono text-amber-600">
          Need at least 2 valid members (WebAuthn or delegated G) before deploy. Ed25519-only
          drafts are not deployable yet.
        </p>
      ) : null}

      {address ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Shared wallet (C-address)
          </div>
          <div className="flex gap-2 items-start">
            <code className="text-xs font-mono break-all flex-1">{address}</code>
            <button
              type="button"
              onClick={copyAddress}
              className="shrink-0 p-2 rounded-lg border border-border hover:bg-muted/50"
              aria-label="Copy address"
            >
              {copied ? (
                <CheckCircle className="w-4 h-4 text-emerald-600" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive font-mono">{error}</p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!draft.canDeploy || busy !== null || draft.status === "deployed"}
          onClick={predict}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-mono hover:bg-muted/50 disabled:opacity-50"
        >
          {busy === "predict" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Preview address
        </button>
        <button
          type="button"
          disabled={!draft.canDeploy || busy !== null || draft.status === "deployed"}
          onClick={deploy}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-mono text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy === "deploy" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Rocket className="w-4 h-4" />
          )}
          {draft.status === "deployed" ? "Deployed" : "Deploy multisig"}
        </button>
      </div>

      {draft.status === "deployed" && address ? (
        <div className="space-y-3">
          <p className="text-xs text-emerald-600 font-mono flex items-center gap-1">
            <CheckCircle className="w-3.5 h-3.5" />
            On-chain wallet is live.
          </p>
          <Link
            href={`/multisig/wallet?account=${encodeURIComponent(address)}`}
            className="inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm font-mono text-primary hover:bg-primary/10"
          >
            Open team wallet · test transactions
          </Link>
        </div>
      ) : null}
    </div>
  );
}
