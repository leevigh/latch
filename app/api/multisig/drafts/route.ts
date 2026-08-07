import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSession } from "@/lib/session";
import {
  buildInviteUrl,
  createMultisigDraft,
  serializeDraft,
} from "@/lib/multisig-draft";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** POST — create a new collecting draft. GET ?active=1 — latest collecting draft for session user. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await getOrCreateSession();
    const draft = await createMultisigDraft(userId);
    const serialized = serializeDraft(draft);
    return NextResponse.json({
      draft: serialized,
      inviteUrl: buildInviteUrl(request, draft.inviteToken),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Create draft failed" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await getOrCreateSession();
    const active = request.nextUrl.searchParams.get("active");
    if (active !== "1") {
      return NextResponse.json({ error: "Use ?active=1 to fetch the current draft" }, { status: 400 });
    }

    const draft = await prisma.multisigDraft.findFirst({
      where: { creatorUserId: userId, status: "collecting" },
      orderBy: { createdAt: "desc" },
      include: { members: { orderBy: { createdAt: "asc" } } },
    });

    if (!draft) {
      return NextResponse.json({ draft: null });
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
