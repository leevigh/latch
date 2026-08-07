import { NextResponse } from "next/server";
import { getDraftByInviteToken } from "@/lib/multisig-draft";
import {
  beginDraftWebauthnAuthentication,
  joinChallengeUserId,
} from "@/lib/multisig-draft-webauthn";
import { WebauthnCeremonyConfigError } from "@/lib/webauthn-server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

export async function POST(request: Request, ctx: Ctx) {
  try {
    const { token } = await ctx.params;
    const draft = await getDraftByInviteToken(token);
    if (!draft) {
      return NextResponse.json({ error: "Invite not found or expired" }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as { chromeExtensionId?: string };
    const challengeUserId = await joinChallengeUserId();
    const { options } = await beginDraftWebauthnAuthentication({
      request,
      draftId: draft.id,
      challengeUserId,
      chromeExtensionId: body.chromeExtensionId,
      sessionUserId: challengeUserId,
    });

    return NextResponse.json({ options, draftId: draft.id });
  } catch (error) {
    if (error instanceof WebauthnCeremonyConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Authentication begin failed" },
      { status: 500 }
    );
  }
}
