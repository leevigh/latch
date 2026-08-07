import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { apiError, ApiRequestError } from "@/lib/api-errors";
import {
  defaultFiatAmount,
  defaultFiatCode,
  moonPayIntegrationMode,
  poolGAddress,
} from "@/lib/on-ramp/config";
import { devOnlyGuard } from "@/lib/on-ramp/dev-guard";
import { generateUniqueMemoId } from "@/lib/on-ramp/memo";
import { createMoonPaySession } from "@/lib/on-ramp/moonpay";
import { clientIp } from "@/lib/on-ramp/request-ip";
import { validateCAddress } from "@/lib/on-ramp/validate";
import { buildSignedWidgetBuyUrl } from "@/lib/on-ramp/widget-url";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = devOnlyGuard();
  if (guard) return guard;

  try {
    const body = await request.json();
    const destinationCAddress = validateCAddress(body.destinationCAddress);

    const fiatAmount =
      typeof body.fiatAmount === "string" && body.fiatAmount.trim()
        ? body.fiatAmount.trim()
        : defaultFiatAmount();
    const fiatCode =
      typeof body.fiatCode === "string" && body.fiatCode.trim()
        ? body.fiatCode.trim().toUpperCase()
        : defaultFiatCode();

    if (!/^\d+(\.\d+)?$/.test(fiatAmount) || Number(fiatAmount) <= 0) {
      throw new ApiRequestError(
        "validation_error",
        "fiatAmount must be a positive number.",
        400
      );
    }

    const { userId } = await getOrCreateSession();
    const memoId = await generateUniqueMemoId(async (candidate) => {
      const existing = await prisma.onRampIntent.findUnique({
        where: { memoId: candidate },
        select: { id: true },
      });
      return Boolean(existing);
    });

    const intentId = crypto.randomUUID();
    await prisma.onRampIntent.create({
      data: {
        id: intentId,
        memoId,
        destinationCAddress,
        externalCustomerId: userId,
        status: "created",
        fiatAmount,
        fiatCode,
      },
    });

    const poolAddress = poolGAddress();
    const mode = moonPayIntegrationMode();

    if (mode === "widget") {
      const widgetUrl = buildSignedWidgetBuyUrl({
        poolAddress,
        memoId,
        fiatAmount,
        fiatCode,
        externalCustomerId: userId,
        externalTransactionId: intentId,
      });
      return NextResponse.json({
        intentId,
        memoId,
        destinationCAddress,
        poolAddress,
        fiatAmount,
        fiatCode,
        integrationMode: "widget",
        widgetUrl,
      });
    }

    try {
      const { sessionToken } = await createMoonPaySession({
        externalCustomerId: userId,
        deviceIp: clientIp(request),
      });

      return NextResponse.json({
        intentId,
        memoId,
        sessionToken,
        destinationCAddress,
        poolAddress,
        fiatAmount,
        fiatCode,
        integrationMode: "platform",
      });
    } catch (error) {
      if (
        mode === "auto" &&
        error instanceof ApiRequestError &&
        error.status === 404
      ) {
        const widgetUrl = buildSignedWidgetBuyUrl({
          poolAddress,
          memoId,
          fiatAmount,
          fiatCode,
          externalCustomerId: userId,
          externalTransactionId: intentId,
        });
        return NextResponse.json({
          intentId,
          memoId,
          destinationCAddress,
          poolAddress,
          fiatAmount,
          fiatCode,
          integrationMode: "widget",
          widgetUrl,
          platformFallback: true,
        });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiError({
        status: error.status,
        code: error.code,
        message: error.message,
      });
    }
    console.error("on-ramp session error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return apiError({ status: 500, code: "internal_error", message });
  }
}
