"use client";

import React, { Suspense } from "react";
import Link from "next/link";
import { MultisigWalletPanel } from "@/components/multisig/MultisigWalletPanel";
import { ArrowLeft, Users } from "lucide-react";

function WalletContent() {
  return <MultisigWalletPanel />;
}

export default function MultisigWalletPage() {
  return (
    <main className="min-h-screen pt-28 pb-16 container">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="space-y-3">
          <Link
            href="/multisig"
            className="inline-flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to create flow
          </Link>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-mono uppercase tracking-wider text-primary">
            <Users className="w-3.5 h-3.5" />
            Team wallet
          </div>
          <h1 className="text-3xl font-mono font-semibold tracking-tight">Use multisig</h1>
          <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
            Propose a token send or demo counter increment, collect passkey or Freighter approvals
            until the threshold is met, then execute the shared transaction.
          </p>
        </div>

        <Suspense
          fallback={
            <div className="h-48 rounded-2xl bg-muted/30 animate-pulse" />
          }
        >
          <WalletContent />
        </Suspense>
      </div>
    </main>
  );
}
