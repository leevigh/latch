import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { nowMs } from "@/lib/db";
import {
  assertDraftCollecting,
  duplicateMemberError,
  getDraftByInviteToken,
  memberInputToDraftMember,
  serializeDraft,
} from "@/lib/multisig-draft";
import { validateDraftMember, type MultisigSignerKind } from "@/lib/multisig-signers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

type MemberBody = {
  label: string;
  memberType: MultisigSignerKind;
  gAddress?: string;
  keyDataHex?: string;
  credentialId?: string;
  publicKeyHex?: string;
};

/** Public: remote invitee adds their signer material (no session required). */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { token } = await ctx.params;
    const draft = await getDraftByInviteToken(token);
    if (!draft) {
      return NextResponse.json({ error: "Invite not found or expired" }, { status: 404 });
    }
    assertDraftCollecting(draft.status);

    const body = (await request.json()) as MemberBody;
    const memberId = crypto.randomUUID();
    const candidate = memberInputToDraftMember(memberId, {
      label: body.label ?? "",
      memberType: body.memberType,
      gAddress: body.gAddress,
      keyDataHex: body.keyDataHex,
      credentialId: body.credentialId,
      publicKeyHex: body.publicKeyHex,
    });

    const validationError = validateDraftMember(candidate);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const existing = draft.members.map((r) =>
      memberInputToDraftMember(r.id, {
        label: r.label,
        memberType: r.memberType as MultisigSignerKind,
        gAddress: r.gAddress ?? undefined,
        keyDataHex: r.keyDataHex ?? undefined,
        credentialId: r.credentialId ?? undefined,
        publicKeyHex: r.publicKeyHex ?? undefined,
      })
    );
    const dup = duplicateMemberError(existing, candidate);
    if (dup) {
      return NextResponse.json({ error: dup }, { status: 409 });
    }

    const now = nowMs();
    await prisma.multisigDraftMember.create({
      data: {
        id: memberId,
        draftId: draft.id,
        label: candidate.name,
        memberType: candidate.kind,
        gAddress: candidate.gAddress ?? null,
        keyDataHex: candidate.keyDataHex ?? null,
        credentialId: candidate.credentialId ?? null,
        publicKeyHex: candidate.publicKeyHex ?? null,
        source: "invite",
        createdAt: BigInt(now),
      },
    });

    const updated = await getDraftByInviteToken(token);
    return NextResponse.json({
      member: {
        id: memberId,
        label: candidate.name,
        memberType: candidate.kind,
        fingerprint: candidate.keyDataHex
          ? `passkey · ${candidate.keyDataHex.slice(0, 8)}…`
          : candidate.gAddress
            ? `G…${candidate.gAddress.slice(-6)}`
            : "added",
      },
      draft: serializeDraft(updated!),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Join member failed" },
      { status: 500 }
    );
  }
}
