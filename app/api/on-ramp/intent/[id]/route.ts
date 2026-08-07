import { NextRequest, NextResponse } from "next/server";
import { apiError, ApiRequestError } from "@/lib/api-errors";
import { devOnlyGuard } from "@/lib/on-ramp/dev-guard";
import { getMoonPayTransaction } from "@/lib/on-ramp/moonpay";
import type { OnRampIntentStatus } from "@/lib/on-ramp/types";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const INTENT_STATUSES = new Set<OnRampIntentStatus>([
  "created",
  "pending",
  "completed",
  "failed",
]);

type RouteContext = { params: Promise<{ id: string }> };

async function serializeIntent(intent: {
  id: string;
  memoId: string;
  destinationCAddress: string;
  status: string;
  moonpayTransactionId: string | null;
  fiatAmount: string;
  fiatCode: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  let moonpayTransactionStatus: string | null = null;
  if (intent.moonpayTransactionId) {
    try {
      const tx = await getMoonPayTransaction(intent.moonpayTransactionId);
      moonpayTransactionStatus = tx.data.status;
    } catch {
      moonpayTransactionStatus = null;
    }
  }

  return {
    id: intent.id,
    memoId: intent.memoId,
    destinationCAddress: intent.destinationCAddress,
    status: intent.status as OnRampIntentStatus,
    moonpayTransactionId: intent.moonpayTransactionId,
    fiatAmount: intent.fiatAmount,
    fiatCode: intent.fiatCode,
    moonpayTransactionStatus,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
  };
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = devOnlyGuard();
  if (guard) return guard;

  try {
    const { id } = await context.params;
    const intent = await prisma.onRampIntent.findUnique({ where: { id } });
    if (!intent) {
      return apiError({
        status: 404,
        code: "not_found",
        message: "On-ramp intent not found.",
      });
    }
    return NextResponse.json(await serializeIntent(intent));
  } catch (error) {
    console.error("on-ramp intent GET error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return apiError({ status: 500, code: "internal_error", message });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = devOnlyGuard();
  if (guard) return guard;

  try {
    const { id } = await context.params;
    const body = await request.json();

    const data: {
      status?: string;
      moonpayTransactionId?: string;
    } = {};

    if (body.status !== undefined) {
      if (!INTENT_STATUSES.has(body.status)) {
        throw new ApiRequestError(
          "validation_error",
          'status must be "created", "pending", "completed", or "failed".',
          400
        );
      }
      data.status = body.status;
    }

    if (body.moonpayTransactionId !== undefined) {
      if (
        typeof body.moonpayTransactionId !== "string" ||
        !body.moonpayTransactionId.trim()
      ) {
        throw new ApiRequestError(
          "validation_error",
          "moonpayTransactionId must be a non-empty string.",
          400
        );
      }
      data.moonpayTransactionId = body.moonpayTransactionId.trim();
    }

    if (!data.status && !data.moonpayTransactionId) {
      throw new ApiRequestError(
        "validation_error",
        "Provide status and/or moonpayTransactionId to update.",
        400
      );
    }

    const intent = await prisma.onRampIntent.update({
      where: { id },
      data,
    });

    return NextResponse.json(await serializeIntent(intent));
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiError({
        status: error.status,
        code: error.code,
        message: error.message,
      });
    }
    const prismaCode = (error as { code?: string }).code;
    if (prismaCode === "P2025") {
      return apiError({
        status: 404,
        code: "not_found",
        message: "On-ramp intent not found.",
      });
    }
    console.error("on-ramp intent PATCH error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return apiError({ status: 500, code: "internal_error", message });
  }
}
