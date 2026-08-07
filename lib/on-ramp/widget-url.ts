import "server-only";
import * as crypto from "crypto";
import { ApiRequestError } from "@/lib/api-errors";
import {
  moonPayPublishableKey,
  moonPaySecretKey,
  widgetBuyBaseUrl,
} from "@/lib/on-ramp/config";

export function buildSignedWidgetBuyUrl(params: {
  poolAddress: string;
  memoId: string;
  fiatAmount: string;
  fiatCode: string;
  externalCustomerId: string;
  externalTransactionId: string;
}): string {
  const secretKey = moonPaySecretKey();
  const publishableKey = moonPayPublishableKey();
  const base = widgetBuyBaseUrl(secretKey);

  const search = new URLSearchParams();
  search.set("apiKey", publishableKey);
  search.set("currencyCode", "xlm");
  search.set("walletAddress", params.poolAddress);
  search.set("walletAddressTag", params.memoId);
  search.set("baseCurrencyCode", params.fiatCode.toLowerCase());
  search.set("baseCurrencyAmount", params.fiatAmount);
  search.set("externalCustomerId", params.externalCustomerId);
  search.set("externalTransactionId", params.externalTransactionId);
  search.set("showWalletAddressForm", "true");

  const query = `?${search.toString()}`;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(query)
    .digest("base64");

  search.set("signature", signature);
  return `${base}?${search.toString()}`;
}

export function platformNotEnabledError(): ApiRequestError {
  return new ApiRequestError(
    "moonpay_platform_unavailable",
    "MoonPay Platform API is not enabled for this account (POST /platform/v1/sessions returned 404). " +
      "Use MOONPAY_INTEGRATION_MODE=widget with MOONPAY_PUBLISHABLE_KEY, or ask MoonPay to enable the Developer Platform on your partner account.",
    502
  );
}
