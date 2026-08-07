import * as crypto from "crypto";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

export type FactoryConfig = {
  rpcUrl: string;
  networkPassphrase: string;
  factoryAddress: string;
  bundlerSecret?: string;
};

export function getFactoryConfigFromEnv(): FactoryConfig {
  const rpcUrl =
    process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org";
  const networkPassphrase =
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
  const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  const bundlerSecret = process.env.BUNDLER_SECRET;
  if (!factoryAddress) {
    throw new Error("NEXT_PUBLIC_FACTORY_ADDRESS not configured.");
  }
  return { rpcUrl, networkPassphrase, factoryAddress, bundlerSecret };
}

export type MultisigSignerInit =
  | { type: "webauthn"; keyDataHex: string; label?: string }
  | { type: "delegated"; gAddress: string; label?: string };

export type MultisigInitParamsInput = {
  /** 32-byte salt. If omitted, caller should generate and persist. */
  accountSaltHex: string;
  threshold: number;
  signers: MultisigSignerInit[];
};

export function randomAccountSaltHex(): string {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeHex(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

function assertHexLen(hex: string, bytes: number, name: string) {
  const h = normalizeHex(hex);
  if (h.length !== bytes * 2) {
    throw new Error(`${name} must be ${bytes} bytes (${bytes * 2} hex chars).`);
  }
  if (!/^[0-9a-f]+$/i.test(h)) {
    throw new Error(`${name} must be hex.`);
  }
}

export function canonicalizeMultisigSigners(
  signers: MultisigSignerInit[]
): MultisigSignerInit[] {
  // Canonical order is ultimately enforced by the factory; we sort for stable UX and API idempotence.
  return [...signers].sort((a, b) => {
    const aKey =
      a.type === "delegated"
        ? `0:delegated:${a.gAddress}`
        : `1:webauthn:${normalizeHex(a.keyDataHex)}`;
    const bKey =
      b.type === "delegated"
        ? `0:delegated:${b.gAddress}`
        : `1:webauthn:${normalizeHex(b.keyDataHex)}`;
    return aKey.localeCompare(bKey);
  });
}

export function validateMultisigInitParams(input: MultisigInitParamsInput): void {
  assertHexLen(input.accountSaltHex, 32, "accountSaltHex");

  if (!Number.isInteger(input.threshold) || input.threshold < 1) {
    throw new Error("threshold must be an integer >= 1.");
  }
  if (!Array.isArray(input.signers) || input.signers.length < 2) {
    throw new Error("signers must have length >= 2 for multisig.");
  }
  if (input.threshold > input.signers.length) {
    throw new Error("threshold cannot exceed number of signers.");
  }

  const seen = new Set<string>();
  for (const s of input.signers) {
    if (s.type === "webauthn") {
      const keyDataHex = normalizeHex(s.keyDataHex);
      if (keyDataHex.length < 132) {
        // 65 bytes = 130 hex chars; must be > 65 bytes (pubkey + credId)
        throw new Error("webauthn keyDataHex must be > 65 bytes (>= 132 hex chars).");
      }
      if (!/^[0-9a-f]+$/i.test(keyDataHex)) {
        throw new Error("webauthn keyDataHex must be hex.");
      }
      const dupKey = `webauthn:${keyDataHex}`;
      if (seen.has(dupKey)) throw new Error("Duplicate webauthn signer keyDataHex.");
      seen.add(dupKey);
    } else if (s.type === "delegated") {
      // Address constructor validates StrKey shape at runtime; keep checks lightweight here.
      const dupKey = `delegated:${s.gAddress}`;
      if (seen.has(dupKey)) throw new Error("Duplicate delegated signer gAddress.");
      seen.add(dupKey);
    } else {
      // Exhaustive
      const _exhaustive: never = s;
      throw new Error(`Unsupported signer type: ${(s as any)?.type}`);
    }
  }
}

function buildDelegatedSignerScVal(gAddress: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Delegated"), new Address(gAddress).toScVal()]);
}

function buildWebauthnSignerScVal(keyDataHex: string): xdr.ScVal {
  const signerStruct = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("key_data"),
      val: xdr.ScVal.scvBytes(Buffer.from(normalizeHex(keyDataHex), "hex")),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signer_kind"),
      // SignerKind::WebAuthn — unit enum: Vec([Symbol("WebAuthn")])
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("WebAuthn")]),
    }),
  ]);

  // AccountSignerInit::External(ExternalSignerInit)
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), signerStruct]);
}

