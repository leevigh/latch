"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ConnectWalletBar } from "@/components/sign-demo/ConnectWalletBar";
import { LatchWalletProvider, useLatchWallet } from "@/lib/sign-demo/useLatchWallet";
import { SignDemoApiResult } from "@/components/sign-demo/SignDemoApiResult";
import { TruncatedXdr } from "@/components/sign-demo/TruncatedXdr";
import {
  buildSendRemote,
  buildSignDemo,
  fetchSignPayload,
  goApiBase,
  isSignDemoApiError,
  prepareSign,
  SignDemoApiError,
  submitTransaction,
  storeSignPayload,
} from "@/lib/sign-demo/api";
import {
  LatchWalletError,
  signWithLatch,
  openSignRequestViaLatch,
} from "@/lib/sign-demo/latchWallet";
import {
  parseCallContractIdFromMessage,
  runContextRuleSetupAndSign,
} from "@/lib/sign-demo/setupFlow";
import { ensureContextRuleThen, isMissingContextRuleError } from "@/lib/context-rule-setup";
import type {
  BuildSendRemoteResponse,
  DemoAction,
  Network,
  PrepareSignResponse,
} from "@/lib/sign-demo/types";
import {
  appOrigin,
  callbackUrl,
  newRequestId,
} from "@/lib/sign-demo/walletUrl";

const ACCOUNT_STORAGE_KEY = "latch.signDemo.account";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-background/80 p-5 sm:p-6 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

const inputClass =
  "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-mono disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
const primaryBtnClass =
  "rounded-xl bg-primary px-4 py-2.5 text-sm font-mono font-medium text-primary-foreground disabled:opacity-50 transition-colors hover:bg-primary/90";
const secondaryBtnClass =
  "rounded-xl border border-border px-4 py-2.5 text-sm font-mono font-medium disabled:opacity-50 hover:bg-muted/40 transition-colors";

