import { NextRequest, NextResponse } from "next/server";
import { rpc } from "@stellar/stellar-sdk";
import {
  buildMultisigAccountInitParams,
  canonicalizeMultisigSigners,
  deployMultisigSmartAccount,
  getFactoryConfigFromEnv,
  predictMultisigSmartAccountAddress,
  validateMultisigInitParams,
  type MultisigSignerInit,
} from "@/lib/smart-account-factory-multisig";

type DeployBody = {
  threshold: number;
  signers: MultisigSignerInit[];
  accountSaltHex: string;
};

/**
 * Deploy a multisig smart account via the factory.
 *
 * Body:
 *  - accountSaltHex: 32-byte hex (must match what was used for draft/prediction)
 *  - threshold: M
 *  - signers: same list as draft
 */
export async function POST(request: NextRequest) {
  try {
    const config = getFactoryConfigFromEnv();
    if (!config.bundlerSecret) {
      return NextResponse.json({ error: "BUNDLER_SECRET not set." }, { status: 500 });
    }

    const server = new rpc.Server(config.rpcUrl);
    const body = (await request.json()) as DeployBody;

    const input = {
      accountSaltHex: body.accountSaltHex,
      threshold: Number(body.threshold),
      signers: Array.isArray(body.signers) ? body.signers : [],
    };

    validateMultisigInitParams(input);

    const signersCanonical = canonicalizeMultisigSigners(input.signers);
    const params = buildMultisigAccountInitParams({
      accountSaltHex: input.accountSaltHex,
      threshold: input.threshold,
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

    return NextResponse.json({
      smartAccountAddress,
      predictedAddress,
      alreadyDeployed,
      accountSaltHex: input.accountSaltHex,
      threshold: input.threshold,
      signers: signersCanonical,
      paramsXdrBase64: params.toXDR("base64"),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Deploy failed" },
      { status: 400 }
    );
  }
}

