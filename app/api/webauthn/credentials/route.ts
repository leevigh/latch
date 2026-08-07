import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";

export const runtime = "nodejs";

/** Credential ids for the current session (match multisig members for approvals). */
export async function GET() {
  try {
    const { userId } = await getOrCreateSession();
    const creds = await prisma.webauthnCredential.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { credentialId: true, createdAt: true },
    });
    return NextResponse.json({
      credentials: creds.map((c) => ({
        credentialId: c.credentialId,
        createdAt: Number(c.createdAt),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "List credentials failed" },
      { status: 500 }
    );
  }
}
