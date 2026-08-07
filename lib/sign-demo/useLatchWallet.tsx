"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WalletConnectionState } from "./types";
import {
  connectLatchWallet,
  isLatchInjected,
  probeLatchExtension,
  LatchWalletError,
} from "./latchWallet";

const DEFAULT_STORAGE_KEY = "latch.signDemo.walletSession";

type LatchWalletContextValue = WalletConnectionState & {
  connect: () => Promise<{ publicKey: string; network: WalletConnectionState["network"] } | undefined>;
  disconnect: () => void;
  refreshProbe: () => Promise<void>;
  /** Re-read active account from the extension; updates UI when it changed. */
  refreshAccount: () => Promise<{ publicKey: string; network: WalletConnectionState["network"] } | null>;
};

const LatchWalletContext = createContext<LatchWalletContextValue | null>(null);

function useLatchWalletState(storageKey: string): LatchWalletContextValue {
  const [state, setState] = useState<WalletConnectionState>({
    status: "disconnected",
    publicKey: null,
    network: null,
    origin: typeof window !== "undefined" ? window.location.origin : "",
    error: null,
    connectedAt: null,
  });
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { publicKey: string; network: string };
      setState((s) => ({
        ...s,
        publicKey: saved.publicKey,
        network: saved.network as WalletConnectionState["network"],
        status: "disconnected",
      }));
    } catch {
      // ignore
    }
  }, [storageKey]);

  const refreshProbe = useCallback(async () => {
    const probe = await probeLatchExtension();
    if (probe === "missing") {
      setState((s) => ({ ...s, status: "no_extension", error: null }));
    }
  }, []);

  useEffect(() => {
    void refreshProbe();
  }, [refreshProbe]);

  useEffect(() => {
    if (state.status !== "no_extension") return;
    const id = setInterval(() => {
      void refreshProbe();
    }, 2000);
    return () => clearInterval(id);
  }, [state.status, refreshProbe]);

  const applyConnected = useCallback(
    (publicKey: string, network: WalletConnectionState["network"]) => {
      const connectedAt = new Date().toISOString();
      localStorage.setItem(
        storageKeyRef.current,
        JSON.stringify({ publicKey, network })
      );
      setState({
        status: "connected",
        publicKey,
        network,
        origin: window.location.origin,
        error: null,
        connectedAt,
      });
    },
    []
  );

  const refreshAccount = useCallback(async () => {
    if (!isLatchInjected()) return null;
    if (statusRef.current !== "connected" && statusRef.current !== "connecting") {
      return null;
    }
    try {
      const { publicKey, network } = await connectLatchWallet();
      setState((prev) => {
        if (prev.publicKey === publicKey && prev.network === network && prev.status === "connected") {
          return prev;
        }
        localStorage.setItem(
          storageKeyRef.current,
          JSON.stringify({ publicKey, network })
        );
        return {
          status: "connected",
          publicKey,
          network,
          origin: typeof window !== "undefined" ? window.location.origin : prev.origin,
          error: null,
          connectedAt: prev.connectedAt ?? new Date().toISOString(),
        };
      });
      return { publicKey, network };
    } catch {
      return null;
    }
  }, []);

  const connect = useCallback(async () => {
    if (!isLatchInjected()) {
      setState((s) => ({
        ...s,
        status: "no_extension",
        error: "Latch extension not detected",
      }));
      return;
    }
    setState((s) => ({ ...s, status: "connecting", error: null }));
    try {
      const { publicKey, network } = await connectLatchWallet();
      applyConnected(publicKey, network);
      return { publicKey, network };
    } catch (e) {
      const message =
        e instanceof LatchWalletError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setState((s) => ({
        ...s,
        status: "error",
        error: message,
      }));
      throw e;
    }
  }, [applyConnected]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(storageKeyRef.current);
    setState({
      status: isLatchInjected() ? "disconnected" : "no_extension",
      publicKey: null,
      network: null,
      origin: window.location.origin,
      error: null,
      connectedAt: null,
    });
  }, []);

  // Provider accountChanged / networkChanged (requires rebuilt extension inpage)
  useEffect(() => {
    const latch = typeof window !== "undefined" ? window.latch : undefined;
    if (!latch?.on) return;

    const onAccount = (payload: {
      publicKey: string;
      network: WalletConnectionState["network"];
    }) => {
      if (statusRef.current !== "connected" && statusRef.current !== "connecting") return;
      applyConnected(payload.publicKey, payload.network);
    };

    latch.on("accountChanged", onAccount);
    latch.on("networkChanged", onAccount);
    return () => {
      latch.off?.("accountChanged", onAccount);
      latch.off?.("networkChanged", onAccount);
    };
  }, [applyConnected]);

  // Popup account switches do not blur the dApp tab — poll while connected.
  useEffect(() => {
    if (state.status !== "connected") return;
    const id = window.setInterval(() => {
      void refreshAccount();
    }, 2000);
    return () => window.clearInterval(id);
  }, [state.status, refreshAccount]);

  // Focus / visibility safety net
  useEffect(() => {
    if (state.status !== "connected") return;
    const onFocus = () => {
      void refreshAccount();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [state.status, refreshAccount]);

  return { ...state, connect, disconnect, refreshProbe, refreshAccount };
}

export function LatchWalletProvider({
  children,
  storageKey = DEFAULT_STORAGE_KEY,
}: {
  children: ReactNode;
  /** Isolate session persistence per dapp (default: sign-demo key). */
  storageKey?: string;
}) {
  const value = useLatchWalletState(storageKey);
  return (
    <LatchWalletContext.Provider value={value}>{children}</LatchWalletContext.Provider>
  );
}

export function useLatchWallet(): LatchWalletContextValue {
  const ctx = useContext(LatchWalletContext);
  if (!ctx) {
    throw new Error("useLatchWallet must be used within LatchWalletProvider");
  }
  return ctx;
}
