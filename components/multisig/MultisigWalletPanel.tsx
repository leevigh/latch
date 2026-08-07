"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  approveProposalWithFreighter,
  approveProposalWithPasskey,
  createCounterIncrementProposal,
  executeMultisigProposal,
  MultisigApiError,
} from "@/lib/multisig-wallet-client";
import { PROPOSAL_REFRESHED_CODE } from "@/lib/multisig-proposal-refresh";
import {
  formatProposalTitle,
  formatSacTransferDetail,
  type ProposalOperationParams,
} from "@/lib/multisig-proposal-display";
import { MultisigSendProposalForm } from "@/components/multisig/MultisigSendProposalForm";
import { connectFreighter } from "@/lib/wallets";
import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  ExternalLink,
  Fingerprint,
  Loader2,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";

type MultisigAccountRow = {
  id: string;
  smartAccountAddress: string;
  threshold: number;
  createdAt: number;
  proposalCount: number;
  members: {
    id: string;
    memberType: string;
    label: string | null;
    credentialId: string | null;
    gAddress: string | null;
    hasKeyData: boolean;
  }[];
};

type ProposalRow = {
  id: string;
  status: string;
  operationKind: string;
  operationParams?: ProposalOperationParams;
  createdAt: number;
  approvalCount: number;
  executedTxHash: string | null;
  authDigestHex: string;
  validUntilLedger?: number;
};

type ProposalDetail = {
  multisigAccount: { smartAccountAddress: string; threshold: number };
  proposal: ProposalRow & {
    validUntilLedger: number;
    targetContractId?: string;
    operationParams?: ProposalOperationParams;
  };
  members: MultisigAccountRow["members"];
  approvals: { id: string; memberId: string; approvalType: string }[];
};

type StoredCredential = { credentialId: string };

type ProposalCreateMode = "send" | "demo";

