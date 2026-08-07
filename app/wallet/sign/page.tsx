"use client";

import { useEffect, useState } from "react";

export default function WalletSignLauncherPage() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setMessage(
      "This launcher is deprecated. Open /dev/sign-demo, connect your wallet, and use " +
        "“Sign with Latch” — it calls window.latch.openSignRequest() instead of redirecting " +
        "to chrome-extension:// (which Chrome blocks from web pages)."
    );
  }, []);

  return (
    <main className="mx-auto max-w-lg p-8 space-y-4">
      <h1 className="text-2xl font-semibold">Latch Wallet</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <a href="/dev/sign-demo" className="text-sm underline">
        Go to sign demo
      </a>
    </main>
  );
}
