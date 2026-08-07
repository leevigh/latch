"use client";

import { useState } from "react";

interface TruncatedXdrProps {
  xdr: string;
  label?: string;
  maxLen?: number;
}

export function TruncatedXdr({ xdr, label = "XDR", maxLen = 48 }: TruncatedXdrProps) {
  const [copied, setCopied] = useState(false);
  const truncated =
    xdr.length > maxLen ? `${xdr.slice(0, maxLen / 2)}…${xdr.slice(-maxLen / 2)}` : xdr;

  async function copy() {
    await navigator.clipboard.writeText(xdr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="text-xs underline text-muted-foreground hover:text-foreground"
        >
          {copied ? "Copied" : "Copy full"}
        </button>
      </div>
      <code className="block text-xs font-mono break-all bg-muted/50 rounded px-2 py-1">
        {truncated}
      </code>
    </div>
  );
}
