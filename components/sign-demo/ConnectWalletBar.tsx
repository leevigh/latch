"use client";

import { useLatchWallet } from "@/lib/sign-demo/useLatchWallet";

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ConnectWalletBar() {
  const { status, publicKey, network, error, connect, disconnect, refreshAccount } =
    useLatchWallet();

  return (
    <div className="rounded-2xl border border-border bg-background/80 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3 shadow-sm">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Latch Wallet
        </span>

        {status === "no_extension" && (
          <span className="text-xs text-muted-foreground max-w-md">
            Extension not detected — rebuild/reload unpacked latch-web-extension, then hard-refresh
            this page
          </span>
        )}

        {status === "disconnected" && (
          <button
            type="button"
            onClick={() => void connect()}
            className="rounded-xl bg-primary px-3 py-1.5 text-sm font-mono font-medium text-primary-foreground"
          >
            Connect Wallet
          </button>
        )}

        {status === "connecting" && (
          <span className="text-sm text-muted-foreground">
            Connecting… approve in the Latch popup if prompted
          </span>
        )}

        {status === "connected" && publicKey && (
          <span className="text-sm font-mono">
            {truncateAddress(publicKey)}
            {network && (
              <span className="ml-2 text-xs text-muted-foreground">· {network}</span>
            )}
          </span>
        )}

        {status === "error" && (
          <span className="text-sm text-destructive">{error ?? "Connection failed"}</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {status === "error" && (
          <button
            type="button"
            onClick={() => void connect()}
            className="text-sm underline text-muted-foreground"
          >
            Retry
          </button>
        )}

        {status === "connected" && (
          <>
            <button
              type="button"
              onClick={() => void refreshAccount()}
              className="text-sm underline text-muted-foreground"
              title="Re-read the active account from the Latch extension"
            >
              Sync account
            </button>
            <button
              type="button"
              onClick={disconnect}
              className="text-sm underline text-muted-foreground"
            >
              Disconnect
            </button>
          </>
        )}
      </div>
    </div>
  );
}
