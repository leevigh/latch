import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSession } from "@/lib/session";
import {
  assertDraftCollecting,
  getDraftForCreator,
  serializeDraft,
} from "@/lib/multisig-draft";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; memberId: string }> };

export async function DELETE(_request: NextRequest, ctx: Ctx) {
  try {
    const { userId } = await getOrCreateSession();
    const { id, memberId } = await ctx.params;
    const draft = await getDraftForCreator(id, userId);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    assertDraftCollecting(draft.status);

    await prisma.multisigDraftMember.deleteMany({
      where: { id: memberId, draftId: id },
    });

    const updated = await getDraftForCreator(id, userId);
    return NextResponse.json({ draft: serializeDraft(updated!) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Remove member failed" },
      { status: 500 }
    );
  }
}
