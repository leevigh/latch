"use client";

import React, { useState } from "react";
import { Users, Loader2 } from "lucide-react";
import { CollectSignersStep } from "@/components/multisig/CollectSignersStep";
import { CreateDeployStep } from "@/components/multisig/CreateDeployStep";
import { useServerMultisigDraft } from "@/components/multisig/useServerMultisigDraft";

export default function MultisigPage() {
  const {
    draft,
    inviteUrl,
    hydrated,
    loading,
    createDraft,
    setThreshold,
    applyDraft,
    loadDraft,
  } = useServerMultisigDraft();
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);

  if (!hydrated) {
    return (
      <main className="min-h-screen pt-28 pb-16 container">
        <div className="max-w-3xl mx-auto animate-pulse h-64 rounded-2xl bg-muted/30" />
      </main>
    );
  }

  const startDraft = async () => {
    setError(null);
    try {
      await createDraft();
      setStep(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create draft");
    }
  };

  const handleThresholdChange = async (n: number) => {
    try {
      await setThreshold(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update threshold");
    }
  };

  return (
    <main className="min-h-screen pt-28 pb-16 container">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-mono uppercase tracking-wider text-primary">
            <Users className="w-3.5 h-3.5" />
            Shared wallet
          </div>
          <h1 className="text-3xl sm:text-4xl font-mono font-semibold tracking-tight">
            Create multisig
          </h1>
          <p className="text-muted-foreground text-sm sm:text-base max-w-2xl leading-relaxed">
            Collect signers (local or via invite link), set M-of-N, then deploy the shared
            C-address.
          </p>
        </div>

        {!draft ? (
          <div className="rounded-2xl border border-border p-8 text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              Start a server-backed team wallet draft. Remote members join with a link — no shared
              browser required.
            </p>
            {error ? <p className="text-sm text-destructive font-mono">{error}</p> : null}
            <button
              type="button"
              disabled={loading}
              onClick={startDraft}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 font-mono text-sm text-primary-foreground disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Start new multisig
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-primary/20 bg-card/60 backdrop-blur-lg shadow-2xl overflow-hidden">
            <div className="flex border-b border-border">
              <button
                type="button"
                onClick={() => setStep(1)}
                className={`flex-1 py-3 text-xs font-mono uppercase tracking-wider ${
                  step === 1 ? "bg-primary/10 text-primary" : "text-muted-foreground"
                }`}
              >
                1 · Signers
              </button>
              <button
                type="button"
                onClick={() => setStep(2)}
                className={`flex-1 py-3 text-xs font-mono uppercase tracking-wider ${
                  step === 2 ? "bg-primary/10 text-primary" : "text-muted-foreground"
                }`}
              >
                2 · Threshold & deploy
              </button>
            </div>

            <div className="p-6 sm:p-8">
              {error ? (
                <p className="text-sm text-destructive font-mono mb-4">{error}</p>
              ) : null}
              {step === 1 ? (
                <CollectSignersStep
                  draft={draft}
                  inviteUrl={inviteUrl}
                  onDraftUpdated={(d) => {
                    applyDraft(d);
                    loadDraft(d.id);
                  }}
                  threshold={draft.threshold}
                  onThresholdChange={handleThresholdChange}
                />
              ) : (
                <CreateDeployStep draft={draft} onDraftChange={applyDraft} />
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
