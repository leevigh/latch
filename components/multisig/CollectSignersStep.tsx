"use client";

import React, { useCallback, useMemo, useState } from "react";
import { connectFreighter, connectPhantom } from "@/lib/wallets";
import {
  multisigDraftAuthenticatePasskey,
  multisigDraftRegisterPasskey,
} from "@/lib/multisig-passkey-ceremony";
import {
  SIGNER_KIND_META,
  validateDraftMember,
  type DraftMultisigMember,
  type MultisigSignerKind,
} from "@/lib/multisig-signers";
import type { SerializedDraft } from "@/components/multisig/useServerMultisigDraft";
import {
  AlertTriangle,
  CheckCircle,
  Copy,
  Fingerprint,
  Link2,
  Loader2,
  Plus,
  Trash2,
  UserPlus,
  Wallet,
} from "lucide-react";

type Props = {
  draft: SerializedDraft;
  inviteUrl: string | null;
  onDraftUpdated: (draft: SerializedDraft) => void;
  threshold: number;
  onThresholdChange: (n: number) => void;
};

const EMPTY_FORM = {
  name: "",
  kind: "delegated" as MultisigSignerKind,
  gAddress: "",
  keyDataHex: "",
  credentialId: "",
  publicKeyHex: "",
};

function rowToDraftMember(row: SerializedDraft["members"][0]): DraftMultisigMember {
  return {
    id: row.id,
    name: row.label,
    kind: row.memberType as MultisigSignerKind,
    gAddress: row.gAddress ?? undefined,
    keyDataHex: row.keyDataHex ?? undefined,
    credentialId: row.credentialId ?? undefined,
    publicKeyHex: row.publicKeyHex ?? undefined,
  };
}

