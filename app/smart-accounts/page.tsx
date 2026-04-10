"use client";

import React, { useState, useEffect, useCallback } from "react";
import { connectWallet, WalletType, WalletConnectionResult } from "@/lib/wallets";
import {
  Loader2, ExternalLink, Activity, CheckCircle,
  AlertTriangle, Zap, Hash, ArrowRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type SetupState = "idle" | "connecting" | "connected" | "deploying" | "ready" | "error";
type TxState    = "idle" | "building"   | "signing"   | "submitting" | "success" | "error";

const COUNTER_ADDRESS = "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U";
const AUTH_PREFIX     = "Stellar Smart Account Auth:\n";

// ─── Wallet config ────────────────────────────────────────────────────────────

const WALLETS: { type: WalletType; label: string; sub: string; accent: string }[] = [
  { type: "phantom",   label: "Phantom",   sub: "Solana Wallet Standard",           accent: "indigo" },
  { type: "freighter", label: "Freighter", sub: "Stellar Native Browser Extension", accent: "yellow" },
  { type: "lobstr",    label: "Lobstr",    sub: "Stellar Lobstr Wallet Protocol",   accent: "blue"   },
];

const accentClasses: Record<string, string> = {
  indigo: "bg-indigo-500/10 text-indigo-500",
  yellow: "bg-yellow-500/10 text-yellow-500",
  blue:   "bg-blue-500/10  text-blue-500",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SmartAccountsPage() {
  const [setupState,      setSetupState]      = useState<SetupState>("idle");
  const [wallet,          setWallet]          = useState<WalletConnectionResult | null>(null);
  const [smartAccountAddr,setSmartAccountAddr]= useState<string | null>(null);
  const [setupError,      setSetupError]      = useState<string | null>(null);

  const [txState,     setTxState]     = useState<TxState>("idle");
  const [counterValue,setCounterValue]= useState<number | null>(null);
  const [txHash,      setTxHash]      = useState<string | null>(null);
  const [txError,     setTxError]     = useState<string | null>(null);

  useEffect(() => { fetchCounter(); }, []);

  const fetchCounter = async () => {
    try {
      const res = await fetch("/api/counter");
      if (res.ok) setCounterValue((await res.json()).value);
    } catch { /* silent */ }
  };

  // ── Step 1: Connect + auto-detect existing account ────────────────────────
  const handleConnect = async (type: WalletType) => {
    setSetupState("connecting");
    setSetupError(null);
    try {
      const info = await connectWallet(type);
      setWallet(info);
      const res  = await fetch(`/api/smart-account/factory?pubkey=${info.publicKeyHex}`);
      const data = await res.json();
      if (data.deployed && data.smartAccountAddress) {
        setSmartAccountAddr(data.smartAccountAddress);
        setSetupState("ready");
      } else {
        setSetupState("connected");
      }
    } catch (err: any) {
      setSetupError(err.message ?? "Failed to connect wallet.");
      setSetupState("error");
    }
  };

  // ── Step 2: Create smart account via factory ──────────────────────────────
  const handleDeploy = async () => {
    if (!wallet) return;
    setSetupState("deploying");
    setSetupError(null);
    try {
      const res  = await fetch("/api/smart-account/factory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyHex: wallet.publicKeyHex }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to deploy smart account.");
      setSmartAccountAddr(data.smartAccountAddress);
      setSetupState("ready");
    } catch (err: any) {
      setSetupError(err.message ?? "Deployment failed.");
      setSetupState("connected");
    }
  };

  // ── Step 3: Increment counter via smart account ───────────────────────────
  const handleIncrement = useCallback(async () => {
    if (!wallet || !smartAccountAddr) return;
    setTxState("building");
    setTxError(null);
    setTxHash(null);

    try {
      // 3a. Build tx & get auth payload hash
      const buildRes = await fetch("/api/transaction/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smartAccountAddress: smartAccountAddr }),
      });
      const build = await buildRes.json();
      if (!buildRes.ok) throw new Error(build.error ?? "Build failed.");
      const { txXdr, authEntryXdr, authPayloadHash } = build;

      // 3b. Sign auth payload with wallet
      setTxState("signing");
      const prefixedMessage = AUTH_PREFIX + authPayloadHash;
      const messageBytes    = new TextEncoder().encode(prefixedMessage);
      let authSignatureHex: string;

      if (wallet.walletType === "phantom") {
        const provider = (window as any).phantom?.solana;
        if (!provider) throw new Error("Phantom not found.");
        const result = await provider.signMessage(messageBytes);
        authSignatureHex = Buffer.from(result.signature).toString("hex");
      } else if (wallet.walletType === "freighter") {
        // Freighter v2 replaced signMessage with signBlob (base64 → base64 string)
        const { signBlob } = await import("@stellar/freighter-api");
        const signedBlob = await signBlob(Buffer.from(messageBytes).toString("base64"));
        authSignatureHex = Buffer.from(signedBlob as string, "base64").toString("hex");
      } else {
        const { signMessage } = await import("@lobstrco/signer-extension-api");
        const result = await (signMessage as any)(Buffer.from(messageBytes).toString("base64"));
        authSignatureHex = Buffer.from(result, "base64").toString("hex");
      }

      // 3c. Submit
      setTxState("submitting");
      const submitRes = await fetch("/api/transaction/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txXdr, authEntryXdr, authSignatureHex, prefixedMessage, publicKeyHex: wallet.publicKeyHex }),
      });
      const submitData = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitData.error ?? "Submit failed.");

      setTxHash(submitData.hash);
      setTxState("success");
      await fetchCounter();
    } catch (err: any) {
      setTxError(err.message ?? "Transaction failed.");
      setTxState("error");
    }
  }, [wallet, smartAccountAddr]);

  const reset = () => {
    setSetupState("idle"); setWallet(null); setSmartAccountAddr(null);
    setSetupError(null);   setTxState("idle"); setTxHash(null); setTxError(null);
  };

  const txLabel: Record<TxState, string> = {
    idle: "Increment Counter", building: "Building transaction…",
    signing: "Sign with wallet…", submitting: "Executing on Stellar…",
    success: "Increment Again", error: "Retry",
  };

  const isTxBusy = txState === "building" || txState === "signing" || txState === "submitting";

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="relative flex flex-col min-h-screen pt-24 sm:pt-32 pb-16 overflow-hidden bg-background">

      {/* Background glows — clipped, won't overflow on mobile */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden" aria-hidden>
        <div className="absolute top-[15%] right-[-10%] w-72 h-72 sm:w-[500px] sm:h-[500px] bg-primary/10 rounded-full blur-[80px] opacity-40 animate-pulse" style={{ animationDuration: "8s" }} />
        <div className="absolute bottom-[5%] left-[-10%] w-56 h-56 sm:w-[400px] sm:h-[400px] bg-primary/5 rounded-full blur-[80px] opacity-30 animate-pulse" style={{ animationDuration: "12s", animationDelay: "2s" }} />
      </div>

      <div className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div className="mb-8 sm:mb-12">
          <div className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-primary/10 text-primary mb-4 ring-1 ring-primary/20 shadow-sm">
            FACTORY LAUNCHPAD
          </div>
          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-mono font-bold tracking-tighter mb-4 uppercase">
            Smart Accounts
          </h1>
          <p className="text-base sm:text-lg lg:text-xl font-light text-muted-foreground max-w-2xl">
            Connect your wallet, mint a Soroban Smart Account via the factory, and interact
            with on-chain contracts — all from here.
          </p>
        </div>

        {/* ── Two-column card ───────────────────────────────────────────────── */}
        <div className="rounded-2xl border border-primary/20 bg-card/60 backdrop-blur-lg shadow-2xl overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">

            {/* ── LEFT: Wallet selection ─────────────────────────────────── */}
            <div className="p-6 sm:p-8 space-y-6">
              <div>
                <h2 className="text-lg sm:text-xl font-mono font-semibold mb-1">1. Connect Wallet</h2>
                <p className="text-sm text-muted-foreground">Select an Ed25519 signer to own your Smart Account.</p>
              </div>

              {/* Wallet buttons */}
              <div className="space-y-3">
                {WALLETS.map(({ type, label, sub, accent }) => (
                  <button
                    key={type}
                    id={`wallet-btn-${type}`}
                    onClick={() => handleConnect(type)}
                    disabled={setupState !== "idle" && setupState !== "error"}
                    className="flex items-center gap-3 w-full p-3 sm:p-4 rounded-xl border border-border bg-background hover:bg-muted/50 hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-left"
                  >
                    <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center font-mono font-bold text-sm shrink-0 ${accentClasses[accent]}`}>
                      {label[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-medium truncate">{label}</div>
                      <div className="text-xs text-muted-foreground truncate">{sub}</div>
                    </div>
                    {wallet?.walletType === type && (
                      <CheckCircle className="w-4 h-4 text-primary ml-auto shrink-0" />
                    )}
                  </button>
                ))}
              </div>

              {/* Connected key + deploy button */}
              {(setupState === "connected" || setupState === "deploying") && wallet && (
                <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="p-3 rounded-xl border bg-muted/30">
                    <p className="text-xs font-mono text-muted-foreground mb-1 uppercase tracking-wider">Connected Key</p>
                    <p className="font-mono text-xs break-all leading-relaxed">{wallet.publicKeyHex}</p>
                  </div>
                  <button
                    id="create-smart-account-btn"
                    onClick={handleDeploy}
                    disabled={setupState === "deploying"}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-mono text-sm font-medium hover:bg-primary/90 disabled:opacity-70 transition-colors"
                  >
                    {setupState === "deploying"
                      ? <><Loader2 className="w-4 h-4 animate-spin" />Minting via Factory…</>
                      : <><Zap className="w-4 h-4" />Create Smart Account</>
                    }
                  </button>
                </div>
              )}

              {/* Setup error */}
              {setupError && (
                <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold mb-0.5">Error</p>
                    <p className="text-sm opacity-90 break-words">{setupError}</p>
                  </div>
                </div>
              )}

              {/* Idle state */}
              {setupState === "idle" && (
                <div className="flex items-center gap-2 text-muted-foreground/50 py-4">
                  <Activity className="w-5 h-5" />
                  <span className="font-mono text-sm">Awaiting wallet…</span>
                </div>
              )}

              {/* Disconnect */}
              {(setupState === "ready" || setupState === "connecting") && (
                <button
                  id="disconnect-btn"
                  onClick={reset}
                  className="text-xs text-muted-foreground hover:text-foreground font-mono underline underline-offset-4 transition-colors"
                >
                  Disconnect
                </button>
              )}
            </div>

            {/* ── RIGHT: Account + Counter ───────────────────────────────── */}
            <div className="p-6 sm:p-8 space-y-6 bg-background/40">
              <div>
                <h2 className="text-lg sm:text-xl font-mono font-semibold mb-1">2. Your Smart Account</h2>
                <p className="text-sm text-muted-foreground">Minted on Stellar via the Factory contract.</p>
              </div>

              {/* Connecting spinner */}
              {setupState === "connecting" && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-primary">
                  <Loader2 className="w-8 h-8 animate-spin" />
                  <p className="font-mono text-sm animate-pulse text-center">Connecting &amp; checking on-chain…</p>
                </div>
              )}

              {/* Idle / error placeholder */}
              {(setupState === "idle" || setupState === "error") && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground/40">
                  <Activity className="w-8 h-8" />
                  <p className="font-mono text-sm text-center">Connect a wallet to begin.</p>
                </div>
              )}

              {/* Account ready */}
              {setupState === "ready" && smartAccountAddr && wallet && (
                <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500">

                  {/* C-address */}
                  <div className="p-4 rounded-xl bg-primary/10 border-2 border-primary/30">
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle className="w-4 h-4 text-primary shrink-0" />
                      <p className="text-xs font-mono text-primary uppercase tracking-wider font-semibold">Smart Account (C-address)</p>
                    </div>
                    <a
                      href={`https://stellar.expert/explorer/testnet/contract/${smartAccountAddr}`}
                      target="_blank" rel="noopener noreferrer"
                      className="font-mono text-xs break-all text-foreground hover:text-primary transition-colors inline-flex items-center gap-1"
                    >
                      <span className="break-all">{smartAccountAddr}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </div>

                  {/* Counter divider */}
                  <div className="flex items-center gap-3 text-muted-foreground/50">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs font-mono uppercase tracking-wider whitespace-nowrap">Counter Contract</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  {/* Counter value */}
                  <div className="p-4 sm:p-5 rounded-xl border bg-muted/30 text-center">
                    <p className="text-xs font-mono text-muted-foreground mb-2 uppercase tracking-wider">Current Value</p>
                    {counterValue !== null
                      ? <p className="font-mono text-5xl sm:text-6xl font-bold tabular-nums">{counterValue}</p>
                      : <p className="font-mono text-3xl text-muted-foreground/40">—</p>
                    }
                    <a
                      href={`https://stellar.expert/explorer/testnet/contract/${COUNTER_ADDRESS}`}
                      target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-3 text-xs text-muted-foreground hover:text-primary transition-colors font-mono"
                    >
                      {COUNTER_ADDRESS.slice(0, 8)}…{COUNTER_ADDRESS.slice(-6)}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>

                  {/* TX error */}
                  {txError && (
                    <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-start gap-3">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <p className="font-mono text-xs break-words opacity-90">{txError}</p>
                    </div>
                  )}

                  {/* TX success receipt */}
                  {txState === "success" && txHash && (
                    <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 space-y-2">
                      <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle className="w-4 h-4 shrink-0" />
                        <p className="text-xs font-mono font-semibold uppercase tracking-wider">Transaction Confirmed</p>
                      </div>
                      <div className="flex items-start gap-1.5">
                        <Hash className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                          target="_blank" rel="noopener noreferrer"
                          className="font-mono text-xs break-all text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"
                        >
                          <span className="break-all">{txHash.slice(0, 16)}…{txHash.slice(-10)}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        Signed by: {wallet.walletType} → verifier → smart account
                      </p>
                    </div>
                  )}

                  {/* Increment button */}
                  <button
                    id="increment-counter-btn"
                    onClick={handleIncrement}
                    disabled={isTxBusy}
                    className="relative w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-primary text-primary-foreground font-mono text-sm font-medium hover:bg-primary/90 disabled:opacity-70 disabled:cursor-wait transition-all overflow-hidden"
                  >
                    {isTxBusy && (
                      <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[shimmer_1.5s_ease-in-out_infinite]" />
                    )}
                    <span className="relative flex items-center gap-2">
                      {isTxBusy
                        ? <><Loader2 className="w-4 h-4 animate-spin" />{txLabel[txState]}</>
                        : <><ArrowRight className="w-4 h-4" />{txLabel[txState]}</>
                      }
                    </span>
                  </button>

                </div>
              )}
            </div>

          </div>
        </div>
      </div>

      {/* Shimmer keyframe — in a regular <style> tag, valid in App Router */}
      <style>{`@keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }`}</style>
    </div>
  );
}
