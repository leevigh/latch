"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  computeAuthDigest,
  encodeWebAuthnSigData,
  signWithPasskey,
} from "@/lib/webauthn";
import { signAuthEntry } from "@stellar/freighter-api";
import { xdr, Networks } from "@stellar/stellar-sdk";
import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Hash,
  Loader2,
  Send,
} from "lucide-react";
import type { WalletConnectionResult } from "@/lib/wallets";

const AUTH_PREFIX = "Stellar Smart Account Auth:\n";
const NETWORK_PASSPHRASE = Networks.TESTNET;

type SendState =
  | "idle"
  | "building"
  | "signing"
  | "submitting"
  | "success"
  | "error";

type BalanceRow = {
  assetId: string;
  symbol: string;
  contractId: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
};

type PasskeySession = {
  credentialId: string;
  keyDataHex: string;
};

export type SendCardProps = {
  smartAccountAddress: string;
  activeMode: "wallet" | "passkey" | null;
  wallet: WalletConnectionResult | null;
  passkeySession: PasskeySession | null;
  disabled?: boolean;
};

function signerTypeFromProps(
  activeMode: SendCardProps["activeMode"],
  wallet: WalletConnectionResult | null
): "passkey" | "phantom" | "freighter" | null {
  if (activeMode === "passkey") return "passkey";
  if (activeMode === "wallet" && wallet?.walletType === "freighter") return "freighter";
  if (activeMode === "wallet" && (wallet?.walletType === "phantom" || wallet?.walletType === "lobstr")) {
    return "phantom";
  }
  return null;
}