export function CollectSignersStep({
  draft,
  inviteUrl,
  onDraftUpdated,
  threshold,
  onThresholdChange,
}: Props) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);

  const members = useMemo(() => draft.members.map(rowToDraftMember), [draft.members]);

  const validMembers = useMemo(
    () => members.filter((m) => !validateDraftMember(m)),
    [members]
  );

  const resetForm = useCallback(() => {
    setForm(EMPTY_FORM);
    setFormError(null);
  }, []);

  const saveMemberToServer = useCallback(
    async (payload: {
      label: string;
      memberType: MultisigSignerKind;
      gAddress?: string;
      keyDataHex?: string;
      credentialId?: string;
      publicKeyHex?: string;
    }) => {
      const res = await fetch(`/api/multisig/drafts/${draft.id}/members`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add member");
      onDraftUpdated(data.draft);
    },
    [draft.id, onDraftUpdated]
  );

  const addMember = useCallback(
    async (partial: Omit<DraftMultisigMember, "id">) => {
      const member: DraftMultisigMember = { id: "pending", ...partial };
      const err = validateDraftMember(member);
      if (err) {
        setFormError(err);
        return false;
      }
      try {
        await saveMemberToServer({
          label: member.name,
          memberType: member.kind,
          gAddress: member.gAddress,
          keyDataHex: member.keyDataHex,
          credentialId: member.credentialId,
          publicKeyHex: member.publicKeyHex,
        });
        resetForm();
        setShowForm(false);
        return true;
      } catch (e) {
        setFormError(e instanceof Error ? e.message : "Failed to save member");
        return false;
      }
    },
    [resetForm, saveMemberToServer]
  );

  const removeMember = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/multisig/drafts/${draft.id}/members/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error ?? "Failed to remove member");
        return;
      }
      onDraftUpdated(data.draft);
    },
    [draft.id, onDraftUpdated]
  );

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    await addMember({
      name: form.name.trim(),
      kind: form.kind,
      gAddress: form.kind === "delegated" ? form.gAddress.trim() : undefined,
      keyDataHex: form.kind === "webauthn" ? form.keyDataHex.trim() : undefined,
      credentialId: form.kind === "webauthn" ? form.credentialId || undefined : undefined,
      publicKeyHex: form.kind === "ed25519" ? form.publicKeyHex.trim() : undefined,
    });
  };

  const connectFreighterSigner = async () => {
    setFormError(null);
    setBusy("freighter");
    try {
      const w = await connectFreighter();
      setForm((f) => ({ ...f, gAddress: w.gAddress, kind: "delegated" }));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Freighter connect failed");
    } finally {
      setBusy(null);
    }
  };

  const connectPhantomSigner = async () => {
    setFormError(null);
    setBusy("phantom");
    try {
      const w = await connectPhantom();
      setForm((f) => ({
        ...f,
        publicKeyHex: w.publicKeyHex,
        kind: "ed25519",
      }));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Phantom connect failed");
    } finally {
      setBusy(null);
    }
  };

  const collectPasskeyExisting = async () => {
    setFormError(null);
    setBusy("passkey_login");
    try {
      const material = await multisigDraftAuthenticatePasskey({ draftId: draft.id });
      setForm((f) => ({
        ...f,
        kind: "webauthn",
        keyDataHex: material.keyDataHex,
        credentialId: material.credentialId,
      }));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Passkey verification failed");
    } finally {
      setBusy(null);
    }
  };

  const collectPasskeyNew = async () => {
    setFormError(null);
    setBusy("passkey_register");
    try {
      const material = await multisigDraftRegisterPasskey({
        draftId: draft.id,
        displayName: form.name.trim() || "multisig-member",
      });
      setForm((f) => ({
        ...f,
        kind: "webauthn",
        keyDataHex: material.keyDataHex,
        credentialId: material.credentialId,
      }));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Passkey registration failed");
    } finally {
      setBusy(null);
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  const kindMeta = SIGNER_KIND_META[form.kind];
  const disabled = draft.status !== "collecting";

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-primary/15 bg-primary/5 p-4 sm:p-5 space-y-3">
        <p className="text-sm text-foreground/90 leading-relaxed">
          Add signers on this device, or share the invite link so each person runs WebAuthn on{" "}
          <strong>their own</strong> phone or laptop. Passkeys from the web playground cannot be
          reused in the Chrome extension (different RP ID).
        </p>
      </div>

      {inviteUrl && !disabled ? (
        <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
            <Link2 className="w-3.5 h-3.5" />
            Invite link (remote members)
          </div>
          <div className="flex gap-2">
            <input
              readOnly
              className="flex-1 h-10 rounded-lg border border-border bg-background px-3 font-mono text-xs"
              value={inviteUrl}
            />
            <button
              type="button"
              onClick={copyInvite}
              className="shrink-0 px-3 rounded-lg border border-border hover:bg-muted/50"
            >
              {copiedInvite ? (
                <CheckCircle className="w-4 h-4 text-emerald-600" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-mono text-muted-foreground uppercase tracking-wider">
          Approvals needed
        </label>
        <select
          className="h-10 rounded-lg border border-border bg-background px-3 font-mono text-sm"
          value={threshold}
          onChange={(e) => onThresholdChange(Number(e.target.value))}
          disabled={members.length < 2 || disabled}
        >
          {members.length < 2 ? (
            <option value={1}>Add at least 2 members first</option>
          ) : (
            Array.from({ length: members.length }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} of {members.length}
              </option>
            ))
          )}
        </select>
        {draft.validMemberCount >= 2 ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-mono">
            <CheckCircle className="w-3.5 h-3.5" />
            {draft.validMemberCount} valid members
          </span>
        ) : null}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-mono text-sm font-semibold uppercase tracking-wider">
            Members ({members.length})
          </h3>
          {!showForm && !disabled ? (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-mono hover:bg-muted/50 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add member (you)
            </button>
          ) : null}
        </div>

        {members.length === 0 && !showForm ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center space-y-3">
            <UserPlus className="w-8 h-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No members yet. Add yourself or share the invite link.
            </p>
            {!disabled ? (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-mono text-primary-foreground hover:bg-primary/90"
              >
                <Plus className="w-4 h-4" />
                Add yourself
              </button>
            ) : null}
          </div>
        ) : null}

        {draft.members.map((row) => {
          const m = rowToDraftMember(row);
          const err = row.validationError ?? validateDraftMember(m);
          const meta = SIGNER_KIND_META[m.kind];
          return (
            <div
              key={row.id}
              className={`rounded-xl border p-4 sm:p-5 flex gap-4 ${
                err ? "border-destructive/30 bg-destructive/5" : "border-border bg-background/80"
              }`}
            >
              <div
                className={`w-10 h-10 rounded-lg shrink-0 flex items-center justify-center font-mono font-bold text-sm ${
                  m.kind === "delegated"
                    ? "bg-blue-500/10 text-blue-500"
                    : m.kind === "webauthn"
                      ? "bg-emerald-500/10 text-emerald-500"
                      : "bg-indigo-500/10 text-indigo-500"
                }`}
              >
                {m.name.trim()[0]?.toUpperCase() ?? "?"}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium truncate">{m.name || "Unnamed"}</span>
                  <span className="text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                    {meta.short}
                  </span>
                  {row.source === "invite" ? (
                    <span className="text-[10px] uppercase font-mono text-primary">remote</span>
                  ) : null}
                </div>
                <p className="text-xs font-mono text-muted-foreground break-all">
                  {row.fingerprint ?? "—"}
                </p>
                {err ? (
                  <p className="text-xs text-destructive flex items-center gap-1 mt-1">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    {err}
                  </p>
                ) : null}
              </div>
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => removeMember(row.id)}
                  className="shrink-0 p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  aria-label={`Remove ${m.name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {showForm && !disabled ? (
        <form
          onSubmit={handleManualSubmit}
          className="rounded-xl border border-primary/20 bg-card/40 p-5 sm:p-6 space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-mono font-semibold">Add member (this device)</h3>
              <p className="text-xs text-muted-foreground mt-1">{kindMeta.hint}</p>
            </div>
            <button
              type="button"
              className="text-xs font-mono text-muted-foreground hover:text-foreground"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
            >
              Cancel
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Display name
            </label>
            <input
              required
              className="w-full h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm"
              placeholder="Alice"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Signer type
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(Object.keys(SIGNER_KIND_META) as MultisigSignerKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, kind }))}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    form.kind === kind
                      ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                      : "border-border hover:border-primary/40"
                  }`}
                >
                  <div className="font-mono text-sm font-medium">{SIGNER_KIND_META[kind].label}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {SIGNER_KIND_META[kind].short}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {form.kind === "delegated" ? (
            <div className="space-y-3">
              <button
                type="button"
                disabled={busy !== null}
                onClick={connectFreighterSigner}
                className="flex items-center gap-3 w-full p-4 rounded-xl border border-border hover:border-primary/40 text-left disabled:opacity-50"
              >
                <Wallet className="w-5 h-5 text-blue-500 shrink-0" />
                <span className="font-mono text-sm">Connect Freighter</span>
                {busy === "freighter" ? <Loader2 className="w-4 h-4 animate-spin ml-auto" /> : null}
              </button>
              <input
                className="w-full h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm"
                placeholder="GABC…XYZ"
                value={form.gAddress}
                onChange={(e) => setForm((f) => ({ ...f, gAddress: e.target.value }))}
              />
            </div>
          ) : null}

          {form.kind === "webauthn" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={collectPasskeyExisting}
                  className="flex items-center gap-3 p-4 rounded-xl border border-border hover:border-primary/40 text-left disabled:opacity-50"
                >
                  <Fingerprint className="w-5 h-5 text-primary shrink-0" />
                  <div>
                    <div className="font-mono text-sm font-medium">Use existing passkey</div>
                    <div className="text-xs text-muted-foreground">Latch passkey on this site</div>
                  </div>
                  {busy === "passkey_login" ? (
                    <Loader2 className="w-4 h-4 animate-spin ml-auto" />
                  ) : null}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={collectPasskeyNew}
                  className="flex items-center gap-3 p-4 rounded-xl border border-border hover:border-primary/40 text-left disabled:opacity-50"
                >
                  <Fingerprint className="w-5 h-5 text-emerald-500 shrink-0" />
                  <div>
                    <div className="font-mono text-sm font-medium">Create passkey</div>
                    <div className="text-xs text-muted-foreground">New key on this device</div>
                  </div>
                  {busy === "passkey_register" ? (
                    <Loader2 className="w-4 h-4 animate-spin ml-auto" />
                  ) : null}
                </button>
              </div>
              {form.keyDataHex ? (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs font-mono">
                  <CheckCircle className="w-3.5 h-3.5 inline mr-1 text-emerald-600" />
                  Credentials captured ({form.keyDataHex.length / 2} bytes)
                </div>
              ) : null}
            </div>
          ) : null}

          {form.kind === "ed25519" ? (
            <div className="space-y-3">
              <button
                type="button"
                disabled={busy !== null}
                onClick={connectPhantomSigner}
                className="flex items-center gap-3 w-full p-4 rounded-xl border border-border text-left disabled:opacity-50"
              >
                <Wallet className="w-5 h-5 text-indigo-500 shrink-0" />
                <span className="font-mono text-sm">Connect Phantom</span>
              </button>
              <input
                className="w-full h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm"
                value={form.publicKeyHex}
                onChange={(e) => setForm((f) => ({ ...f, publicKeyHex: e.target.value }))}
              />
              <p className="text-xs text-amber-600 font-mono">Ed25519 deploy not wired yet.</p>
            </div>
          ) : null}

          {formError ? (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
              {formError}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={busy !== null}
            className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-mono text-sm disabled:opacity-50"
          >
            Save member
          </button>
        </form>
      ) : null}
    </div>
  );
}
