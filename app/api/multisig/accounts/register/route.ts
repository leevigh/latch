import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";
import { nowMs } from "@/lib/db";

export const runtime = "nodejs";

type RegisterBody = {
  smartAccountAddress: string;
  threshold: number;
  accountSaltHex: string;
  members: Array<
    | { type: "webauthn"; keyDataHex: string; credentialId?: string; label?: string }
    | { type: "delegated"; gAddress: string; label?: string }
  >;
};

export async function POST(request: NextRequest) {
  try {
    const { userId } = await getOrCreateSession();
    const body = (await request.json()) as RegisterBody;
    const now = nowMs();

    if (!body?.smartAccountAddress || typeof body.smartAccountAddress !== "string") {
      return NextResponse.json({ error: "Missing smartAccountAddress" }, { status: 400 });
    }
    const threshold = Number(body.threshold);
    if (!Number.isInteger(threshold) || threshold < 1) {
      return NextResponse.json({ error: "threshold must be integer >= 1" }, { status: 400 });
    }
    if (!body.accountSaltHex || typeof body.accountSaltHex !== "string") {
      return NextResponse.json({ error: "Missing accountSaltHex" }, { status: 400 });
    }
    if (!Array.isArray(body.members) || body.members.length < 2) {
      return NextResponse.json({ error: "members must have length >= 2" }, { status: 400 });
    }
    if (threshold > body.members.length) {
      return NextResponse.json({ error: "threshold cannot exceed members length" }, { status: 400 });
    }

    const acct = await prisma.multisigAccount.upsert({
      where: { smartAccountAddress: body.smartAccountAddress },
      create: {
        userId,
        smartAccountAddress: body.smartAccountAddress,
        threshold,
        accountSaltHex: body.accountSaltHex,
        createdAt: BigInt(now),
      },
      update: {
        threshold,
        accountSaltHex: body.accountSaltHex,
      },
      select: { id: true, smartAccountAddress: true, threshold: true, accountSaltHex: true },
    });

    // Replace members set (simplest, keeps API idempotent)
    await prisma.multisigMember.deleteMany({ where: { multisigAccountId: acct.id } });
    await prisma.multisigMember.createMany({
      data: body.members.map((m) => ({
        multisigAccountId: acct.id,
        memberType: m.type,
        label: m.label ?? null,
        keyDataHex: m.type === "webauthn" ? m.keyDataHex : null,
        credentialId: m.type === "webauthn" ? m.credentialId ?? null : null,
        gAddress: m.type === "delegated" ? m.gAddress : null,
        createdAt: BigInt(now),
      })),
    });

    const members = await prisma.multisigMember.findMany({
      where: { multisigAccountId: acct.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, memberType: true, label: true, keyDataHex: true, gAddress: true },
    });

    return NextResponse.json({
      multisigAccount: {
        id: acct.id,
        smartAccountAddress: acct.smartAccountAddress,
        threshold: acct.threshold,
        accountSaltHex: acct.accountSaltHex,
        members,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Register failed" },
      { status: 500 }
    );
  }
}

