import { NextRequest, NextResponse } from "next/server";
import { buildInviteUrl, getDraftByInviteToken, serializeDraft } from "@/lib/multisig-draft";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

/** Public: invitee reads draft metadata (no member secrets beyond fingerprints). */
export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    const { token } = await ctx.params;
    const draft = await getDraftByInviteToken(token);
    if (!draft) {
      return NextResponse.json({ error: "Invite not found or expired" }, { status: 404 });
    }

    const serialized = serializeDraft(draft);
    return NextResponse.json({
      draft: {
        id: serialized.id,
        threshold: serialized.threshold,
        status: serialized.status,
        memberCount: serialized.members.length,
        validMemberCount: serialized.validMemberCount,
        members: serialized.members.map((m) => ({
          id: m.id,
          label: m.label,
          memberType: m.memberType,
          source: m.source,
          fingerprint: m.fingerprint,
          valid: m.valid,
        })),
      },
      joinPath: `/multisig/join/${token}`,
      inviteUrl: buildInviteUrl(request, token),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Join info failed" },
      { status: 500 }
    );
  }
}
