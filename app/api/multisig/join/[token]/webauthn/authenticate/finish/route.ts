import { NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { getDraftByInviteToken } from "@/lib/multisig-draft";
import {
  finishDraftWebauthnAuthentication,
  joinChallengeUserId,
} from "@/lib/multisig-draft-webauthn";
import { WebauthnCeremonyConfigError } from "@/lib/webauthn-server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

type FinishBody = {
  response: AuthenticationResponseJSON;
  chromeExtensionId?: string;
};

export async function POST(request: Request, ctx: Ctx) {
  try {
    const { token } = await ctx.params;
    const draft = await getDraftByInviteToken(token);
    if (!draft) {
      return NextResponse.json({ error: "Invite not found or expired" }, { status: 404 });
    }

    const body = (await request.json()) as FinishBody;
    if (!body?.response) {
      return NextResponse.json({ error: "Missing response" }, { status: 400 });
    }

    const challengeUserId = await joinChallengeUserId();
    const { credentialId, keyDataHex } = await finishDraftWebauthnAuthentication({
      request,
      draftId: draft.id,
      challengeUserId,
      response: body.response,
      chromeExtensionId: body.chromeExtensionId,
    });

    return NextResponse.json({ credentialId, keyDataHex });
  } catch (error) {
    if (error instanceof WebauthnCeremonyConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Authentication finish failed" },
      { status: 500 }
    );
  }
}
