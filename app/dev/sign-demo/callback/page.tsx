"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import {
  parseCallbackResult,
  stellarExpertTxUrl,
} from "@/lib/sign-demo/parseCallback";
import { submitTransaction } from "@/lib/sign-demo/api";
import type { Network } from "@/lib/network";

function CallbackContent() {
  const params = useSearchParams();
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const result = useMemo(() => {
    const search = params.toString();
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    return parseCallbackResult(search, hash);
  }, [params]);

  async function submitSignedTx() {
    if (!result.signedTxXdr) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const network: Network = result.network === "mainnet" ? "mainnet" : "testnet";
      const { txHash } = await submitTransaction({
        network,
        signedTxXdr: result.signedTxXdr,
      });
      setSubmittedHash(txHash);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const rawQuery =
    typeof window !== "undefined"
      ? window.location.search + window.location.hash
      : params.toString();

  async function copyRaw() {
    await navigator.clipboard.writeText(rawQuery);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="mx-auto max-w-lg pt-24 sm:pt-32 pb-16 px-4 sm:px-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Sign callback</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Result from the wallet redirect after signing or rejection.
        </p>
      </div>

      {result.status === "signed" && (
        <div className="rounded border border-green-500/50 bg-green-500/10 p-4 space-y-2">
          <p className="font-medium text-green-800 dark:text-green-300">
            Transaction signed successfully
          </p>
          {result.txHash && (
            <p className="text-sm font-mono break-all">{result.txHash}</p>
          )}
          {result.txHash && (
            <a
              href={stellarExpertTxUrl(result.network, result.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              View on Stellar Expert
            </a>
          )}

          {!result.txHash && result.signedTxXdr && !submittedHash && (
            <div className="space-y-2 pt-1">
              <p className="text-sm text-green-800/90 dark:text-green-300/90">
                The wallet returned a signed transaction. Submit it to the network via RPC.
              </p>
              <button
                type="button"
                onClick={() => void submitSignedTx()}
                disabled={submitting}
                className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {submitting ? "Submitting…" : "Submit via RPC"}
              </button>
              {submitError && (
                <p className="text-sm text-destructive">{submitError}</p>
              )}
            </div>
          )}

          {submittedHash && (
            <div className="space-y-1 pt-1">
              <p className="text-sm font-mono break-all">{submittedHash}</p>
              <a
                href={stellarExpertTxUrl(result.network, submittedHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline"
              >
                View on Stellar Expert
              </a>
            </div>
          )}
        </div>
      )}

      {result.status === "rejected" && (
        <div className="rounded border border-amber-500/50 bg-amber-500/10 p-4">
          <p className="font-medium">User rejected in wallet</p>
        </div>
      )}

      {result.status === "error" && (
        <div className="rounded border border-destructive/50 bg-destructive/5 p-4 space-y-1">
          <p className="font-medium text-destructive">Sign error</p>
          {result.code && (
            <p className="text-sm font-mono text-destructive/80">code: {result.code}</p>
          )}
          {result.message && (
            <p className="text-sm text-destructive/90">{result.message}</p>
          )}
        </div>
      )}

      <dl className="space-y-2 text-sm">
        {result.requestId && (
          <div className="flex gap-2">
            <dt className="font-semibold">requestId:</dt>
            <dd className="font-mono break-all">{result.requestId}</dd>
          </div>
        )}
        {result.network && (
          <div className="flex gap-2">
            <dt className="font-semibold">network:</dt>
            <dd className="font-mono">{result.network}</dd>
          </div>
        )}
        {result.signedAuthEntry && (
          <div className="flex gap-2">
            <dt className="font-semibold">signedAuthEntry:</dt>
            <dd className="font-mono break-all text-xs">{result.signedAuthEntry}</dd>
          </div>
        )}
        {result.signedTxXdr && (
          <div className="flex gap-2">
            <dt className="font-semibold">signedTxXdr:</dt>
            <dd className="font-mono break-all text-xs">{result.signedTxXdr}</dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        onClick={() => void copyRaw()}
        className="text-sm underline text-muted-foreground"
      >
        {copied ? "Copied" : "Copy raw query string"}
      </button>

      <a href="/dev/sign-demo" className="block text-sm underline">
        Back to demo
      </a>
    </main>
  );
}

export default function SignDemoCallbackPage() {
  return (
    <Suspense fallback={<main className="p-8">Loading…</main>}>
      <CallbackContent />
    </Suspense>
  );
}
