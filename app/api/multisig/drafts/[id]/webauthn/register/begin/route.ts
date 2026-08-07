import { NextResponse } from "next/server";
import { getOrCreateSession } from "@/lib/session";
import { getDraftForCreator } from "@/lib/multisig-draft";
import { beginDraftWebauthnRegistration } from "@/lib/multisig-draft-webauthn";
import { WebauthnCeremonyConfigError } from "@/lib/webauthn-server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  try {
    const { userId } = await getOrCreateSession();
    const { id } = await ctx.params;
    const draft = await getDraftForCreator(id, userId);
    if (!draft || draft.status !== "collecting") {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      displayName?: string;
      chromeExtensionId?: string;
    };

    const { options } = await beginDraftWebauthnRegistration({
      request,
      draftId: id,
      challengeUserId: userId,
      displayName: body.displayName,
      chromeExtensionId: body.chromeExtensionId,
    });

    return NextResponse.json({ options });
  } catch (error) {
    if (error instanceof WebauthnCeremonyConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Registration begin failed" },
      { status: 500 }
    );
  }
}
