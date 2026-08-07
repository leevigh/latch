import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { userId } = await getOrCreateSession();

    const accounts = await prisma.multisigAccount.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        smartAccountAddress: true,
        threshold: true,
        accountSaltHex: true,
        createdAt: true,
        members: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            memberType: true,
            label: true,
            credentialId: true,
            gAddress: true,
            keyDataHex: true,
          },
        },
        _count: { select: { proposals: true } },
      },
    });

    return NextResponse.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        smartAccountAddress: a.smartAccountAddress,
        threshold: a.threshold,
        accountSaltHex: a.accountSaltHex,
        createdAt: Number(a.createdAt),
        proposalCount: a._count.proposals,
        members: a.members.map((m) => ({
          id: m.id,
          memberType: m.memberType,
          label: m.label,
          credentialId: m.credentialId,
          gAddress: m.gAddress,
          hasKeyData: !!m.keyDataHex,
        })),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "List multisig accounts failed" },
      { status: 500 }
    );
  }
}
