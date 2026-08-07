import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { ApiRequestError } from "@/lib/api-errors";
import { getSignPayload } from "@/lib/sign-payload/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ payloadRef: string }> };

export async function GET(_request: NextRequest, ctx: Ctx) {
  try {
    const { payloadRef } = await ctx.params;
    if (!payloadRef?.startsWith("sp_")) {
      return apiError({
        status: 404,
        code: "not_found",
        message: "Payload reference not found.",
      });
    }

    const payload = await getSignPayload(payloadRef);
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiError({
        status: error.status,
        code: error.code,
        message: error.message,
      });
    }
    console.error("sign-payload GET error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return apiError({ status: 500, code: "internal_error", message });
  }
}
