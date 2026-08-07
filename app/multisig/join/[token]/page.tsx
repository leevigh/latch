"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { connectFreighter } from "@/lib/wallets";
import {
  multisigJoinAuthenticatePasskey,
  multisigJoinRegisterPasskey,
} from "@/lib/multisig-passkey-ceremony";
import { SIGNER_KIND_META, type MultisigSignerKind } from "@/lib/multisig-signers";
import {
  AlertTriangle,
  CheckCircle,
  Fingerprint,
  Loader2,
  UserPlus,
  Wallet,
} from "lucide-react";

type JoinInfo = {
  draft: {
    memberCount: number;
    validMemberCount: number;
    threshold: number;
    members: { label: string; fingerprint: string | null; memberType: string }[];
  };
};

export default function MultisigJoinPage() {
  const params = useParams();
  const token = typeof params.token === "string" ? params.token : "";
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<MultisigSignerKind>("webauthn");
  const [gAddress, setGAddress] = useState("");
  const [keyDataHex, setKeyDataHex] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [insecureLanHttp, setInsecureLanHttp] = useState(false);

  useEffect(() => {
    const host = window.location.hostname;
    const lan =
      /^192\.168\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    setInsecureLanHttp(!window.isSecureContext && lan && window.location.protocol === "http:");
  }, []);

  const loadInfo = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/multisig/join/${token}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Invite not found");
      setInfo(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load invite");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) loadInfo();
  }, [token, loadInfo]);

  const submitMember = async () => {
    setError(null);
    setBusy("submit");
    try {
      const res = await fetch(`/api/multisig/join/${token}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          label: name.trim(),
          memberType: kind,
          gAddress: kind === "delegated" ? gAddress : undefined,
          keyDataHex: kind === "webauthn" ? keyDataHex : undefined,
          credentialId: kind === "webauthn" ? credentialId : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to join");
      setDone(true);
      await loadInfo();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to join");
    } finally {
      setBusy(null);
    }
  };

  const registerPasskey = async () => {
    setBusy("register");
    setError(null);
    try {
      const material = await multisigJoinRegisterPasskey({
        inviteToken: token,
        displayName: name.trim() || "multisig-member",
      });
      setKeyDataHex(material.keyDataHex);
      setCredentialId(material.credentialId);
      setKind("webauthn");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Passkey registration failed");
    } finally {
      setBusy(null);
    }
  };

  const useExistingPasskey = async () => {
    setBusy("auth");
    setError(null);
    try {
      const material = await multisigJoinAuthenticatePasskey({ inviteToken: token });
      setKeyDataHex(material.keyDataHex);
      setCredentialId(material.credentialId);
      setKind("webauthn");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Passkey verification failed");
    } finally {
      setBusy(null);
    }
  };

  const connectFreighterWallet = async () => {
    setBusy("freighter");
    try {
      const w = await connectFreighter();
      setGAddress(w.gAddress);
      setKind("delegated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Freighter failed");
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen pt-28 pb-16 container flex justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!info && error) {
    return (
      <main className="min-h-screen pt-28 pb-16 container max-w-lg mx-auto">
        <p className="text-destructive font-mono text-sm">{error}</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen pt-28 pb-16 container">
      <div className="max-w-lg mx-auto space-y-6">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase text-primary">
            <UserPlus className="w-3.5 h-3.5" />
            Join team wallet
          </div>
          <h1 className="text-2xl font-mono font-semibold">Add your signer</h1>
          <p className="text-sm text-muted-foreground">
            Run WebAuthn on <strong>this device</strong>. Your private key never leaves the
            authenticator.
          </p>
          {insecureLanHttp ? (
            <p className="text-xs font-mono text-amber-600 dark:text-amber-400">
              This page is on plain HTTP over a LAN IP. Browsers block passkeys here — use{" "}
              <code className="text-[11px]">npm run dev:https</code> on the dev machine and open the
              HTTPS Network URL on this device.
            </p>
          ) : null}
        </div>

        {info ? (
          <p className="text-xs font-mono text-muted-foreground">
            {info.draft.validMemberCount} of {info.draft.memberCount} members ready · threshold{" "}
            {info.draft.threshold}
          </p>
        ) : null}

        {done ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-2">
            <CheckCircle className="w-6 h-6 text-emerald-600" />
            <p className="font-mono text-sm">You&apos;re on the team draft. The creator can deploy when ready.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border p-6 space-y-5">
            <input
              className="w-full h-11 rounded-lg border border-border px-3 font-mono text-sm"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            <div className="grid grid-cols-2 gap-2">
              {(["webauthn", "delegated"] as MultisigSignerKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`p-3 rounded-xl border text-left font-mono text-xs ${
                    kind === k ? "border-primary bg-primary/10" : "border-border"
                  }`}
                >
                  {SIGNER_KIND_META[k].label}
                </button>
              ))}
            </div>

            {kind === "webauthn" ? (
              <div className="grid gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={useExistingPasskey}
                  className="flex items-center gap-3 p-4 rounded-xl border border-border text-left disabled:opacity-50"
                >
                  <Fingerprint className="w-5 h-5" />
                  <span className="font-mono text-sm">Use existing Latch passkey</span>
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={registerPasskey}
                  className="flex items-center gap-3 p-4 rounded-xl border border-border text-left disabled:opacity-50"
                >
                  <Fingerprint className="w-5 h-5 text-emerald-500" />
                  <span className="font-mono text-sm">Create new passkey</span>
                </button>
                {keyDataHex ? (
                  <p className="text-xs font-mono text-emerald-600">Passkey ready to submit</p>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={connectFreighterWallet}
                className="flex items-center gap-3 w-full p-4 rounded-xl border border-border text-left"
              >
                <Wallet className="w-5 h-5 text-blue-500" />
                <span className="font-mono text-sm">Connect Freighter</span>
              </button>
            )}

            {kind === "delegated" ? (
              <input
                className="w-full h-11 rounded-lg border border-border px-3 font-mono text-sm"
                placeholder="G-address"
                value={gAddress}
                onChange={(e) => setGAddress(e.target.value)}
              />
            ) : null}

            {error ? (
              <p className="text-sm text-destructive flex gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {error}
              </p>
            ) : null}

            <button
              type="button"
              disabled={busy !== null || !name.trim()}
              onClick={submitMember}
              className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-mono text-sm disabled:opacity-50"
            >
              {busy === "submit" ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Join as signer"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