export function SendCard({
  smartAccountAddress,
  activeMode,
  wallet,
  passkeySession,
  disabled = false,
}: SendCardProps) {
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState("native");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendHash, setSendHash] = useState<string | null>(null);

  const signerType = signerTypeFromProps(activeMode, wallet);

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
      console.error(e);
    } finally {
      setBalancesLoading(false);
    }
  }, [smartAccountAddress, assetId]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  const submitBuiltTx = async (build: Record<string, unknown>) => {
    const contextRuleId = build.contextRuleId as number;
    const txXdr = build.txXdr as string;
    const authEntryXdr = build.authEntryXdr as string;

    if (signerType === "passkey" && passkeySession) {
      const validUntilLedger = build.validUntilLedger as number;
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
      authEntry.credentials().address().signatureExpirationLedger(validUntilLedger);
      const authDigest = computeAuthDigest(authEntry, NETWORK_PASSPHRASE, [contextRuleId]);

      setSendState("signing");
      const sig = await signWithPasskey(
        passkeySession.credentialId,
        authDigest,
        window.location.hostname
      );
      const sigDataXdr = encodeWebAuthnSigData(sig);

      setSendState("submitting");
      const submitRes = await fetch("/api/transaction/submit-webauthn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txXdr,
          authEntryXdr,
          sigDataXdr: sigDataXdr.toString("hex"),
          keyDataHex: passkeySession.keyDataHex,
          contextRuleId,
        }),
      });
      const submitData = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitData.error ?? "Submit failed");
      setSendHash(submitData.hash);
      return;
    }

    if (signerType === "freighter" && wallet?.gAddress) {
      const smartAccountAuthEntryXdr = build.smartAccountAuthEntryXdr as string;
      const gAddressPreimageXdr = build.gAddressPreimageXdr as string;
      const gAddressEntryTemplateXdr = build.gAddressEntryTemplateXdr as string;

      setSendState("signing");
      const signResult = await signAuthEntry(gAddressPreimageXdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      if (signResult.error) {
        throw new Error(signResult.error.message || "Freighter signing failed");
      }
      if (!signResult.signedAuthEntry) {
        throw new Error("Freighter returned no signed auth entry");
      }

      setSendState("submitting");
      const submitRes = await fetch("/api/transaction/submit-delegated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txXdr,
          smartAccountAuthEntryXdr,
          gAddressEntryTemplateXdr,
          signedAuthEntryBase64: signResult.signedAuthEntry,
          signerAddress: signResult.signerAddress,
        }),
      });
      const submitData = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitData.error ?? "Submit failed");
      setSendHash(submitData.hash);
      return;
    }

    if (signerType === "phantom" && wallet) {
      const authDigestHex = build.authDigestHex as string;

      const signPrefixed = async (hashHex: string) => {
        const prefixedMessage = AUTH_PREFIX + hashHex.toLowerCase();
        const messageBytes = new TextEncoder().encode(prefixedMessage);
        const provider = (
          window as unknown as {
            phantom?: {
              solana?: {
                signMessage: (m: Uint8Array, enc: string) => Promise<{ signature: Uint8Array }>;
              };
            };
          }
        ).phantom?.solana;
        if (!provider) throw new Error("Phantom not found.");
        const result = await provider.signMessage(messageBytes, "utf8");
        return {
          prefixedMessage,
          authSignatureHex: Buffer.from(result.signature).toString("hex"),
        };
      };

      setSendState("signing");
      const signed = await signPrefixed(authDigestHex);
      setSendState("submitting");
      const submitRes = await fetch("/api/transaction/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txXdr,
          authEntryXdr,
          authSignatureHex: signed.authSignatureHex,
          prefixedMessage: signed.prefixedMessage,
          publicKeyHex: wallet.publicKeyHex,
          contextRuleId,
        }),
      });
      const submitData = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitData.error ?? "Submit failed");
      setSendHash(submitData.hash);
    }
  };

  const runSetupSendRules = async (forAssetId: string) => {
    const body: Record<string, unknown> = {
      smartAccountAddress,
      signerType,
      assetId: forAssetId,
    };
    if (signerType === "phantom" && wallet) {
      body.publicKeyHex = wallet.publicKeyHex;
    }
    if (signerType === "passkey" && passkeySession) {
      body.keyDataHex = passkeySession.keyDataHex;
    }
    if (signerType === "freighter" && wallet?.gAddress) {
      body.gAddress = wallet.gAddress;
    }

    const setupRes = await fetch("/api/smart-account/setup-send-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const setup = await setupRes.json();
    if (!setupRes.ok) throw new Error(setup.error ?? "Setup build failed");
    if (setup.alreadyConfigured) return;

    await submitBuiltTx(setup);
  };

  const buildSendWithSetup = async (buildBody: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const buildRes = await fetch("/api/transaction/build-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody),
      });
      const build = await buildRes.json();

      if (buildRes.ok) return build;

      if (buildRes.status === 409 && build.code === "NO_CONTEXT_RULE") {
        await runSetupSendRules(String(buildBody.assetId ?? assetId));
        continue;
      }

      throw new Error(build.error ?? "Build failed");
    }
    throw new Error("Send setup did not complete. Try again.");
  };

  const handleSend = async () => {
    if (!smartAccountAddress || !signerType) return;
    if (!recipient.trim() || !amount.trim()) {
      setSendError("Enter recipient and amount.");
      return;
    }

    setSendState("building");
    setSendError(null);
    setSendHash(null);

    try {
      const buildBody: Record<string, unknown> = {
        smartAccountAddress,
        signerType,
        assetId,
        recipient: recipient.trim(),
        amount: amount.trim(),
      };
      if (signerType === "freighter" && wallet?.gAddress) {
        buildBody.signerG = wallet.gAddress;
      }

      const build = await buildSendWithSetup(buildBody);
      await submitBuiltTx(build);

      setSendState("success");
      await fetchBalances();
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : "Send failed");
      setSendState("error");
    }
  };

  const isBusy =
    sendState === "building" || sendState === "signing" || sendState === "submitting";

  const sendLabel: Record<SendState, string> = {
    idle: "Send",
    building: "Building…",
    signing: "Sign in wallet…",
    submitting: "Submitting…",
    success: "Send again",
    error: "Retry send",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-muted-foreground/50">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs font-mono uppercase tracking-wider whitespace-nowrap">
          Send tokens
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {balancesLoading ? (
        <p className="text-xs font-mono text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading balances…
        </p>
      ) : balancesError ? (
        <p className="text-xs font-mono text-destructive">{balancesError}</p>
      ) : balances.length === 0 ? (
        <p className="text-xs font-mono text-muted-foreground">
          No token balances found. Fund this smart account first.
        </p>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-mono text-muted-foreground uppercase">Asset</span>
            <select
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              disabled={disabled || isBusy}
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
              disabled={disabled || isBusy}
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
              disabled={disabled || isBusy}
              placeholder="0.1"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </label>
        </div>
      )}

      {sendError && (
        <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="font-mono text-xs break-words">{sendError}</p>
        </div>
      )}

      {sendState === "success" && sendHash && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 space-y-1">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="w-4 h-4" />
            <p className="text-xs font-mono font-semibold uppercase">Send confirmed</p>
          </div>
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${sendHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-emerald-700 dark:text-emerald-400 hover:underline inline-flex items-center gap-1 break-all"
          >
            <Hash className="w-3 h-3 shrink-0" />
            {sendHash.slice(0, 16)}…{sendHash.slice(-10)}
            <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
        </div>
      )}

      <button
        type="button"
        onClick={handleSend}
        disabled={disabled || isBusy || !signerType || balances.length === 0}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-primary/30 bg-primary/10 text-primary font-mono text-sm font-medium hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
      >
        {isBusy ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            {sendLabel[sendState]}
          </>
        ) : (
          <>
            <Send className="w-4 h-4" />
            {sendLabel[sendState]}
          </>
        )}
      </button>
    </div>
  );
}