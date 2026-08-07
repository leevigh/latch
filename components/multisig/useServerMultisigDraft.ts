"use client";

import { useCallback, useEffect, useState } from "react";
export const MULTISIG_DRAFT_ID_STORAGE_KEY = "latch-multisig-draft-id";

export type SerializedDraftMember = {
  id: string;
  label: string;
  memberType: string;
  gAddress: string | null;
  keyDataHex: string | null;
  credentialId: string | null;
  publicKeyHex: string | null;
  source: string;
  valid: boolean;
  validationError: string | null;
  fingerprint: string | null;
};

export type SerializedDraft = {
  id: string;
  threshold: number;
  accountSaltHex: string;
  inviteToken: string;
  status: string;
  predictedAddress: string | null;
  smartAccountAddress: string | null;
  validMemberCount: number;
  canDeploy: boolean;
  members: SerializedDraftMember[];
};

export function useServerMultisigDraft() {
  const [draft, setDraft] = useState<SerializedDraft | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadDraft = useCallback(async (id?: string) => {
    setLoading(true);
    try {
      const storedId =
        id ?? (typeof window !== "undefined" ? localStorage.getItem(MULTISIG_DRAFT_ID_STORAGE_KEY) : null);
      const url = storedId
        ? `/api/multisig/drafts/${storedId}`
        : "/api/multisig/drafts?active=1";
      const res = await fetch(url, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load draft");
      if (storedId && res.status === 404) {
        localStorage.removeItem(MULTISIG_DRAFT_ID_STORAGE_KEY);
      }
      const d = data.draft as SerializedDraft | null;
      setDraft(d);
      setInviteUrl(data.inviteUrl ?? null);
      if (d?.id && typeof window !== "undefined") {
        localStorage.setItem(MULTISIG_DRAFT_ID_STORAGE_KEY, d.id);
      }
    } finally {
      setLoading(false);
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    loadDraft();
  }, [loadDraft]);

  const createDraft = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/multisig/drafts", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create draft");
      setDraft(data.draft);
      setInviteUrl(data.inviteUrl);
      if (typeof window !== "undefined") {
        localStorage.setItem(MULTISIG_DRAFT_ID_STORAGE_KEY, data.draft.id);
      }
      return data.draft as SerializedDraft;
    } finally {
      setLoading(false);
    }
  }, []);

  const setThreshold = useCallback(
    async (threshold: number) => {
      if (!draft) return;
      const res = await fetch(`/api/multisig/drafts/${draft.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update threshold");
      setDraft(data.draft);
      setInviteUrl(data.inviteUrl);
    },
    [draft]
  );

  const applyDraft = useCallback((d: SerializedDraft, url?: string | null) => {
    setDraft(d);
    if (url !== undefined) setInviteUrl(url);
    if (typeof window !== "undefined") {
      localStorage.setItem(MULTISIG_DRAFT_ID_STORAGE_KEY, d.id);
    }
  }, []);

  return {
    draft,
    inviteUrl,
    hydrated,
    loading,
    loadDraft,
    createDraft,
    setThreshold,
    applyDraft,
  };
}
