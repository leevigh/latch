import { NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { getOrCreateSession } from "@/lib/session";
import { getDraftForCreator } from "@/lib/multisig-draft";
import { finishDraftWebauthnAuthentication } from "@/lib/multisig-draft-webauthn";
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

    const body = (await request.json()) as {
      response: AuthenticationResponseJSON;
      chromeExtensionId?: string;
    };
    if (!body?.response) {
      return NextResponse.json({ error: "Missing response" }, { status: 400 });
    }

    const { credentialId, keyDataHex } = await finishDraftWebauthnAuthentication({
      request,
      draftId: id,
      challengeUserId: userId,
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
