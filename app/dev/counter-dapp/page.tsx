"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectWalletBar } from "@/components/sign-demo/ConnectWalletBar";
import {
  LatchWalletProvider,
  useLatchWallet,
} from "@/lib/sign-demo/useLatchWallet";
import {
  buildCounterIncrementForExtension,
  getCounter,
  goApiBase,
  isSignDemoApiError,
} from "@/lib/counter-dapp/api";
import { submitTransaction } from "@/lib/sign-demo/api";
import {
  LatchWalletError,
  signWithLatch,
} from "@/lib/sign-demo/latchWallet";

const COUNTER_DAPP_STORAGE_KEY = "latch.counterDapp.walletSession";

type FlowPhase =
  | "idle"
  | "building"
  | "signing"
  | "submitting"
  | "done"
  | "error";

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function CounterDappInner() {
  const wallet = useLatchWallet();
  const { status, publicKey, network, refreshAccount } = wallet;

  const [counterValue, setCounterValue] = useState<number | null>(null);
  const [counterLoading, setCounterLoading] = useState(false);
  const [counterError, setCounterError] = useState<string | null>(null);

  const [phase, setPhase] = useState<FlowPhase>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [lastTxXdr, setLastTxXdr] = useState<string | null>(null);
  const [signDebug, setSignDebug] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);

  const builtForAccountRef = useRef<string | null>(null);

  const loadCounter = useCallback(async () => {
    setCounterLoading(true);
    setCounterError(null);
    try {
      const { value } = await getCounter();
      setCounterValue(typeof value === "number" ? value : Number(value) || 0);
    } catch (e) {
      const msg = isSignDemoApiError(e)
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
      setCounterError(msg);
    } finally {
      setCounterLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCounter();
  }, [loadCounter]);

  // Clear stale build when the active Latch account changes.
  useEffect(() => {
    if (!publicKey) {
      builtForAccountRef.current = null;
      setLastTxXdr(null);
      return;
    }
    if (
      builtForAccountRef.current &&
      builtForAccountRef.current !== publicKey
    ) {
      builtForAccountRef.current = null;
      setLastTxXdr(null);
      setTxHash(null);
      setSignDebug(null);
      setStatusMessage("Account changed — rebuild before incrementing.");
      setPhase("idle");
    }
  }, [publicKey]);

  async function handleIncrement() {
    setFlowError(null);
    setTxHash(null);
    setSignDebug(null);
    setLastTxXdr(null);

    if (status !== "connected") {
      setFlowError("Connect the Latch extension wallet first.");
      setPhase("error");
      return;
    }

    try {
      setPhase("building");
      setStatusMessage("Syncing active account…");
      const active = await refreshAccount();
      const account = active?.publicKey ?? publicKey;
      const net = active?.network ?? network;
      if (!account || !net) {
        throw new Error("Could not read the active Latch account.");
      }

      // Extension signTransaction always re-runs prepare-sign, which needs a
      // raw unsigned invoke — not Go /build's auth-ready envelope.
      setStatusMessage(`Building unsigned increment for wallet prepare-sign…`);
      const { unsignedTxXdr, source } = await buildCounterIncrementForExtension({
        smartAccountAddress: account,
        network: net,
      });
      builtForAccountRef.current = account;
      setLastTxXdr(unsignedTxXdr);
      setStatusMessage(
        source === "local"
          ? "Approve in Latch (wallet prepares + submits)…"
          : `Built via Go ${goApiBase()} then stripped for prepare-sign — approve in Latch…`
      );

      setPhase("signing");
      // Production Go submit-* does not yet return signedTxXdr for submit:false
      // (assemble-only). Use submit:true so the extension broadcasts via Go and
      // returns txHash. Rebuild/reload the extension for clearer errors if that
      // path regresses to an empty {}.
      const signed = await signWithLatch({
        xdr: unsignedTxXdr,
        network: net,
        accountToSign: account,
        submit: true,
      });
      setSignDebug(JSON.stringify(signed, null, 2));

      if (signed.txHash) {
        setTxHash(signed.txHash);
        setPhase("done");
        setStatusMessage("Increment submitted by Latch wallet.");
        await loadCounter();
        return;
      }

      const signedTxXdr = signed.signedTxXdr ?? signed.signedXdr;
      if (!signedTxXdr) {
        throw new Error(
          "Extension returned no txHash / signedTxXdr. Production Go may lack submit:false signedTxXdr support — see sign response below."
        );
      }

      setPhase("submitting");
      setStatusMessage("Submitting signed transaction via Soroban RPC…");
      const { txHash: hash } = await submitTransaction({
        network: net,
        signedTxXdr,
      });
      setTxHash(hash);
      setPhase("done");
      setStatusMessage("Increment submitted.");
      await loadCounter();
    } catch (e) {
      setPhase("error");
      if (isSignDemoApiError(e)) {
        setFlowError(
          `[${e.status}] ${e.code}: ${e.message}` +
            (e.suggestedAction ? ` (suggested: ${e.suggestedAction})` : "")
        );
      } else if (e instanceof LatchWalletError) {
        setFlowError(
          e.code ? `[${e.code}] ${e.message}` : e.message
        );
      } else {
        setFlowError(e instanceof Error ? e.message : String(e));
      }
      setStatusMessage(null);
    }
  }

  const busy =
    phase === "building" || phase === "signing" || phase === "submitting";

  return (
    <main className="min-h-screen bg-background pt-28 pb-16">
      <div className="container max-w-2xl space-y-6">
        <header className="space-y-2">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Extension-only · Go backend
          </p>
          <h1 className="text-2xl font-mono font-semibold tracking-tight">
            Counter dapp
          </h1>
          <p className="text-sm text-muted-foreground">
            Connect Latch Wallet, read the demo counter from production Go, hand
            the extension a raw unsigned increment, and let the wallet
            prepare-sign + submit (production Go does not yet return{" "}
            <span className="font-mono">signedTxXdr</span> for{" "}
            <span className="font-mono">submit:false</span>).
          </p>
          <p className="text-xs font-mono text-muted-foreground break-all">
            API: {goApiBase()}
          </p>
        </header>

        <ConnectWalletBar />

        <section className="space-y-3 rounded-2xl border border-border bg-background/80 p-5 shadow-sm">
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground">
            Active account
          </h2>
          {status === "connected" && publicKey ? (
            <div className="space-y-1">
              <p className="text-sm font-mono break-all">{publicKey}</p>
              <p className="text-xs text-muted-foreground">
                {truncateAddress(publicKey)}
                {network ? ` · ${network}` : ""}
                <span className="ml-2 text-muted-foreground/80">
                  (updates live on wallet account switch)
                </span>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not connected — use Connect Wallet above.
            </p>
          )}
        </section>

        <section className="space-y-4 rounded-2xl border border-border bg-background/80 p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground">
              Counter
            </h2>
            <button
              type="button"
              onClick={() => void loadCounter()}
              disabled={counterLoading}
              className="text-sm underline text-muted-foreground disabled:opacity-50"
            >
              {counterLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <p className="text-4xl font-mono font-semibold tabular-nums">
            {counterValue === null ? "—" : counterValue}
          </p>
          {counterError ? (
            <p className="text-sm text-destructive wrap-break-word">{counterError}</p>
          ) : null}

          <button
            type="button"
            onClick={() => void handleIncrement()}
            disabled={busy || status !== "connected"}
            className="rounded-xl bg-primary px-4 py-2.5 text-sm font-mono font-medium text-primary-foreground disabled:opacity-50 transition-colors hover:bg-primary/90"
          >
            {phase === "building"
              ? "Building…"
              : phase === "signing"
                ? "Signing…"
                : phase === "submitting"
                  ? "Submitting…"
                  : "Increment"}
          </button>
        </section>

        <section className="space-y-3 rounded-2xl border border-border bg-background/80 p-5 shadow-sm">
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground">
            Status
          </h2>
          {statusMessage ? (
            <p className="text-sm text-muted-foreground">{statusMessage}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Idle</p>
          )}
          {txHash ? (
            <p className="text-sm font-mono break-all">
              <span className="text-muted-foreground">txHash: </span>
              {txHash}
            </p>
          ) : null}
          {flowError ? (
            <p className="text-sm text-destructive whitespace-pre-wrap wrap-break-word">
              {flowError}
            </p>
          ) : null}
          {lastTxXdr ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground font-mono">
                Last unsigned txXdr (extension prepare-sign input)
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted/40 p-2 break-all whitespace-pre-wrap">
                {lastTxXdr}
              </pre>
            </details>
          ) : null}
          {signDebug ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground font-mono">
                Sign response
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted/40 p-2 whitespace-pre-wrap">
                {signDebug}
              </pre>
            </details>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export default function CounterDappPage() {
  return (
    <LatchWalletProvider storageKey={COUNTER_DAPP_STORAGE_KEY}>
      <CounterDappInner />
    </LatchWalletProvider>
  );
}