export function MultisigWalletPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountFromUrl = searchParams.get("account");
  const proposalFromUrl = searchParams.get("proposal");

  const [accounts, setAccounts] = useState<MultisigAccountRow[]>([]);
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [threshold, setThreshold] = useState(2);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [proposalDetail, setProposalDetail] = useState<ProposalDetail | null>(null);
  const [counterValue, setCounterValue] = useState<number | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const skipUrlSync = useRef(false);
  const hydratedQueryKey = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [proposalCreateMode, setProposalCreateMode] = useState<ProposalCreateMode>("send");
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.smartAccountAddress === selectedAddress) ?? null,
    [accounts, selectedAddress]
  );

  const myWebauthnMembers = useMemo(() => {
    if (!selectedAccount) return [];
    const credIds = new Set(credentials.map((c) => c.credentialId));
    return selectedAccount.members.filter(
      (m) => m.memberType === "webauthn" && m.credentialId && credIds.has(m.credentialId)
    );
  }, [selectedAccount, credentials]);

  const loadAccounts = useCallback(async () => {
    const [acctRes, credRes] = await Promise.all([
      fetch("/api/multisig/accounts", { credentials: "include" }),
      fetch("/api/webauthn/credentials", { credentials: "include" }),
    ]);
    const acctData = await acctRes.json();
    const credData = await credRes.json();
    if (!acctRes.ok) throw new Error(acctData.error ?? "Failed to load accounts");
    const list = (acctData.accounts ?? []) as MultisigAccountRow[];
    setAccounts(list);
    if (Array.isArray(credData.credentials)) {
      setCredentials(credData.credentials);
    }
    return list;
  }, []);

  const syncUrl = useCallback(
    (account: string | null, proposal: string | null) => {
      const params = new URLSearchParams();
      if (account) params.set("account", account);
      if (proposal) params.set("proposal", proposal);
      const q = params.toString();
      router.replace(q ? `/multisig/wallet?${q}` : "/multisig/wallet", { scroll: false });
    },
    [router]
  );

  const pickDefaultProposalId = useCallback(
    (list: ProposalRow[], preferredId: string | null) => {
      if (preferredId && list.some((p) => p.id === preferredId)) return preferredId;
      const pending = list.find((p) => p.status === "pending");
      if (pending) return pending.id;
      return list[0]?.id ?? null;
    },
    []
  );

  const loadProposals = useCallback(
    async (address: string, preferredProposalId?: string | null) => {
      const res = await fetch(
        `/api/multisig/proposals?account=${encodeURIComponent(address)}`,
        { credentials: "include" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load proposals");
      setThreshold(data.threshold ?? 2);
      const list = (data.proposals ?? []) as ProposalRow[];
      setProposals(list);
      return pickDefaultProposalId(list, preferredProposalId ?? null);
    },
    [pickDefaultProposalId]
  );

  const loadProposalDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/multisig/proposals/${id}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load proposal");
    setProposalDetail(data as ProposalDetail);
  }, []);

  const fetchCounter = useCallback(async () => {
    try {
      const res = await fetch("/api/counter");
      if (res.ok) setCounterValue((await res.json()).value);
    } catch {
      /* silent */
    }
  }, []);

  const hydrateFromServer = useCallback(
    async (opts?: { preferredAccount?: string | null; preferredProposal?: string | null }) => {
      setError(null);
      try {
        const list = await loadAccounts();
        const accountPick =
          (opts?.preferredAccount &&
            list.find((a) => a.smartAccountAddress === opts.preferredAccount)
              ?.smartAccountAddress) ||
          list[0]?.smartAccountAddress ||
          null;

        skipUrlSync.current = true;
        setSelectedAddress(accountPick);

        let proposalPick: string | null = null;
        if (accountPick) {
          proposalPick = await loadProposals(accountPick, opts?.preferredProposal ?? null);
          setSelectedProposalId(proposalPick);
        } else {
          setProposals([]);
          setSelectedProposalId(null);
        }

        hydratedQueryKey.current = `${accountPick ?? ""}|${proposalPick ?? ""}`;
        syncUrl(accountPick, proposalPick);
        await fetchCounter();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load wallet");
      } finally {
        skipUrlSync.current = false;
        setInitialLoading(false);
      }
    },
    [loadAccounts, loadProposals, fetchCounter, syncUrl]
  );

  useEffect(() => {
    const key = `${accountFromUrl ?? ""}|${proposalFromUrl ?? ""}`;
    if (hydratedQueryKey.current === key) return;
    void hydrateFromServer({
      preferredAccount: accountFromUrl,
      preferredProposal: proposalFromUrl,
    });
  }, [accountFromUrl, proposalFromUrl, hydrateFromServer]);

  useEffect(() => {
    if (!selectedProposalId) {
      setProposalDetail(null);
      return;
    }
    loadProposalDetail(selectedProposalId).catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load proposal detail")
    );
  }, [selectedProposalId, loadProposalDetail]);

  useEffect(() => {
    if (skipUrlSync.current || initialLoading) return;
    syncUrl(selectedAddress, selectedProposalId);
  }, [selectedAddress, selectedProposalId, initialLoading, syncUrl]);

  const createCounterProposal = async () => {
    if (!selectedAddress) return;
    setBusy("create");
    setError(null);
    try {
      const { proposal } = await createCounterIncrementProposal(selectedAddress);
      const proposalPick = await loadProposals(selectedAddress, proposal.id);
      setSelectedProposalId(proposalPick);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create proposal failed");
    } finally {
      setBusy(null);
    }
  };

  const handleSendProposalCreated = async (proposalId: string) => {
    if (!selectedAddress) return;
    setError(null);
    const proposalPick = await loadProposals(selectedAddress, proposalId);
    setSelectedProposalId(proposalPick);
  };

  const approvePasskey = async (memberId: string, credentialId: string) => {
    if (!proposalDetail) return;
    setBusy(`approve-${memberId}`);
    setError(null);
    try {
      await approveProposalWithPasskey({
        proposalId: proposalDetail.proposal.id,
        memberId,
        credentialId,
        authDigestHex: proposalDetail.proposal.authDigestHex,
      });
      await loadProposalDetail(proposalDetail.proposal.id);
      if (selectedAddress) await loadProposals(selectedAddress);
    } catch (e) {
      if (isApiRefreshError(e)) {
        await handleProposalRefreshed(e.message);
      } else {
        setError(e instanceof Error ? e.message : "Passkey approval failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const approveDelegated = async (memberId: string) => {
    if (!proposalDetail) return;
    setBusy(`delegated-${memberId}`);
    setError(null);
    try {
      await connectFreighter();
      await approveProposalWithFreighter({
        proposalId: proposalDetail.proposal.id,
        memberId,
      });
      await loadProposalDetail(proposalDetail.proposal.id);
      if (selectedAddress) await loadProposals(selectedAddress);
    } catch (e) {
      if (isApiRefreshError(e)) {
        await handleProposalRefreshed(e.message);
      } else {
        setError(e instanceof Error ? e.message : "Delegated approval failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const executeProposal = async () => {
    if (!proposalDetail) return;
    setBusy("execute");
    setError(null);
    try {
      const { hash } = await executeMultisigProposal(proposalDetail.proposal.id);
      setLastTxHash(hash);
      await loadProposalDetail(proposalDetail.proposal.id);
      if (selectedAddress) await loadProposals(selectedAddress);
      await fetchCounter();
      if (proposalDetail.proposal.operationKind === "sac_transfer") {
        setBalanceRefreshNonce((n) => n + 1);
      }
    } catch (e) {
      if (isApiRefreshError(e)) {
        await handleProposalRefreshed(e.message);
      } else {
        setError(e instanceof Error ? e.message : "Execute failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const approvalCount = proposalDetail?.approvals.length ?? 0;
  const canExecute =
    proposalDetail?.proposal.status === "pending" &&
    approvalCount >= (proposalDetail?.multisigAccount.threshold ?? threshold);

  const handleProposalRefreshed = async (message: string) => {
    setError(message);
    if (selectedProposalId) {
      await loadProposalDetail(selectedProposalId);
    }
    if (selectedAddress) {
      await loadProposals(selectedAddress, selectedProposalId);
    }
  };

  const isApiRefreshError = (e: unknown): e is MultisigApiError =>
    e instanceof MultisigApiError && e.code === PROPOSAL_REFRESHED_CODE;

  if (initialLoading && accounts.length === 0) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="rounded-2xl border border-border p-8 text-center space-y-4">
        <p className="text-sm text-muted-foreground">
          No deployed team wallets yet. Create and deploy a multisig first.
        </p>
        <Link
          href="/multisig"
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 font-mono text-sm text-primary-foreground"
        >
          Create multisig
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-mono text-muted-foreground">
          Demo counter: {counterValue ?? "—"}
        </p>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            hydrateFromServer({
              preferredAccount: selectedAddress,
              preferredProposal: selectedProposalId,
            })
          }
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-mono hover:bg-muted/50 disabled:opacity-50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-4">
          <label className="text-xs font-mono uppercase text-muted-foreground">Team wallet</label>
          <select
            className="w-full h-11 rounded-lg border border-border px-3 font-mono text-sm bg-background"
            value={selectedAddress ?? ""}
            onChange={(e) => {
              const next = e.target.value;
              setSelectedAddress(next);
              setSelectedProposalId(null);
              setProposalDetail(null);
              void loadProposals(next).then((id) => setSelectedProposalId(id));
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.smartAccountAddress}>
                {a.smartAccountAddress.slice(0, 8)}… · {a.threshold}-of-{a.members.length}
              </option>
            ))}
          </select>

          {selectedAccount ? (
            <div className="rounded-xl border border-border p-4 space-y-3">
              <code className="text-xs font-mono break-all block">
                {selectedAccount.smartAccountAddress}
              </code>
              <p className="text-xs text-muted-foreground">
                {selectedAccount.threshold} approval(s) required · {selectedAccount.members.length}{" "}
                signers
              </p>
              <ul className="text-xs font-mono space-y-1">
                {selectedAccount.members.map((m) => (
                  <li key={m.id} className="text-muted-foreground">
                    {m.label ?? m.memberType} · {m.memberType}
                    {m.memberType === "delegated" && m.gAddress
                      ? ` · ${m.gAddress.slice(0, 8)}…`
                      : null}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                Only the wallet creator can use this playground. Other signers need the same APIs
                from their own session or the extension.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="text-xs font-mono uppercase text-muted-foreground">New proposal</div>
            <div className="flex rounded-lg border border-border p-0.5 font-mono text-xs">
              <button
                type="button"
                onClick={() => setProposalCreateMode("send")}
                className={`flex-1 rounded-md py-2 transition-colors ${
                  proposalCreateMode === "send"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Send tokens
              </button>
              <button
                type="button"
                onClick={() => setProposalCreateMode("demo")}
                className={`flex-1 rounded-md py-2 transition-colors ${
                  proposalCreateMode === "demo"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Demo counter
              </button>
            </div>
          </div>

          {proposalCreateMode === "send" && selectedAddress ? (
            <MultisigSendProposalForm
              smartAccountAddress={selectedAddress}
              disabled={busy !== null}
              balanceRefreshNonce={balanceRefreshNonce}
              onProposalCreated={handleSendProposalCreated}
              onError={(msg) => setError(msg)}
            />
          ) : (
            <button
              type="button"
              disabled={!selectedAddress || busy !== null}
              onClick={createCounterProposal}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary h-11 font-mono text-sm text-primary-foreground disabled:opacity-50"
            >
              {busy === "create" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              New proposal · increment counter
            </button>
          )}
        </div>

        <div className="space-y-3">
          <div className="text-xs font-mono uppercase text-muted-foreground">Proposals</div>
          {proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground font-mono">
              No proposals yet. Create one to test M-of-N signing.
            </p>
          ) : (
            <ul className="space-y-2 max-h-48 overflow-y-auto">
              {proposals.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedProposalId(p.id);
                      skipUrlSync.current = true;
                      hydratedQueryKey.current = `${selectedAddress ?? ""}|${p.id}`;
                      syncUrl(selectedAddress, p.id);
                      skipUrlSync.current = false;
                    }}
                    className={`w-full text-left rounded-xl border p-3 font-mono text-xs transition-colors ${
                      selectedProposalId === p.id
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted/30"
                    }`}
                  >
                    <span className="text-foreground">
                      {formatProposalTitle(p.operationKind, p.operationParams)}
                    </span>
                    <span className="text-muted-foreground ml-2">· {p.status}</span>
                    <span className="block text-muted-foreground mt-1">
                      {p.approvalCount}/{threshold} approvals
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {proposalDetail ? (
            <div className="rounded-xl border border-border p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono uppercase text-muted-foreground">
                  Selected proposal
                </span>
                <span
                  className={`text-xs font-mono px-2 py-0.5 rounded-full ${
                    proposalDetail.proposal.status === "executed"
                      ? "bg-emerald-500/10 text-emerald-600"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {proposalDetail.proposal.status}
                </span>
              </div>

              <p className="text-xs font-mono text-muted-foreground">
                Approvals: {approvalCount} / {proposalDetail.multisigAccount.threshold}
              </p>

              {proposalDetail.proposal.operationKind === "sac_transfer" &&
              proposalDetail.proposal.operationParams ? (
                <dl className="space-y-1 text-xs font-mono">
                  {formatSacTransferDetail(proposalDetail.proposal.operationParams).map((row) => (
                    <div key={row.label} className="flex gap-2">
                      <dt className="text-muted-foreground shrink-0">{row.label}:</dt>
                      <dd className="text-foreground break-all">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {proposalDetail.proposal.validUntilLedger ? (
                <p className="text-[11px] font-mono text-muted-foreground">
                  Auth valid until ledger {proposalDetail.proposal.validUntilLedger} (re-approve if
                  execute says expired)
                </p>
              ) : null}

              {proposalDetail.proposal.status === "pending" ? (
                <div className="space-y-2">
                  {myWebauthnMembers.map((m) => {
                    const already = proposalDetail.approvals.some((a) => a.memberId === m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        disabled={busy !== null || already}
                        onClick={() => approvePasskey(m.id, m.credentialId!)}
                        className="w-full flex items-center gap-3 p-3 rounded-lg border border-border text-left disabled:opacity-50"
                      >
                        <Fingerprint className="w-4 h-4 text-emerald-500 shrink-0" />
                        <span className="font-mono text-xs">
                          {already ? "Approved · " : "Approve · "}
                          {m.label ?? "Passkey signer"}
                        </span>
                      </button>
                    );
                  })}

                  {myWebauthnMembers.length === 0 ? (
                    <p className="text-xs text-amber-600 font-mono">
                      No passkey on this browser matches a team signer. Register/login with the
                      passkey you added during multisig setup, or approve as delegated below.
                    </p>
                  ) : null}

                  {selectedAccount?.members
                    .filter((m) => m.memberType === "delegated" && m.gAddress)
                    .map((m) => {
                      const already = proposalDetail.approvals.some((a) => a.memberId === m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={busy !== null || already}
                          onClick={() => approveDelegated(m.id)}
                          className="w-full flex items-center gap-3 p-3 rounded-lg border border-border text-left disabled:opacity-50"
                        >
                          <Wallet className="w-4 h-4 text-blue-500 shrink-0" />
                          <span className="font-mono text-xs">
                            {already ? "Approved · " : "Approve · Freighter · "}
                            {m.label ?? m.gAddress?.slice(0, 8)}
                          </span>
                        </button>
                      );
                    })}
                </div>
              ) : null}

              {canExecute ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={executeProposal}
                  className="w-full h-11 rounded-xl bg-emerald-600 text-white font-mono text-sm disabled:opacity-50"
                >
                  {busy === "execute" ? (
                    <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                  ) : (
                    "Execute on-chain"
                  )}
                </button>
              ) : null}

              {lastTxHash || proposalDetail.proposal.executedTxHash ? (
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${proposalDetail.proposal.executedTxHash ?? lastTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-mono text-primary"
                >
                  View tx <ExternalLink className="w-3 h-3" />
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive flex gap-2 font-mono">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
