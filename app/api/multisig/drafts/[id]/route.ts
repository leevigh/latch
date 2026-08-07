import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSession } from "@/lib/session";
import {
  buildInviteUrl,
  getDraftForCreator,
  serializeDraft,
} from "@/lib/multisig-draft";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    const { userId } = await getOrCreateSession();
    const { id } = await ctx.params;
    const draft = await getDraftForCreator(id, userId);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    return NextResponse.json({
      draft: serializeDraft(draft),
      inviteUrl: buildInviteUrl(request, draft.inviteToken),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Get draft failed" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest, ctx: Ctx) {
  try {
    const { userId } = await getOrCreateSession();
    const { id } = await ctx.params;
    const body = (await request.json()) as { threshold?: number };
    const draft = await getDraftForCreator(id, userId);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    if (draft.status !== "collecting") {
      return NextResponse.json({ error: "Draft is not editable" }, { status: 400 });
    }

    const threshold = Number(body.threshold);
    if (!Number.isInteger(threshold) || threshold < 1) {
      return NextResponse.json({ error: "threshold must be integer >= 1" }, { status: 400 });
    }
    if (threshold > draft.members.length) {
      return NextResponse.json(
        { error: "threshold cannot exceed member count" },
        { status: 400 }
      );
    }

    const updated = await prisma.multisigDraft.update({
      where: { id },
      data: { threshold },
      include: { members: { orderBy: { createdAt: "asc" } } },
    });

    return NextResponse.json({
      draft: serializeDraft(updated),
      inviteUrl: buildInviteUrl(request, updated.inviteToken),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update draft failed" },
      { status: 500 }
    );
  }
}
