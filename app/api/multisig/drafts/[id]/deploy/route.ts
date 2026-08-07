import { NextRequest, NextResponse } from "next/server";
import { rpc } from "@stellar/stellar-sdk";
import { nowMs } from "@/lib/db";
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
  deployMultisigSmartAccount,
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
    if (draft.status === "deployed") {
      return NextResponse.json({
        smartAccountAddress: draft.smartAccountAddress,
        alreadyDeployed: true,
        draft: serializeDraft(draft),
      });
    }

    const members = draft.members.map(draftRowToMember);
    for (const m of members) {
      const err = validateDraftMember(m);
      if (err) return NextResponse.json({ error: `Member "${m.name}": ${err}` }, { status: 400 });
    }

    const signers = draftMembersToFactorySigners(members);
    const input = {
      accountSaltHex: draft.accountSaltHex,
      threshold: draft.threshold,
      signers,
    };
    validateMultisigInitParams(input);

    const config = getFactoryConfigFromEnv();
    if (!config.bundlerSecret) {
      return NextResponse.json({ error: "BUNDLER_SECRET not set." }, { status: 500 });
    }

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

    const { smartAccountAddress, alreadyDeployed } = await deployMultisigSmartAccount({
      server,
      networkPassphrase: config.networkPassphrase,
      factoryAddress: config.factoryAddress,
      bundlerSecret: config.bundlerSecret,
      params,
      predictedAddress,
    });

    const now = nowMs();
    const acct = await prisma.multisigAccount.upsert({
      where: { smartAccountAddress },
      create: {
        userId,
        smartAccountAddress,
        threshold: draft.threshold,
        accountSaltHex: draft.accountSaltHex,
        createdAt: BigInt(now),
      },
      update: {
        threshold: draft.threshold,
        accountSaltHex: draft.accountSaltHex,
      },
      select: { id: true },
    });

    await prisma.multisigMember.deleteMany({ where: { multisigAccountId: acct.id } });
    await prisma.multisigMember.createMany({
      data: signersCanonical.map((s) => ({
        multisigAccountId: acct.id,
        memberType: s.type,
        label: s.label ?? null,
        keyDataHex: s.type === "webauthn" ? s.keyDataHex : null,
        credentialId:
          s.type === "webauthn"
            ? members.find(
                (m) => m.kind === "webauthn" && m.keyDataHex === s.keyDataHex
              )?.credentialId ?? null
            : null,
        gAddress: s.type === "delegated" ? s.gAddress : null,
        createdAt: BigInt(now),
      })),
    });

    await prisma.multisigDraft.update({
      where: { id },
      data: {
        status: "deployed",
        predictedAddress: smartAccountAddress,
        smartAccountAddress,
      },
    });

    const updated = await getDraftForCreator(id, userId);
    return NextResponse.json({
      smartAccountAddress,
      alreadyDeployed,
      paramsXdrBase64: params.toXDR("base64"),
      draft: serializeDraft(updated!),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Deploy failed" },
      { status: 400 }
    );
  }
}
