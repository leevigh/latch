import { NextResponse } from "next/server";
import { getDraftByInviteToken } from "@/lib/multisig-draft";
import {
  beginDraftWebauthnRegistration,
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

    const body = (await request.json().catch(() => ({}))) as {
      displayName?: string;
      chromeExtensionId?: string;
    };

    const challengeUserId = await joinChallengeUserId();
    const { options } = await beginDraftWebauthnRegistration({
      request,
      draftId: draft.id,
      challengeUserId,
      displayName: body.displayName,
      chromeExtensionId: body.chromeExtensionId,
    });

    return NextResponse.json({ options, draftId: draft.id });
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
