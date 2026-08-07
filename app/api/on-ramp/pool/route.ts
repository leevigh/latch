import { NextRequest, NextResponse } from "next/server";
import { apiError, ApiRequestError } from "@/lib/api-errors";
import { poolGAddress } from "@/lib/on-ramp/config";
import { devOnlyGuard } from "@/lib/on-ramp/dev-guard";
import { fetchPoolAccountSnapshot } from "@/lib/on-ramp/pool-balance";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = devOnlyGuard();
  if (guard) return guard;

  try {
    const memoFilter = request.nextUrl.searchParams.get("memo")?.trim() || undefined;
    const snapshot = await fetchPoolAccountSnapshot({
      poolAddress: poolGAddress(),
      network: "testnet",
      memoFilter,
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiError({
        status: error.status,
        code: error.code,
        message: error.message,
      });
    }
    console.error("on-ramp pool error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return apiError({ status: 500, code: "internal_error", message });
  }
}
