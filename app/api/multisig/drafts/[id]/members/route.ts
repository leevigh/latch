import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { nowMs } from "@/lib/db";
import { getOrCreateSession } from "@/lib/session";
import {
  assertDraftCollecting,
  duplicateMemberError,
  getDraftForCreator,
  memberInputToDraftMember,
  serializeDraft,
} from "@/lib/multisig-draft";
import { validateDraftMember, type MultisigSignerKind } from "@/lib/multisig-signers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type MemberBody = {
  label: string;
  memberType: MultisigSignerKind;
  gAddress?: string;
  keyDataHex?: string;
  credentialId?: string;
  publicKeyHex?: string;
};

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { userId } = await getOrCreateSession();
    const { id } = await ctx.params;
    const draft = await getDraftForCreator(id, userId);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    assertDraftCollecting(draft.status);

    const body = (await request.json()) as MemberBody;
    const memberId = crypto.randomUUID();
    const candidate = memberInputToDraftMember(memberId, {
      label: body.label ?? "",
      memberType: body.memberType,
      gAddress: body.gAddress,
      keyDataHex: body.keyDataHex,
      credentialId: body.credentialId,
      publicKeyHex: body.publicKeyHex,
    });

    const validationError = validateDraftMember(candidate);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const dup = duplicateMemberError(
      draft.members.map((r) => memberInputToDraftMember(r.id, {
        label: r.label,
        memberType: r.memberType as MultisigSignerKind,
        gAddress: r.gAddress ?? undefined,
        keyDataHex: r.keyDataHex ?? undefined,
        credentialId: r.credentialId ?? undefined,
        publicKeyHex: r.publicKeyHex ?? undefined,
      })),
      candidate
    );
    if (dup) {
      return NextResponse.json({ error: dup }, { status: 409 });
    }

    const now = nowMs();
    await prisma.multisigDraftMember.create({
      data: {
        id: memberId,
        draftId: id,
        label: candidate.name,
        memberType: candidate.kind,
        gAddress: candidate.gAddress ?? null,
        keyDataHex: candidate.keyDataHex ?? null,
        credentialId: candidate.credentialId ?? null,
        publicKeyHex: candidate.publicKeyHex ?? null,
        source: "creator",
        createdAt: BigInt(now),
      },
    });

    const updated = await getDraftForCreator(id, userId);
    return NextResponse.json({ draft: serializeDraft(updated!) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Add member failed" },
      { status: 500 }
    );
  }
}
