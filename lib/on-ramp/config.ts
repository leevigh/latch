import "server-only";
import { ApiRequestError } from "@/lib/api-errors";

export function moonPayApiBase(): string {
  return (process.env.MOONPAY_API_BASE ?? "https://api.moonpay.com").replace(/\/$/, "");
}

export function moonPaySecretKey(): string {
  const key = process.env.MOONPAY_SECRET_KEY?.trim();
  if (!key) {
    throw new ApiRequestError(
      "config_error",
      "MOONPAY_SECRET_KEY is not set.",
      500
    );
  }
  if (key.startsWith("pk_")) {
    throw new ApiRequestError(
      "config_error",
      "MOONPAY_SECRET_KEY must be your secret key (sk_test_... or sk_live_...), not the publishable key (pk_...). Copy the secret key from MoonPay Dashboard → Developers.",
      500
    );
  }
  if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_")) {
    throw new ApiRequestError(
      "config_error",
      "MOONPAY_SECRET_KEY must start with sk_test_ (sandbox) or sk_live_ (production).",
      500
    );
  }
  return key;
}

export function moonPayPublishableKey(): string {
  const key = process.env.MOONPAY_PUBLISHABLE_KEY?.trim();
  if (!key) {
    throw new ApiRequestError(
      "config_error",
      "MOONPAY_PUBLISHABLE_KEY is not set. Required for widget on-ramp (pk_test_... or pk_live_...).",
      500
    );
  }
  if (!key.startsWith("pk_test_") && !key.startsWith("pk_live_")) {
    throw new ApiRequestError(
      "config_error",
      "MOONPAY_PUBLISHABLE_KEY must start with pk_test_ or pk_live_.",
      500
    );
  }
  return key;
}

export type MoonPayIntegrationMode = "auto" | "platform" | "widget";

export function moonPayIntegrationMode(): MoonPayIntegrationMode {
  const mode = process.env.MOONPAY_INTEGRATION_MODE?.trim().toLowerCase();
  if (mode === "platform" || mode === "widget") return mode;
  return "auto";
}

export function widgetBuyBaseUrl(secretKey: string): string {
  const override = process.env.MOONPAY_WIDGET_BUY_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  return secretKey.startsWith("sk_test_")
    ? "https://buy-sandbox.moonpay.com"
    : "https://buy.moonpay.com";
}

export function poolGAddress(): string {
  const address = process.env.MOONPAY_POOL_G_ADDRESS?.trim();
  if (!address) {
    throw new ApiRequestError(
      "config_error",
      "MOONPAY_POOL_G_ADDRESS is not set.",
      500
    );
  }
  return address;
}

export function defaultFiatAmount(): string {
  return process.env.MOONPAY_DEFAULT_FIAT_AMOUNT?.trim() || "25";
}

export function defaultFiatCode(): string {
  return process.env.MOONPAY_DEFAULT_FIAT_CODE?.trim() || "USD";
}
