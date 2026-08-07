import { NextRequest, NextResponse } from "next/server";
import { rpc } from "@stellar/stellar-sdk";
import {
  buildMultisigAccountInitParams,
  canonicalizeMultisigSigners,
  getFactoryConfigFromEnv,
  predictMultisigSmartAccountAddress,
  randomAccountSaltHex,
  validateMultisigInitParams,
  type MultisigSignerInit,
} from "@/lib/smart-account-factory-multisig";

type DraftBody = {
  threshold: number;
  signers: MultisigSignerInit[];
  accountSaltHex?: string;
};

/**
 * Draft a multisig account creation recipe and return predicted address.
 *
 * Body:
 *  - threshold: M
 *  - signers: [{ type: "webauthn", keyDataHex } | { type: "delegated", gAddress }]
 *  - accountSaltHex?: optional 32-byte hex; if omitted server generates one
 */
export async function POST(request: NextRequest) {
  try {
    const config = getFactoryConfigFromEnv();
    const server = new rpc.Server(config.rpcUrl);
    const body = (await request.json()) as DraftBody;

    const accountSaltHex = body.accountSaltHex ?? randomAccountSaltHex();

    const input = {
      accountSaltHex,
      threshold: Number(body.threshold),
      signers: Array.isArray(body.signers) ? body.signers : [],
    };

    validateMultisigInitParams(input);

    const signersCanonical = canonicalizeMultisigSigners(input.signers);
    const params = buildMultisigAccountInitParams({
      accountSaltHex,
      threshold: input.threshold,
      signers: signersCanonical,
    });

    const predictedAddress = await predictMultisigSmartAccountAddress({
      server,
      networkPassphrase: config.networkPassphrase,
      factoryAddress: config.factoryAddress,
      params,
    });

    return NextResponse.json({
      smartAccountAddress: predictedAddress,
      accountSaltHex,
      threshold: input.threshold,
      signers: signersCanonical,
      paramsXdrBase64: params.toXDR("base64"),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Draft failed" },
      { status: 400 }
    );
  }
}

