"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OnRampPanel } from "@/components/on-ramp/OnRampPanel";
import { PoolBalancePanel } from "@/components/on-ramp/PoolBalancePanel";
import { fetchOnRampIntent, fetchPoolSnapshot } from "@/lib/on-ramp/api";
import { useMoonPayOnRamp } from "@/lib/on-ramp/useMoonPayOnRamp";
import type { OnRampIntentResponse, PoolSnapshotResponse } from "@/lib/on-ramp/types";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded border p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function DevOnRampPage() {
  const [destinationCAddress, setDestinationCAddress] = useState("");
  const [fiatAmount, setFiatAmount] = useState("25");
  const [intent, setIntent] = useState<OnRampIntentResponse | null>(null);
  const [poolSnapshot, setPoolSnapshot] = useState<PoolSnapshotResponse | null>(
    null
  );
  const [poolError, setPoolError] = useState<string | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);

  const connectRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);

  const { startOnRamp, phase, error, session, reset } = useMoonPayOnRamp();
  const loading = phase !== "idle" && phase !== "done" && phase !== "error";

  const refreshPool = useCallback(async (memoFilter?: string) => {
    setPoolLoading(true);
    setPoolError(null);
    try {
      const snapshot = await fetchPoolSnapshot(memoFilter);
      setPoolSnapshot(snapshot);
    } catch (e) {
      setPoolError(e instanceof Error ? e.message : String(e));
    } finally {
      setPoolLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPool();
  }, [refreshPool]);

  useEffect(() => {
    if (!session?.intentId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await fetchOnRampIntent(session.intentId);
        if (!cancelled) setIntent(next);
      } catch {
        // ignore transient poll errors
      }
    };

    void poll();
    const id = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [session?.intentId]);

  useEffect(() => {
    if (!session?.memoId) return;
    if (phase === "done" || phase === "widget") {
      void refreshPool(session.memoId);
    }
  }, [phase, refreshPool, session?.memoId]);

  const handleAddFunds = async () => {
    if (!connectRef.current || !widgetRef.current) return;
    await startOnRamp({
      destinationCAddress: destinationCAddress.trim(),
      fiatAmount: fiatAmount.trim(),
      fiatCode: "USD",
      connectContainer: connectRef.current,
      widgetContainer: widgetRef.current,
    });
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Stellar on-ramp (dev)</h1>
        <p className="text-sm text-muted-foreground">
          MoonPay test-mode purchase of XLM into the Latch pool G-address. Uses
          Platform API when enabled on your account; otherwise falls back to the
          standard MoonPay buy widget with a signed URL.
        </p>
      </div>

      <Section title="On-ramp">
        <OnRampPanel
          destinationCAddress={destinationCAddress}
          onDestinationChange={setDestinationCAddress}
          fiatAmount={fiatAmount}
          onFiatAmountChange={setFiatAmount}
          memoId={session?.memoId ?? intent?.memoId ?? null}
          intent={intent}
          phase={phase}
          error={error}
          onAddFunds={handleAddFunds}
          loading={loading}
        />
        {phase === "done" ? (
          <button
            type="button"
            className="text-sm underline"
            onClick={reset}
          >
            Start another on-ramp
          </button>
        ) : null}
      </Section>

      <Section title="MoonPay frames">
        <p className="text-xs text-muted-foreground">
          Connect and widget iframes render below when the flow requires them.
        </p>
        <div
          ref={connectRef}
          id="moonpay-connect"
          className="min-h-[120px] w-full rounded border border-dashed"
        />
        <div
          ref={widgetRef}
          id="moonpay-widget"
          className="min-h-[480px] w-full rounded border border-dashed"
        />
      </Section>

      <Section title="Pool verification">
        <PoolBalancePanel
          snapshot={poolSnapshot}
          loading={poolLoading}
          error={poolError}
          onRefresh={() => refreshPool(session?.memoId ?? intent?.memoId)}
        />
      </Section>
    </main>
  );
}
