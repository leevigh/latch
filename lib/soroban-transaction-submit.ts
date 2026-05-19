import {
  Keypair,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { getBundlerAccount } from "@/lib/soroban-bundler";

export type SubmitAssembledParams = {
  server: rpc.Server;
  networkPassphrase: string;
  bundlerSecret: string;
  txWithAuth: Transaction;
  pollAttempts?: number;
};

export type SubmitAssembledResult = {
  hash: string;
  status: "SUCCESS";
};

export async function submitWithBundler(
  params: SubmitAssembledParams
): Promise<SubmitAssembledResult> {
  const {
    server,
    networkPassphrase,
    bundlerSecret,
    txWithAuth,
    pollAttempts = 30,
  } = params;

  const enforcingSim = await server.simulateTransaction(txWithAuth);

  if (rpc.Api.isSimulationError(enforcingSim)) {
    throw new Error(`Auth validation failed: ${enforcingSim.error}`);
  }

  const assembledTx = rpc.assembleTransaction(txWithAuth, enforcingSim).build();
  const bundlerKeypair = Keypair.fromSecret(bundlerSecret);
  await getBundlerAccount(server, bundlerKeypair);
  assembledTx.sign(bundlerKeypair);

  const sendResult = await server.sendTransaction(assembledTx);
  if (sendResult.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${sendResult.errorResult?.toXDR("base64")}`
    );
  }

  const txHash = sendResult.hash;
  let txResult: rpc.Api.GetTransactionResponse | undefined;

  for (let i = 0; i < pollAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    txResult = await server.getTransaction(txHash);
    if (txResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      break;
    }
  }

  if (txResult?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return { hash: txHash, status: "SUCCESS" };
  }

  throw new Error(`Transaction failed: ${txResult?.status ?? "UNKNOWN"}`);
}

export function rebuildTxWithAuthEntries(
  tx: Transaction,
  networkPassphrase: string,
  authEntries: xdr.SorobanAuthorizationEntry[]
): Transaction {
  const env = tx.toEnvelope();
  if (env.switch().name !== "envelopeTypeTx") {
    throw new Error("Expected a v1 transaction envelope");
  }
  const txExt = env.v1().tx().ext();
  if (txExt.switch() === 0) {
    throw new Error(
      "Transaction is missing Soroban resource data. Rebuild the transaction."
    );
  }
  const sorobanData = txExt.value() as xdr.SorobanTransactionData;
  const origOp = tx.operations[0] as Operation.InvokeHostFunction;
  const tb = TransactionBuilder.cloneFrom(tx, {
    fee: tx.fee,
    sorobanData,
    networkPassphrase,
  });
  tb.clearOperations();
  tb.addOperation(
    Operation.invokeHostFunction({
      source: origOp.source,
      func: origOp.func,
      auth: authEntries,
    })
  );
  return tb.build();
}
