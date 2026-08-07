import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { ApiRequestError } from "@/lib/api-errors";
import { isNetwork } from "@/lib/network";
import { createSignPayload } from "@/lib/sign-payload/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      network,
      smartAccountAddress,
      unsignedTxXdr,
      callback,
      requestId,
      origin,
      submit,
      ttlSeconds,
    } = body;

    if (!network || !isNetwork(network)) {
      return apiError({
        status: 400,
        code: "invalid_network",
        message: 'network must be "testnet" or "mainnet".',
      });
    }

    if (!unsignedTxXdr || typeof unsignedTxXdr !== "string") {
      return apiError({
        status: 400,
        code: "validation_error",
        message: "Missing unsignedTxXdr.",
      });
    }

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return apiError({
        status: 400,
        code: "validation_error",
        message: "Missing smartAccountAddress.",
      });
    }

    if (!callback || typeof callback !== "string") {
      return apiError({
        status: 400,
        code: "validation_error",
        message: "Missing callback.",
      });
    }

    const result = await createSignPayload(
      {
        network,
        smartAccountAddress,
        unsignedTxXdr,
        callback,
        requestId,
        origin,
        submit,
      },
      typeof ttlSeconds === "number" ? ttlSeconds : undefined
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiError({
        status: error.status,
        code: error.code,
        message: error.message,
      });
    }
    const prismaCode =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "";
    const message = error instanceof Error ? error.message : "Internal server error";
    if (
      prismaCode === "P1001" ||
      message.includes("Can't reach database server")
    ) {
      return apiError({
        status: 503,
        code: "database_unavailable",
        message:
          "Database is temporarily unreachable. Check DATABASE_URL in .env and that your Neon project is active, then restart the dev server.",
      });
    }
    console.error("sign-payload POST error:", error);
    return apiError({ status: 500, code: "internal_error", message });
  }
}