export function buildMultisigAccountInitParams(input: MultisigInitParamsInput): xdr.ScVal {
  validateMultisigInitParams(input);
  const signers = canonicalizeMultisigSigners(input.signers);

  const signerScVals = signers.map((s) => {
    if (s.type === "delegated") return buildDelegatedSignerScVal(s.gAddress);
    return buildWebauthnSignerScVal(s.keyDataHex);
  });

  // AccountInitParams struct — fields must be in alphabetical key order
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("account_salt"),
      val: xdr.ScVal.scvBytes(Buffer.from(normalizeHex(input.accountSaltHex), "hex")),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvVec(signerScVals),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("threshold"),
      val: xdr.ScVal.scvU32(input.threshold),
    }),
  ]);
}

export async function predictMultisigSmartAccountAddress(args: {
  server: rpc.Server;
  networkPassphrase: string;
  factoryAddress: string;
  params: xdr.ScVal;
}): Promise<string> {
  const dummyKp = Keypair.random();
  const dummyAccount = new Account(dummyKp.publicKey(), "0");
  const factory = new Contract(args.factoryAddress);

  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: args.networkPassphrase,
  })
    .addOperation(factory.call("get_account_address", args.params))
    .setTimeout(30)
    .build();

  const sim = await args.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`get_account_address simulation failed: ${sim.error}`);
  }

  return scValToNative(sim.result!.retval);
}

export async function isSorobanContractDeployed(server: rpc.Server, contractAddress: string) {
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractAddress).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const { entries } = await server.getLedgerEntries(instanceKey);
  return entries.length > 0;
}

export async function deployMultisigSmartAccount(args: {
  server: rpc.Server;
  networkPassphrase: string;
  factoryAddress: string;
  bundlerSecret: string;
  params: xdr.ScVal;
  predictedAddress: string;
}): Promise<{ smartAccountAddress: string; alreadyDeployed: boolean }> {
  const bundlerKeypair = Keypair.fromSecret(args.bundlerSecret);

  const alreadyDeployed = await isSorobanContractDeployed(args.server, args.predictedAddress);
  if (alreadyDeployed) {
    return { smartAccountAddress: args.predictedAddress, alreadyDeployed: true };
  }

  const bundlerAccount = await args.server.getAccount(bundlerKeypair.publicKey());
  const factory = new Contract(args.factoryAddress);

  const createTx = new TransactionBuilder(bundlerAccount, {
    fee: "1500000",
    networkPassphrase: args.networkPassphrase,
  })
    .addOperation(factory.call("create_account", args.params))
    .setTimeout(300)
    .build();

  const sim = await args.server.simulateTransaction(createTx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`create_account simulation failed: ${sim.error}`);
  }

  const assembled = rpc.assembleTransaction(createTx, sim).build();
  assembled.sign(bundlerKeypair);

  const sendResult = await args.server.sendTransaction(assembled);
  if (sendResult.status === "ERROR") {
    throw new Error(`Factory create_account failed: ${sendResult.errorResult?.toXDR("base64")}`);
  }

  let smartAccountAddress: string | undefined;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const txResult = await args.server.getTransaction(sendResult.hash);
    if (txResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
    if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const success = txResult as rpc.Api.GetSuccessfulTransactionResponse;
      if (success.returnValue) smartAccountAddress = scValToNative(success.returnValue);
      break;
    }
    throw new Error(`Factory deployment failed with status: ${txResult.status}`);
  }

  if (!smartAccountAddress) smartAccountAddress = args.predictedAddress;
  if (smartAccountAddress !== args.predictedAddress) {
    throw new Error(
      `Deterministic address mismatch: predicted=${args.predictedAddress} actual=${smartAccountAddress}`
    );
  }

  return { smartAccountAddress, alreadyDeployed: false };
}