function SignDemoPageContent() {
  const wallet = useLatchWallet();
  const [manualOverride, setManualOverride] = useState(false);
  const [smartAccountAddress, setSmartAccountAddress] = useState("");
  const [network, setNetwork] = useState<Network>("testnet");
  const [signerType, setSignerType] = useState<"passkey" | "phantom" | "freighter" | "">("");
  const [signerG, setSignerG] = useState("");
  const [publicKeyHex, setPublicKeyHex] = useState("");
  const [keyDataHex, setKeyDataHex] = useState("");
  const [demoAction, setDemoAction] = useState<DemoAction>("noop");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [assetId, setAssetId] = useState("native");

  const [unsignedTxXdr, setUnsignedTxXdr] = useState<string | null>(null);
  const [builtForAccount, setBuiltForAccount] = useState<string | null>(null);
  const [buildDescription, setBuildDescription] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<SignDemoApiError | Error | null>(null);
  const [buildLoading, setBuildLoading] = useState(false);
  const [buildStatus, setBuildStatus] = useState<string | null>(null);
  const [lastBuiltAssetId, setLastBuiltAssetId] = useState<string | null>(null);

  const [b2Recipient, setB2Recipient] = useState("");
  const [b2Amount, setB2Amount] = useState("1");
  const [b2AssetId, setB2AssetId] = useState("native");
  const [b2Result, setB2Result] = useState<BuildSendRemoteResponse | null>(null);
  const [b2Error, setB2Error] = useState<SignDemoApiError | Error | null>(null);
  const [b2Loading, setB2Loading] = useState(false);
  const [b2Status, setB2Status] = useState<string | null>(null);
  const goBase = goApiBase();

  const [prepareResult, setPrepareResult] = useState<PrepareSignResponse | null>(null);
  const [prepareError, setPrepareError] = useState<SignDemoApiError | Error | null>(null);
  const [prepareLoading, setPrepareLoading] = useState(false);
  const [prepareStatus, setPrepareStatus] = useState<string | null>(null);

  const [payloadResult, setPayloadResult] = useState<{
    payloadRef: string;
    expiresAt: string;
    match: boolean;
  } | null>(null);
  const [payloadError, setPayloadError] = useState<SignDemoApiError | Error | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);

  const [redirectStatus, setRedirectStatus] = useState<string | null>(null);
  const [inPageResult, setInPageResult] = useState<string | null>(null);
  const [inPageLabel, setInPageLabel] = useState<string | null>(null);
  const [inPageError, setInPageError] = useState<string | null>(null);
  const [inPageNotice, setInPageNotice] = useState<string | null>(null);
  const [inPageLoading, setInPageLoading] = useState(false);

  const origin = appOrigin();
  const cbUrl = callbackUrl(origin);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACCOUNT_STORAGE_KEY);
      if (saved) setSmartAccountAddress(saved);
    } catch {
      // ignore
    }
  }, []);

  const persistAccount = useCallback((addr: string) => {
    setSmartAccountAddress(addr);
    try {
      localStorage.setItem(ACCOUNT_STORAGE_KEY, addr);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (wallet.status === "connected" && wallet.publicKey && !manualOverride) {
      persistAccount(wallet.publicKey);
      if (wallet.network) setNetwork(wallet.network);
    }
  }, [wallet.status, wallet.publicKey, wallet.network, manualOverride, persistAccount]);

  const resolveSmartAccountAddress = useCallback((): string => {
    if (wallet.status === "connected" && wallet.publicKey && !manualOverride) {
      return wallet.publicKey.trim();
    }
    return smartAccountAddress.trim();
  }, [wallet.status, wallet.publicKey, manualOverride, smartAccountAddress]);

  useEffect(() => {
    if (!unsignedTxXdr || !builtForAccount) return;
    const current = resolveSmartAccountAddress();
    if (current && builtForAccount !== current) {
      setUnsignedTxXdr(null);
      setBuiltForAccount(null);
      setBuildDescription(null);
      setPrepareResult(null);
      setPrepareError(null);
      setPayloadResult(null);
      setPayloadError(null);
    }
  }, [unsignedTxXdr, builtForAccount, resolveSmartAccountAddress]);

  function optionalSignerFields() {
    if (!signerType) return null;
    return {
      signerType,
      signerG: signerG.trim() || undefined,
      publicKeyHex: publicKeyHex.trim() || undefined,
      keyDataHex: keyDataHex.trim() || undefined,
    };
  }

  function latchAccountOrNull() {
    return wallet.status === "connected" ? wallet.publicKey : null;
  }

  function formatLatchWalletError(e: unknown): string {
    if (e instanceof LatchWalletError) {
      switch (e.code) {
        case "no_extension":
          return "Latch extension is not installed. Install it to sign transactions.";
        case "outdated_extension":
          return "Latch extension is outdated. Reload the extension and try again.";
        case "timeout":
          return "Timed out waiting for the wallet. Try again.";
        case "user_rejected":
          return "Signing cancelled.";
        case "account_mismatch":
          return e.message;
        default:
          return e.message;
      }
    }
    if (e instanceof Error) return e.message;
    return String(e);
  }

  async function handleBuild() {
    let account = resolveSmartAccountAddress();
    if (!account) {
      setBuildError(new Error("Set a smart account address or connect your wallet."));
      return;
    }

    setBuildLoading(true);
    setBuildError(null);
    setBuildDescription(null);
    setBuildStatus(null);
    setUnsignedTxXdr(null);
    setBuiltForAccount(null);
    setPrepareResult(null);
    setPrepareError(null);
    setPayloadResult(null);
    setPayloadError(null);

    try {
      // Always sync to the extension's *current* active account before building.
      if (!manualOverride) {
        if (wallet.status !== "connected") {
          setBuildStatus("Connecting wallet…");
          const connected = await wallet.connect();
          account = connected?.publicKey?.trim() || resolveSmartAccountAddress();
        } else {
          setBuildStatus("Syncing active Latch account…");
          const synced = await wallet.refreshAccount();
          account = synced?.publicKey?.trim() || resolveSmartAccountAddress();
        }
        if (!account) {
          throw new Error("Could not read the active Latch account. Reconnect and try again.");
        }
      }
    } catch (e) {
      setBuildError(e instanceof Error ? e : new Error(String(e)));
      setBuildStatus(null);
      setBuildLoading(false);
      return;
    }

    const assetForSetup = demoAction === "transfer" ? assetId : "native";

    try {
      const res = await ensureContextRuleThen(
        async () => {
          try {
            const built = await buildSignDemo({
              network,
              smartAccountAddress: account,
              demoAction,
              ...(demoAction === "transfer"
                ? { recipient: recipient.trim(), amount, assetId }
                : {}),
            });
            return { ok: true as const, value: built };
          } catch (e) {
            if (isSignDemoApiError(e)) {
              return {
                ok: false as const,
                status: e.status,
                code: e.code,
                message: e.message,
                suggestedAction: e.suggestedAction,
              };
            }
            throw e;
          }
        },
        {
          onNeedsSetup: () =>
            setBuildStatus("Building setup transaction…"),
          runSetup: async () => {
            const setup = await runContextRuleSetupAndSign({
              smartAccountAddress: account,
              network,
              fields: optionalSignerFields(),
              assetId: assetForSetup,
              latchAccount: account,
              onPhase: (_phase, status) => setBuildStatus(status),
            });
            setBuildStatus(setup.status);
          },
        }
      );

      setUnsignedTxXdr(res.unsignedTxXdr);
      setBuiltForAccount(account);
      setBuildDescription(res.description);
      setLastBuiltAssetId(assetForSetup);
      setBuildStatus(null);

      // Production dApp loop: after unsigned intent is ready, open wallet (sign-only)
      // then submit the returned signedTxXdr from the dApp.
      try {
        await signTransferInPage({
          unsignedTxXdr: res.unsignedTxXdr,
          account,
          connectIfNeeded: true,
        });
      } catch {
        // Build succeeded; sign/submit errors are shown in Section E state.
      }
    } catch (e) {
      setBuildError(e instanceof Error ? e : new Error(String(e)));
      setBuildStatus(null);
    } finally {
      setBuildLoading(false);
    }
  }

  async function handleBuildRemote() {
    const account = resolveSmartAccountAddress();
    if (!account) {
      setB2Error(new Error("Set a smart account address or connect your wallet."));
      return;
    }
    if (!signerType) {
      setB2Error(
        new Error("Select signer type in Section A (required by Go build-send).")
      );
      return;
    }
    if (!b2Recipient.trim() || !b2Amount.trim()) {
      setB2Error(new Error("Enter recipient and amount for Section B2."));
      return;
    }

    setB2Loading(true);
    setB2Error(null);
    setB2Result(null);
    setB2Status(null);

    try {
      const res = await ensureContextRuleThen(
        async () => {
          try {
            const built = await buildSendRemote({
              smartAccountAddress: account,
              signerType,
              recipient: b2Recipient.trim(),
              amount: b2Amount.trim(),
              assetId: b2AssetId,
              ...(signerType === "freighter" && signerG.trim()
                ? { signerG: signerG.trim() }
                : {}),
              ...(signerType === "phantom" && publicKeyHex.trim()
                ? { publicKeyHex: publicKeyHex.trim() }
                : {}),
              ...(signerType === "passkey" && keyDataHex.trim()
                ? { keyDataHex: keyDataHex.trim() }
                : {}),
            });
            return { ok: true as const, value: built };
          } catch (e) {
            if (isSignDemoApiError(e)) {
              return {
                ok: false as const,
                status: e.status,
                code: e.code,
                message: e.message,
                suggestedAction: e.suggestedAction,
              };
            }
            throw e;
          }
        },
        {
          onNeedsSetup: () =>
            setB2Status("Building setup transaction…"),
          runSetup: async () => {
            const setup = await runContextRuleSetupAndSign({
              smartAccountAddress: account,
              network,
              fields: optionalSignerFields(),
              assetId: b2AssetId,
              latchAccount: latchAccountOrNull(),
              onPhase: (_phase, status) => setB2Status(status),
            });
            setB2Status(setup.status);
          },
        }
      );

      setB2Result(res);
      setB2Status(null);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Go may not emit NO_CONTEXT_RULE yet — hint when retry helper never got a rule-missing signal.
      if (
        !isSignDemoApiError(err) ||
        !isMissingContextRuleError(err.status, err.code, err.suggestedAction)
      ) {
        setB2Status(
          "If this failed due to missing send rules and Go did not return NO_CONTEXT_RULE, set up via Section B first. See LATCH_BACKEND_ECOSYSTEM.md."
        );
      }
      setB2Error(err);
    } finally {
      setB2Loading(false);
    }
  }

  async function handlePrepareSign() {
    if (!unsignedTxXdr) return;
    const account = resolveSmartAccountAddress();
    setPrepareLoading(true);
    setPrepareError(null);
    setPrepareResult(null);
    setPrepareStatus(null);

    try {
      const res = await ensureContextRuleThen(
        async () => {
          try {
            const prepared = await prepareSign({
              network,
              smartAccountAddress: account,
              unsignedTxXdr,
              ...(signerType ? { signerType } : {}),
              ...(signerType === "freighter" && signerG
                ? { signerG: signerG.trim() }
                : {}),
            });
            return { ok: true as const, value: prepared };
          } catch (e) {
            if (isSignDemoApiError(e)) {
              return {
                ok: false as const,
                status: e.status,
                code: e.code,
                message: e.message,
                suggestedAction: e.suggestedAction,
              };
            }
            throw e;
          }
        },
        {
          onNeedsSetup: () =>
            setPrepareStatus("Building setup transaction…"),
          runSetup: async () => {
            const setup = await runContextRuleSetupAndSign({
              smartAccountAddress: account,
              network,
              fields: optionalSignerFields(),
              assetId: lastBuiltAssetId ?? "native",
              latchAccount: latchAccountOrNull(),
              onPhase: (_phase, status) => setPrepareStatus(status),
            });
            setPrepareStatus(setup.status);
          },
        }
      );
      setPrepareResult(res);
      setPrepareStatus(null);
    } catch (e) {
      // Retry once with contract id from error message if catalog asset unknown
      if (
        isSignDemoApiError(e) &&
        isMissingContextRuleError(e.status, e.code, e.suggestedAction)
      ) {
        try {
          const contractId = parseCallContractIdFromMessage(e.message);
          setPrepareStatus("Building setup transaction…");
          await runContextRuleSetupAndSign({
            smartAccountAddress: account,
            network,
            fields: optionalSignerFields(),
            ...(lastBuiltAssetId
              ? { assetId: lastBuiltAssetId }
              : contractId
                ? { targetContractId: contractId }
                : { assetId: "native" }),
            latchAccount: latchAccountOrNull(),
            onPhase: (_phase, status) => setPrepareStatus(status),
          });
          const retry = await prepareSign({
            network,
            smartAccountAddress: account,
            unsignedTxXdr,
            ...(signerType ? { signerType } : {}),
            ...(signerType === "freighter" && signerG
              ? { signerG: signerG.trim() }
              : {}),
          });
          setPrepareResult(retry);
          setPrepareStatus(null);
          setPrepareError(null);
          return;
        } catch (retryErr) {
          setPrepareError(
            retryErr instanceof Error ? retryErr : new Error(String(retryErr))
          );
          setPrepareStatus(null);
          return;
        }
      }
      setPrepareError(e instanceof Error ? e : new Error(String(e)));
      setPrepareStatus(null);
    } finally {
      setPrepareLoading(false);
    }
  }

  async function handleSignPayloadTest() {
    if (!unsignedTxXdr) return;
    const account = resolveSmartAccountAddress();
    setPayloadLoading(true);
    setPayloadError(null);
    setPayloadResult(null);
    try {
      const requestId = newRequestId();
      const stored = await storeSignPayload({
        network,
        smartAccountAddress: account,
        unsignedTxXdr,
        callback: cbUrl,
        requestId,
        origin,
        submit: false,
      });
      const fetched = await fetchSignPayload(stored.payloadRef);
      setPayloadResult({
        payloadRef: stored.payloadRef,
        expiresAt: stored.expiresAt,
        match: fetched.unsignedTxXdr === unsignedTxXdr,
      });
    } catch (e) {
      setPayloadError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setPayloadLoading(false);
    }
  }

  function walletSignParams(account: string) {
    return {
      network,
      account,
      callback: cbUrl,
      requestId: newRequestId(),
      // dApp submits: wallet returns signedTxXdr in the callback fragment.
      submit: false as const,
      origin,
    };
  }

  function requireConnectedWalletAccount(): string | null {
    if (wallet.status !== "connected" || !wallet.publicKey) {
      setRedirectStatus("Connect wallet first (Section A / Connect Wallet bar).");
      return null;
    }
    if (manualOverride && resolveSmartAccountAddress() !== wallet.publicKey) {
      setRedirectStatus(
        "Manual account override does not match the connected wallet. Disable override or switch wallet account."
      );
      return null;
    }
    if (builtForAccount && builtForAccount !== wallet.publicKey) {
      setRedirectStatus(
        "Transaction was built for a different account. Rebuild the demo transaction after connecting."
      );
      return null;
    }
    return wallet.publicKey.trim();
  }

  async function redirectInlineXdr() {
    if (!unsignedTxXdr) {
      setRedirectStatus("Build a transaction first.");
      return;
    }
    if (wallet.status !== "connected" || !wallet.publicKey) {
      setRedirectStatus("Connecting wallet…");
      try {
        await wallet.connect();
      } catch (e) {
        setRedirectStatus(formatLatchWalletError(e));
        return;
      }
    }

    const account = requireConnectedWalletAccount();
    if (!account) return;
    try {
      setRedirectStatus("Opening Latch wallet…");
      await openSignRequestViaLatch({
        ...walletSignParams(account),
        xdr: unsignedTxXdr,
      });
      setRedirectStatus(
        "Sign-request tab opened in extension. Complete signing there — you will return to the callback page."
      );
    } catch (e) {
      setRedirectStatus(formatLatchWalletError(e));
    }
  }

  async function redirectPayloadRef() {
    if (!unsignedTxXdr) {
      setRedirectStatus("Build a transaction first.");
      return;
    }
    if (wallet.status !== "connected" || !wallet.publicKey) {
      setRedirectStatus("Connecting wallet…");
      try {
        await wallet.connect();
      } catch (e) {
        setRedirectStatus(formatLatchWalletError(e));
        return;
      }
    }

    const account = requireConnectedWalletAccount();
    if (!account) return;
    try {
      const requestId = newRequestId();
      const { payloadRef } = await storeSignPayload({
        network,
        smartAccountAddress: account,
        unsignedTxXdr,
        callback: cbUrl,
        requestId,
        origin,
        submit: false,
      });
      setRedirectStatus("Opening Latch wallet…");
      await openSignRequestViaLatch({
        ...walletSignParams(account),
        requestId,
        payloadRef,
      });
      setRedirectStatus(
        "Sign-request tab opened. Complete signing in the extension wallet tab (sign-only; submit from callback)."
      );
    } catch (e) {
      setRedirectStatus(formatLatchWalletError(e));
    }
  }

  /**
   * dApp submit path: wallet signs with submit:false, harness broadcasts signedTxXdr.
   */
  async function signTransferInPage(args: {
    unsignedTxXdr: string;
    account: string;
    connectIfNeeded?: boolean;
  }): Promise<void> {
    const { unsignedTxXdr: xdr, connectIfNeeded } = args;

    setInPageLoading(true);
    setInPageError(null);
    setInPageNotice(null);
    setInPageResult(null);
    setInPageLabel(null);
    setBuildStatus("Opening Latch wallet to sign…");

    try {
      let active = args.account.trim();

      if (wallet.status !== "connected" || !wallet.publicKey) {
        if (!connectIfNeeded) {
          setInPageNotice("Connect wallet first.");
          return;
        }
        setInPageNotice("Connecting wallet…");
        const connected = await wallet.connect();
        active = connected?.publicKey?.trim() || active;
      } else {
        const synced = await wallet.refreshAccount();
        active = synced?.publicKey?.trim() || wallet.publicKey.trim() || active;
      }

      if (!active) {
        setInPageError("Could not determine the active Latch account.");
        return;
      }
      if (manualOverride && resolveSmartAccountAddress() !== active) {
        setInPageNotice(
          "Manual account override does not match the connected wallet. Disable override or switch wallet account."
        );
        return;
      }
      if (args.account.trim() && args.account.trim() !== active) {
        setInPageError(
          `Transaction was built for ${args.account.slice(0, 6)}…${args.account.slice(-4)} but the active Latch account is now ${active.slice(0, 6)}…${active.slice(-4)}. Rebuild after switching accounts.`
        );
        setBuildStatus(null);
        return;
      }

      const res = await signWithLatch({
        xdr,
        network,
        accountToSign: active,
        submit: false,
      });

      if (res.txHash) {
        // Wallet may still return a hash if it submitted; accept either.
        setInPageResult(res.txHash);
        setInPageLabel("txHash");
        setBuildStatus(null);
        return;
      }

      const signedTxXdr = res.signedTxXdr ?? res.signedXdr;
      if (!signedTxXdr) {
        setInPageError(
          "Wallet signing finished, but no signed transaction was returned."
        );
        return;
      }

      setBuildStatus("Submitting signed transaction via RPC…");
      setInPageNotice("Submitting signed transaction via RPC…");
      const { txHash } = await submitTransaction({
        network,
        signedTxXdr,
      });
      setInPageResult(txHash);
      setInPageLabel("txHash");
      setInPageNotice(null);
      setBuildStatus(null);
    } catch (e) {
      if (e instanceof LatchWalletError && e.code === "user_rejected") {
        setInPageNotice("Signing cancelled.");
        setInPageError(null);
        setBuildStatus(null);
        return;
      }
      setInPageError(formatLatchWalletError(e));
      setBuildStatus(null);
      throw e;
    } finally {
      setInPageLoading(false);
    }
  }

  async function handleInPageSign() {
    if (!unsignedTxXdr) return;
    try {
      await signTransferInPage({
        unsignedTxXdr,
        account: resolveSmartAccountAddress(),
        connectIfNeeded: true,
      });
    } catch {
      // Error already surfaced in in-page / build status.
    }
  }

  const accountReadOnly = wallet.status === "connected" && !manualOverride;

  return (
    <main className="relative min-h-screen pt-24 sm:pt-32 pb-16">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--tw-gradient-stops))] from-primary/5 via-background to-background" />
      <div className="mx-auto max-w-2xl px-4 sm:px-6 space-y-6">
        <header className="space-y-2">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Dev tooling
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Latch Sign Demo</h1>
          <p className="text-sm text-muted-foreground max-w-xl">
            Connect a Latch wallet, build a sample Soroban tx, auto-open the wallet
            with submit:false, and submit the signed envelope from this page (dApp
            flow). Also exercises prepare-sign, sign-payload, and Go build-send.
          </p>
        </header>

        <ConnectWalletBar />

        <Section
          title="Section A — Account"
          description="Smart account used for builds and signing. Choose a signer type before transfer setup."
        >
          <div className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={manualOverride}
                onChange={(e) => setManualOverride(e.target.checked)}
              />
              Manual override
            </label>
            {wallet.status === "connected" && !manualOverride && (
              <span className="text-muted-foreground">Connected account</span>
            )}
          </div>

          <label className="block space-y-1.5">
            <FieldLabel>Smart account (C-address)</FieldLabel>
            <input
              className={inputClass}
              value={smartAccountAddress}
              onChange={(e) => persistAccount(e.target.value)}
              readOnly={accountReadOnly}
              placeholder="C..."
            />
          </label>

          <label className="block space-y-1.5">
            <FieldLabel>Network</FieldLabel>
            <select
              className={inputClass}
              value={network}
              onChange={(e) => setNetwork(e.target.value as Network)}
              disabled={accountReadOnly}
            >
              <option value="testnet">testnet</option>
              <option value="mainnet">mainnet</option>
            </select>
          </label>

          <div className="flex flex-col sm:flex-row gap-3">
            <label className="block space-y-1.5 flex-1">
              <FieldLabel>Signer type</FieldLabel>
              <select
                className={inputClass}
                value={signerType}
                onChange={(e) =>
                  setSignerType(e.target.value as typeof signerType)
                }
              >
                <option value="">default</option>
                <option value="passkey">passkey</option>
                <option value="phantom">phantom</option>
                <option value="freighter">freighter</option>
              </select>
            </label>
            {signerType === "freighter" && (
              <label className="block space-y-1.5 flex-1">
                <FieldLabel>Signer G-address</FieldLabel>
                <input
                  className={inputClass}
                  value={signerG}
                  onChange={(e) => setSignerG(e.target.value)}
                  placeholder="G..."
                />
              </label>
            )}
          </div>

          {signerType === "phantom" && (
            <label className="block space-y-1.5">
              <FieldLabel>Phantom publicKeyHex (setup)</FieldLabel>
              <input
                className={inputClass}
                value={publicKeyHex}
                onChange={(e) => setPublicKeyHex(e.target.value)}
                placeholder="64 hex chars"
              />
            </label>
          )}
          {signerType === "passkey" && (
            <label className="block space-y-1.5">
              <FieldLabel>Passkey keyDataHex (setup)</FieldLabel>
              <input
                className={inputClass}
                value={keyDataHex}
                onChange={(e) => setKeyDataHex(e.target.value)}
                placeholder="key material hex"
              />
            </label>
          )}
        </Section>

        <Section
          title="Section B — Build & sign (local)"
          description="Builds via /api/transaction/build-sign-demo. On NO_CONTEXT_RULE it runs setup-send-rules, opens Latch to sign+submit the setup tx (extension WebAuthn / delegated — never page-hostname passkeys), then retries. After a successful build it opens Latch with submit:false and this page submits the signedTxXdr via RPC."
        >
          <label className="block space-y-1.5">
            <FieldLabel>Demo action</FieldLabel>
            <select
              className={inputClass}
              value={demoAction}
              onChange={(e) => setDemoAction(e.target.value as DemoAction)}
            >
              <option value="noop">noop (self-transfer smoke test)</option>
              <option value="transfer">transfer</option>
            </select>
          </label>

          {demoAction === "transfer" && (
            <>
              <label className="block space-y-1.5">
                <FieldLabel>Recipient</FieldLabel>
                <input
                  className={inputClass}
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="G... or C..."
                />
              </label>
              <div className="flex gap-3">
                <label className="block space-y-1.5 flex-1">
                  <FieldLabel>Amount</FieldLabel>
                  <input
                    className={inputClass}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="block space-y-1.5 w-28">
                  <FieldLabel>Asset</FieldLabel>
                  <select
                    className={inputClass}
                    value={assetId}
                    onChange={(e) => setAssetId(e.target.value)}
                  >
                    <option value="native">XLM</option>
                    <option value="USDC">USDC</option>
                  </select>
                </label>
              </div>
            </>
          )}

          <button
            type="button"
            disabled={buildLoading || inPageLoading || !resolveSmartAccountAddress()}
            onClick={() => void handleBuild()}
            className={primaryBtnClass}
          >
            {buildLoading
              ? "Building…"
              : inPageLoading
                ? "Signing…"
                : "Build & sign with Latch"}
          </button>

          {buildStatus && (
            <p className="text-sm text-amber-700 dark:text-amber-400">{buildStatus}</p>
          )}
          {buildDescription && (
            <p className="text-sm text-muted-foreground">{buildDescription}</p>
          )}
          {unsignedTxXdr && <TruncatedXdr xdr={unsignedTxXdr} label="Unsigned tx XDR" />}
          {buildError && <SignDemoApiResult title="Build" error={buildError} />}
        </Section>

        <Section
          title="Section B2 — Build via Latch API (build-send)"
          description={`Posts to ${goBase}/api/transaction/build-send. Same send intent as transfer; response is auth-ready txXdr (not unsigned-only).`}
        >
          <label className="block space-y-1.5">
            <FieldLabel>Recipient</FieldLabel>
            <input
              className={inputClass}
              value={b2Recipient}
              onChange={(e) => setB2Recipient(e.target.value)}
              placeholder="G... or C..."
            />
          </label>
          <div className="flex gap-3">
            <label className="block space-y-1.5 flex-1">
              <FieldLabel>Amount</FieldLabel>
              <input
                className={inputClass}
                value={b2Amount}
                onChange={(e) => setB2Amount(e.target.value)}
              />
            </label>
            <label className="block space-y-1.5 w-28">
              <FieldLabel>Asset</FieldLabel>
              <select
                className={inputClass}
                value={b2AssetId}
                onChange={(e) => setB2AssetId(e.target.value)}
              >
                <option value="native">XLM</option>
                <option value="USDC">USDC</option>
              </select>
            </label>
          </div>

          <button
            type="button"
            disabled={b2Loading || !resolveSmartAccountAddress()}
            onClick={() => void handleBuildRemote()}
            className={primaryBtnClass}
          >
            {b2Loading ? "Building via Go API…" : "Build via Latch API"}
          </button>

          {b2Status && (
            <p className="text-sm text-amber-700 dark:text-amber-400">{b2Status}</p>
          )}
          {b2Result?.txXdr && (
            <TruncatedXdr xdr={String(b2Result.txXdr)} label="Go API txXdr" />
          )}
          {b2Result?.authDigestHex != null && (
            <p className="text-sm font-mono text-muted-foreground break-all">
              authDigest: {String(b2Result.authDigestHex).slice(0, 24)}…
            </p>
          )}
          {b2Result && !b2Error && (
            <SignDemoApiResult title="Go build-send" result={b2Result} />
          )}
          {b2Error && <SignDemoApiResult title="Go build-send" error={b2Error} />}
        </Section>

        <Section
          title="Section C — API test (no wallet)"
          description="prepare-sign and sign-payload round-trip against the local (or NEXT_PUBLIC_LATCH_API_URL) API."
        >
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={prepareLoading || !unsignedTxXdr}
              onClick={() => void handlePrepareSign()}
              className={secondaryBtnClass}
            >
              {prepareLoading ? "Testing…" : "Test prepare-sign"}
            </button>
            <button
              type="button"
              disabled={payloadLoading || !unsignedTxXdr}
              onClick={() => void handleSignPayloadTest()}
              className={secondaryBtnClass}
            >
              {payloadLoading ? "Testing…" : "Test sign-payload POST + GET"}
            </button>
          </div>

          {prepareStatus && (
            <p className="text-sm text-amber-700 dark:text-amber-400">{prepareStatus}</p>
          )}

          <SignDemoApiResult
            title="prepare-sign"
            result={prepareResult}
            error={prepareError}
          />

          {payloadResult && (
            <div className="rounded-xl border bg-muted/30 p-3 space-y-1 text-sm">
              <p className="font-medium">sign-payload round-trip — success</p>
              <p>
                payloadRef:{" "}
                <span className="font-mono">{payloadResult.payloadRef}</span>
              </p>
              <p>
                expiresAt:{" "}
                <span className="font-mono">{payloadResult.expiresAt}</span>
              </p>
              <p
                className={
                  payloadResult.match ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"
                }
              >
                XDR match: {payloadResult.match ? "yes" : "no"}
              </p>
            </div>
          )}
          {payloadError && (
            <SignDemoApiResult title="sign-payload" error={payloadError} />
          )}
        </Section>

        <Section
          title="Section D — Wallet redirect"
          description="Uses window.latch.openSignRequest() so the extension opens the sign tab internally."
        >
          {wallet.status !== "connected" && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Connect wallet above before using redirect sign.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!unsignedTxXdr || wallet.status !== "connected"}
              onClick={redirectInlineXdr}
              className={secondaryBtnClass}
            >
              Sign with Latch (inline XDR)
            </button>
            <button
              type="button"
              disabled={!unsignedTxXdr || wallet.status !== "connected"}
              onClick={() => void redirectPayloadRef()}
              className={secondaryBtnClass}
            >
              Sign with Latch (payload ref)
            </button>
          </div>
          {redirectStatus && (
            <p className="text-sm text-muted-foreground">{redirectStatus}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Callback: <code className="font-mono">{cbUrl}</code>
          </p>
        </Section>

        <Section
          title="Section E — In-page sign"
          description="Re-sign the Section B unsigned XDR with submit:false; this page submits signedTxXdr via RPC. Build & sign already runs this automatically."
        >
          <button
            type="button"
            disabled={
              inPageLoading ||
              !unsignedTxXdr ||
              !wallet.publicKey
            }
            onClick={() => void handleInPageSign()}
            className={secondaryBtnClass}
          >
            {inPageLoading ? "Signing…" : "Sign transaction in-page"}
          </button>
          {wallet.status !== "connected" && (
            <p className="text-sm text-muted-foreground">
              Connect wallet above or click to auto-connect and sign.
            </p>
          )}
          {inPageNotice && (
            <p className="text-sm text-muted-foreground">{inPageNotice}</p>
          )}
          {inPageResult && (
            <TruncatedXdr xdr={inPageResult} label={inPageLabel ?? "Signed XDR"} />
          )}
          {inPageError && (
            <p className="text-sm text-destructive">{inPageError}</p>
          )}
        </Section>
      </div>
    </main>
  );
}

export default function SignDemoPage() {
  return (
    <LatchWalletProvider>
      <SignDemoPageContent />
    </LatchWalletProvider>
  );
}
