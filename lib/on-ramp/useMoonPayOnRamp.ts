"use client";

import { useCallback, useState } from "react";
import {
  createClient,
  type ConnectEvent,
  type WidgetEvent,
} from "@moonpay/platform-sdk-web";
import {
  createOnRampSession,
  updateOnRampIntent,
  type CreateOnRampSessionResponse,
} from "@/lib/on-ramp/api";

function moonPayTransactionId(event: WidgetEvent): string | null {
  if (event.kind === "complete") {
    return event.payload.transaction.id;
  }
  if (event.kind === "transactionCreated") {
    const payload = event.payload as { transaction?: { id?: string } };
    return payload.transaction?.id ?? null;
  }
  return null;
}

function mountWidgetIframe(container: HTMLElement, widgetUrl: string) {
  container.replaceChildren();
  const iframe = document.createElement("iframe");
  iframe.src = widgetUrl;
  iframe.title = "MoonPay on-ramp";
  iframe.className = "h-[600px] w-full border-0";
  iframe.setAttribute("allow", "payment *; clipboard-write");
  container.appendChild(iframe);
}

export type OnRampFlowPhase =
  | "idle"
  | "creating_session"
  | "connecting"
  | "quoting"
  | "widget"
  | "done"
  | "error";

export function useMoonPayOnRamp() {
  const [phase, setPhase] = useState<OnRampFlowPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<CreateOnRampSessionResponse | null>(
    null
  );

  const startOnRamp = useCallback(
    async (params: {
      destinationCAddress: string;
      fiatAmount: string;
      fiatCode: string;
      connectContainer: HTMLElement;
      widgetContainer: HTMLElement;
    }) => {
      setPhase("creating_session");
      setError(null);
      let intentId: string | null = null;

      try {
        const sess = await createOnRampSession({
          destinationCAddress: params.destinationCAddress,
          fiatAmount: params.fiatAmount,
          fiatCode: params.fiatCode,
        });
        intentId = sess.intentId;
        setSession(sess);

        if (sess.integrationMode === "widget") {
          if (!sess.widgetUrl) {
            throw new Error("Server did not return a widget URL.");
          }
          await updateOnRampIntent(sess.intentId, { status: "pending" });
          setPhase("widget");
          mountWidgetIframe(params.widgetContainer, sess.widgetUrl);
          return;
        }

        if (!sess.sessionToken) {
          throw new Error("Server did not return a Platform session token.");
        }

        const client = createClient({ sessionToken: sess.sessionToken });

        setPhase("connecting");
        const connectionResult = await client.getConnection();
        if (!connectionResult.ok) {
          throw new Error(connectionResult.error.message);
        }

        if (connectionResult.value.status === "connectionRequired") {
          const connectResult = await client.connect({
            container: params.connectContainer,
            onEvent: (event: ConnectEvent) => {
              if (event.kind === "error") {
                const msg =
                  "message" in event.payload
                    ? event.payload.message
                    : event.payload.code;
                setError(msg ?? "Connect flow failed.");
              }
            },
          });
          if (!connectResult.ok) {
            throw new Error(connectResult.error.message);
          }
          connectResult.value.dispose();
        }

        setPhase("quoting");
        const quoteResult = await client.getQuote({
          source: {
            asset: { code: sess.fiatCode },
            amount: sess.fiatAmount,
          },
          destination: {
            asset: { code: "XLM" },
          },
          wallet: {
            address: sess.poolAddress,
            tag: sess.memoId,
          },
          paymentMethod: {
            type: "card",
          },
        });

        if (!quoteResult.ok) {
          throw new Error(quoteResult.error.message);
        }

        if (!quoteResult.value.data.executable) {
          throw new Error(
            "Quote is not executable. Verify MoonPay test keys, XLM support, and pool wallet."
          );
        }

        await updateOnRampIntent(sess.intentId, { status: "pending" });

        setPhase("widget");
        const widgetResult = await client.setupWidget({
          quote: quoteResult.value.data.signature,
          container: params.widgetContainer,
          onEvent: async (event: WidgetEvent) => {
            if (
              event.kind === "transactionCreated" ||
              event.kind === "complete"
            ) {
              const txId = moonPayTransactionId(event);
              if (txId) {
                await updateOnRampIntent(sess.intentId, {
                  moonpayTransactionId: txId,
                  status: event.kind === "complete" ? "completed" : "pending",
                });
              }
            }
            if (event.kind === "error") {
              await updateOnRampIntent(sess.intentId, { status: "failed" });
              setError(event.payload.message ?? event.payload.code);
              setPhase("error");
            }
            if (event.kind === "complete") {
              setPhase("done");
            }
          },
        });

        if (!widgetResult.ok) {
          throw new Error(widgetResult.error.message);
        }

        widgetResult.value.dispose();
        setPhase("done");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setPhase("error");
        if (intentId) {
          await updateOnRampIntent(intentId, { status: "failed" }).catch(
            () => undefined
          );
        }
      }
    },
    []
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setSession(null);
  }, []);

  return { startOnRamp, reset, phase, error, session };
}
