import { NextResponse } from "next/server";
import { getOrCreateSession } from "@/lib/session";
import { buildRegistrationOptions } from "@/lib/webauthn-registration-options";
import { WebauthnCeremonyConfigError } from "@/lib/webauthn-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { userId } = await getOrCreateSession();
    const body = (await request.json().catch(() => ({}))) as {
      displayName?: string;
      chromeExtensionId?: string;
    };

    const { options } = await buildRegistrationOptions({
      request,
      sessionUserId: userId,
      displayName: body.displayName,
      chromeExtensionId: body.chromeExtensionId,
      challengePurpose: "registration",
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
