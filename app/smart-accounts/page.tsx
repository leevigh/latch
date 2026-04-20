"use client";

import React, { useState, useEffect, useCallback } from "react";
import { connectWallet, WalletType, WalletConnectionResult } from "@/lib/wallets";
import {
  registerPasskey, signWithPasskey, computeAuthDigest,
  encodeWebAuthnSigData, type PasskeyRegistration,
} from "@/lib/webauthn";
import { signAuthEntry } from "@stellar/freighter-api";
import { xdr, Networks } from "@stellar/stellar-sdk";
import {
  Loader2, ExternalLink, Activity, CheckCircle,
  AlertTriangle, Zap, Hash, ArrowRight, Fingerprint,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type SetupState = "idle" | "connecting" | "connected" | "deploying" | "ready" | "error";
type PasskeyState = "idle" | "registering" | "deploying" | "ready" | "error";
type TxState = "idle" | "building" | "signing" | "submitting" | "success" | "error";
type ActiveMode = "wallet" | "passkey" | null;

const COUNTER_ADDRESS =
  process.env.NEXT_PUBLIC_COUNTER_ADDRESS ||
  "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U";
const AUTH_PREFIX = "Stellar Smart Account Auth:\n";
const NETWORK_PASSPHRASE = Networks.TESTNET;

// ─── Wallet config ────────────────────────────────────────────────────────────

const SOLANA_WALLETS: { type: WalletType; label: string; sub: string }[] = [
  { type: "phantom", label: "Phantom", sub: "External Ed25519 signer" },
];

const STELLAR_WALLETS: { type: WalletType; label: string; sub: string }[] = [
  { type: "freighter", label: "Freighter", sub: "Delegated signer" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SmartAccountsPage() {
  // Wallet (Phantom / Freighter) state
  const [setupState,       setSetupState]       = useState<SetupState>("idle");
  const [wallet,           setWallet]           = useState<WalletConnectionResult | null>(null);
  const [setupError,       setSetupError]       = useState<string | null>(null);

  // Passkey (WebAuthn) state
  const [passkeyState,     setPasskeyState]     = useState<PasskeyState>("idle");
  const [passkey,          setPasskey]          = useState<PasskeyRegistration | null>(null);
  const [passkeyError,     setPasskeyError]     = useState<string | null>(null);

  // Shared
  const [activeMode,       setActiveMode]       = useState<ActiveMode>(null);
  const [smartAccountAddr, setSmartAccountAddr] = useState<string | null>(null);

  // Transaction state
  const [txState,      setTxState]      = useState<TxState>("idle");
  const [counterValue, setCounterValue] = useState<number | null>(null);
  const [txHash,       setTxHash]       = useState<string | null>(null);
  const [txError,      setTxError]      = useState<string | null>(null);

  useEffect(() => { fetchCounter(); }, []);

  const fetchCounter = async () => {
    try {
      const res = await fetch("/api/counter");
      if (res.ok) setCounterValue((await res.json()).value);
    } catch { /* silent */ }
  };

  // ── Wallet: Connect + auto-detect existing account ────────────────────────
  const handleConnect = async (type: WalletType) => {
    setSetupState("connecting");
    setSetupError(null);
    setActiveMode("wallet");
    // Clear passkey state when switching to wallet
    setPasskeyState("idle");
    setPasskey(null);
    setPasskeyError(null);
    setSmartAccountAddr(null);
    try {
      const info = await connectWallet(type);
      setWallet(info);

      const lookupUrl = type === "freighter"
        ? `/api/smart-account/freighter?gAddress=${info.gAddress}`
        : `/api/smart-account/factory?pubkey=${info.publicKeyHex}`;

      const res  = await fetch(lookupUrl);
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

  // ── Wallet: Create smart account via factory ──────────────────────────────
  const handleDeploy = async () => {
    if (!wallet) return;
    setSetupState("deploying");
    setSetupError(null);
    try {
      const isFreighter = wallet.walletType === "freighter";
      const endpoint = isFreighter ? "/api/smart-account/freighter" : "/api/smart-account/factory";
      const body = isFreighter
        ? { gAddress: wallet.gAddress }
        : { publicKeyHex: wallet.publicKeyHex };

      const res  = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  // ── Passkey: Register + deploy ────────────────────────────────────────────
  const handlePasskeyRegister = async () => {
    setPasskeyState("registering");
    setPasskeyError(null);
    setActiveMode("passkey");
    // Clear wallet state when switching to passkey
    setSetupState("idle");
    setWallet(null);
    setSetupError(null);
    setSmartAccountAddr(null);
    try {
      const rpId = window.location.hostname;
      const reg  = await registerPasskey(rpId, "Latch", "user");
      setPasskey(reg);

      setPasskeyState("deploying");
      const res = await fetch("/api/smart-account/webauthn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyDataHex:   reg.keyData.toString("hex"),
          credentialId: reg.credentialId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to deploy smart account");
      setSmartAccountAddr(data.smartAccountAddress);
      setPasskeyState("ready");
    } catch (err: any) {
      setPasskeyError(err.message ?? "Registration failed.");
      setPasskeyState("error");
    }
  };

  // ── Increment counter ─────────────────────────────────────────────────────
  const handleIncrement = useCallback(async () => {
    if (!smartAccountAddr) return;
    setTxState("building");
    setTxError(null);
    setTxHash(null);

    try {
      if (activeMode === "passkey" && passkey) {
        // ── Passkey (WebAuthn P-256) path ───────────────────────────────────
        const buildRes = await fetch("/api/transaction/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ smartAccountAddress: smartAccountAddr }),
        });
        const build = await buildRes.json();
        if (!buildRes.ok) throw new Error(build.error ?? "Build failed.");
        const { txXdr, authEntryXdr, validUntilLedger } = build;

        const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
        authEntry.credentials().address().signatureExpirationLedger(validUntilLedger);
        const authDigest = computeAuthDigest(authEntry, NETWORK_PASSPHRASE, [0]);

        setTxState("signing");
        const sig = await signWithPasskey(
          passkey.credentialId,
          authDigest,
          window.location.hostname
        );
        const sigDataXdr = encodeWebAuthnSigData(sig);

        setTxState("submitting");
        const submitRes = await fetch("/api/transaction/submit-webauthn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txXdr,
            authEntryXdr,
            sigDataXdr:   sigDataXdr.toString("hex"),
            keyDataHex:   passkey.keyData.toString("hex"),
            contextRuleId: 0,
          }),
        });
        const submitData = await submitRes.json();
        if (!submitRes.ok) throw new Error(submitData.error ?? "Submit failed.");
        setTxHash(submitData.hash);
        setTxState("success");
        await fetchCounter();

      } else if (wallet?.walletType === "freighter") {
        // ── Freighter (Delegated signer) path ──────────────────────────────
        const buildRes = await fetch("/api/transaction/build-delegated", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ smartAccountAddress: smartAccountAddr, gAddress: wallet.gAddress }),
        });
        const build = await buildRes.json();
        if (!buildRes.ok) throw new Error(build.error ?? "Build failed.");
        const { txXdr, smartAccountAuthEntryXdr, gAddressPreimageXdr, gAddressEntryTemplateXdr } = build;

        setTxState("signing");
        // Freighter expects a HashIdPreimage, signs hash(preimage_bytes), returns raw 64-byte sig as base64
        const signResult = await signAuthEntry(gAddressPreimageXdr, {
          networkPassphrase: NETWORK_PASSPHRASE,
        });
        if (signResult.error) throw new Error(signResult.error.message || "Freighter signing failed");
        if (!signResult.signedAuthEntry) throw new Error("Freighter returned no signed auth entry");

        setTxState("submitting");
        const submitRes = await fetch("/api/transaction/submit-delegated", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txXdr,
            smartAccountAuthEntryXdr,
            gAddressEntryTemplateXdr,
            signedAuthEntryBase64: signResult.signedAuthEntry, // raw 64-byte Ed25519 sig, base64
            signerAddress: signResult.signerAddress,
          }),
        });
        const submitData = await submitRes.json();
        if (!submitRes.ok) throw new Error(submitData.error ?? "Submit failed.");
        setTxHash(submitData.hash);
        setTxState("success");
        await fetchCounter();

      } else if (wallet) {
        // ── Phantom (External Ed25519) path ─────────────────────────────────
        const buildRes = await fetch("/api/transaction/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ smartAccountAddress: smartAccountAddr }),
        });
        const build = await buildRes.json();
        if (!buildRes.ok) throw new Error(build.error ?? "Build failed.");
        const { txXdr, authEntryXdr, authDigestHex } = build;

        const signPrefixed = async (hashHex: string) => {
          const prefixedMessage = AUTH_PREFIX + hashHex.toLowerCase();
          const messageBytes = new TextEncoder().encode(prefixedMessage);
          const provider = (window as any).phantom?.solana;
          if (!provider) throw new Error("Phantom not found.");
          const result = await provider.signMessage(messageBytes, "utf8");
          return { prefixedMessage, authSignatureHex: Buffer.from(result.signature).toString("hex") };
        };

        const submitOnce = async (authSignatureHex: string, prefixedMessage: string) => {
          const submitRes = await fetch("/api/transaction/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txXdr, authEntryXdr, authSignatureHex, prefixedMessage, publicKeyHex: wallet.publicKeyHex }),
          });
          return { submitRes, submitData: await submitRes.json() };
        };

        setTxState("signing");
        const first = await signPrefixed(authDigestHex);
        setTxState("submitting");
        let { submitRes, submitData } = await submitOnce(first.authSignatureHex, first.prefixedMessage);

        // Retry with verifier hash if digest mismatch (stale page)
        if (!submitRes.ok && submitData?.verifierHashHex) {
          setTxState("signing");
          const second = await signPrefixed(submitData.verifierHashHex);
          setTxState("submitting");
          ({ submitRes, submitData } = await submitOnce(second.authSignatureHex, second.prefixedMessage));
        }

        if (!submitRes.ok) throw new Error(submitData?.error ?? "Submit failed.");
        setTxHash(submitData.hash);
        setTxState("success");
        await fetchCounter();
      }
    } catch (err: any) {
      setTxError(err?.message ?? "Transaction failed.");
      setTxState("error");
    }
  }, [wallet, passkey, smartAccountAddr, activeMode]);

  const reset = () => {
    setSetupState("idle");    setWallet(null);         setSmartAccountAddr(null);
    setSetupError(null);      setPasskeyState("idle"); setPasskey(null);
    setPasskeyError(null);    setActiveMode(null);
    setTxState("idle");       setTxHash(null);         setTxError(null);
  };

  const txLabel: Record<TxState, string> = {
    idle: "Increment Counter", building: "Building transaction…",
    signing: "Sign with authenticator…", submitting: "Executing on Stellar…",
    success: "Increment Again", error: "Retry",
  };

  const isReady = (setupState === "ready" && activeMode === "wallet") ||
                  (passkeyState === "ready" && activeMode === "passkey");
  const isTxBusy = txState === "building" || txState === "signing" || txState === "submitting";
  const anySetupBusy =
    (setupState !== "idle" && setupState !== "error") ||
    (passkeyState === "registering" || passkeyState === "deploying");

  const signerLabel =
    activeMode === "passkey" ? "passkey (WebAuthn P-256)"
    : activeMode === "wallet" ? wallet?.walletType ?? "wallet"
    : "wallet";

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="relative flex flex-col min-h-screen pt-24 sm:pt-32 pb-16 overflow-hidden bg-background">

      {/* Background glows */}
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
            Connect your wallet or register a passkey, mint a Soroban Smart Account via the factory,
            and interact with on-chain contracts — all from here.
          </p>
        </div>

        {/* ── Two-column card ───────────────────────────────────────────────── */}
        <div className="rounded-2xl border border-primary/20 bg-card/60 backdrop-blur-lg shadow-2xl overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">

            {/* ── LEFT: Signer selection ─────────────────────────────────── */}
            <div className="p-6 sm:p-8 space-y-6">
              <div>
                <h2 className="text-lg sm:text-xl font-mono font-semibold mb-1">1. Choose Signer</h2>
                <p className="text-sm text-muted-foreground">Pick a wallet or use a passkey stored on your device.</p>
              </div>

              {/* Solana wallets */}
              <div className="space-y-2">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Solana</p>
                {SOLANA_WALLETS.map(({ type, label, sub }) => (
                  <button
                    key={type}
                    onClick={() => handleConnect(type)}
                    disabled={anySetupBusy}
                    className="flex items-center gap-3 w-full p-3 sm:p-4 rounded-xl border border-border bg-background hover:bg-muted/50 hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-left"
                  >
                    <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center font-mono font-bold text-sm shrink-0 bg-indigo-500/10 text-indigo-500">
                      {label[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-medium truncate">{label}</div>
                      <div className="text-xs text-muted-foreground truncate">{sub}</div>
                    </div>
                    {wallet?.walletType === type && activeMode === "wallet" && (
                      <CheckCircle className="w-4 h-4 text-primary ml-auto shrink-0" />
                    )}
                  </button>
                ))}
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 text-muted-foreground/40">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs font-mono uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {/* Stellar wallets */}
              <div className="space-y-2">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Stellar</p>
                {STELLAR_WALLETS.map(({ type, label, sub }) => (
                  <button
                    key={type}
                    onClick={() => handleConnect(type)}
                    disabled={anySetupBusy}
                    className="flex items-center gap-3 w-full p-3 sm:p-4 rounded-xl border border-border bg-background hover:bg-muted/50 hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-left"
                  >
                    <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center font-mono font-bold text-sm shrink-0 bg-blue-500/10 text-blue-500">
                      {label[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-medium truncate">{label}</div>
                      <div className="text-xs text-muted-foreground truncate">{sub}</div>
                    </div>
                    {wallet?.walletType === type && activeMode === "wallet" && (
                      <CheckCircle className="w-4 h-4 text-primary ml-auto shrink-0" />
                    )}
                  </button>
                ))}
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 text-muted-foreground/40">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs font-mono uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {/* Passkey / WebAuthn */}
              <div className="space-y-2">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Device</p>
                <button
                  onClick={handlePasskeyRegister}
                  disabled={anySetupBusy}
                  className="flex items-center gap-3 w-full p-3 sm:p-4 rounded-xl border border-border bg-background hover:bg-muted/50 hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all text-left"
                >
                  <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-500">
                    <Fingerprint className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-mono text-sm font-medium truncate">Passkey</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {passkeyState === "registering" ? "Creating passkey…" :
                       passkeyState === "deploying"   ? "Deploying smart account…" :
                       "Face ID / Touch ID / Hardware key"}
                    </div>
                  </div>
                  {passkeyState === "ready" && activeMode === "passkey" && (
                    <CheckCircle className="w-4 h-4 text-primary ml-auto shrink-0" />
                  )}
                  {(passkeyState === "registering" || passkeyState === "deploying") && (
                    <Loader2 className="w-4 h-4 text-primary ml-auto shrink-0 animate-spin" />
                  )}
                </button>

                {/* Passkey error */}
                {passkeyError && activeMode === "passkey" && (
                  <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold mb-0.5">Error</p>
                      <p className="text-sm opacity-90 break-words">{passkeyError}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Connected key + deploy button (wallet mode) */}
              {activeMode === "wallet" && (setupState === "connected" || setupState === "deploying") && wallet && (
                <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="p-3 rounded-xl border bg-muted/30">
                    <p className="text-xs font-mono text-muted-foreground mb-1 uppercase tracking-wider">Connected Key</p>
                    <p className="font-mono text-xs break-all leading-relaxed">{wallet.publicKeyHex}</p>
                  </div>
                  <button
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

              {/* Setup error (wallet) */}
              {setupError && activeMode === "wallet" && (
                <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold mb-0.5">Error</p>
                    <p className="text-sm opacity-90 break-words">{setupError}</p>
                  </div>
                </div>
              )}

              {/* Idle state */}
              {!activeMode && (
                <div className="flex items-center gap-2 text-muted-foreground/50 py-4">
                  <Activity className="w-5 h-5" />
                  <span className="font-mono text-sm">Awaiting signer…</span>
                </div>
              )}

              {/* Disconnect */}
              {isReady && (
                <button
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
              {(setupState === "connecting" || passkeyState === "registering" || passkeyState === "deploying") && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-primary">
                  <Loader2 className="w-8 h-8 animate-spin" />
                  <p className="font-mono text-sm animate-pulse text-center">
                    {passkeyState === "registering" ? "Registering passkey…" :
                     passkeyState === "deploying"   ? "Deploying smart account…" :
                     "Connecting & checking on-chain…"}
                  </p>
                </div>
              )}

              {/* Idle / error placeholder */}
              {!activeMode && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground/40">
                  <Activity className="w-8 h-8" />
                  <p className="font-mono text-sm text-center">Choose a signer to begin.</p>
                </div>
              )}

              {/* Account ready */}
              {isReady && smartAccountAddr && (
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
                        Signed by: {signerLabel} → verifier → smart account
                      </p>
                    </div>
                  )}

                  {/* Increment button */}
                  <button
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

      <style>{`@keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }`}</style>
    </div>
  );
}
