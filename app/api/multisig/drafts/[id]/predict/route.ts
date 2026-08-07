import { NextRequest, NextResponse } from "next/server";
import { rpc } from "@stellar/stellar-sdk";
import { getOrCreateSession } from "@/lib/session";
import {
  draftMembersToFactorySigners,
  draftRowToMember,
  getDraftForCreator,
  serializeDraft,
} from "@/lib/multisig-draft";
import { validateDraftMember } from "@/lib/multisig-signers";
import {
  buildMultisigAccountInitParams,
  canonicalizeMultisigSigners,
  getFactoryConfigFromEnv,
  predictMultisigSmartAccountAddress,
  validateMultisigInitParams,
} from "@/lib/smart-account-factory-multisig";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { userId } = await getOrCreateSession();
    const { id } = await ctx.params;
    const draft = await getDraftForCreator(id, userId);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const members = draft.members.map(draftRowToMember);
    for (const m of members) {
      const err = validateDraftMember(m);
      if (err) return NextResponse.json({ error: `Member "${m.name}": ${err}` }, { status: 400 });
    }

    const signers = draftMembersToFactorySigners(members);
    if (signers.length < 2) {
      return NextResponse.json({ error: "Need at least 2 valid signers" }, { status: 400 });
    }

    const input = {
      accountSaltHex: draft.accountSaltHex,
      threshold: draft.threshold,
      signers,
    };
    validateMultisigInitParams(input);

    const config = getFactoryConfigFromEnv();
    const server = new rpc.Server(config.rpcUrl);
    const signersCanonical = canonicalizeMultisigSigners(signers);
    const params = buildMultisigAccountInitParams({
      accountSaltHex: draft.accountSaltHex,
      threshold: draft.threshold,
      signers: signersCanonical,
    });

    const predictedAddress = await predictMultisigSmartAccountAddress({
      server,
      networkPassphrase: config.networkPassphrase,
      factoryAddress: config.factoryAddress,
      params,
    });

    await prisma.multisigDraft.update({
      where: { id },
      data: { predictedAddress },
    });

    const updated = await getDraftForCreator(id, userId);
    return NextResponse.json({
      smartAccountAddress: predictedAddress,
      paramsXdrBase64: params.toXDR("base64"),
      draft: serializeDraft(updated!),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Predict failed" },
      { status: 400 }
    );
  }
}
