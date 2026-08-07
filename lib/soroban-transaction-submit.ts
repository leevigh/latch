import { Keypair, Operation, rpc, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { getBundlerAccount } from "@/lib/soroban-bundler";

function decodeTxResultError(errorResult: xdr.TransactionResult | undefined): string {
  if (!errorResult) return "unknown error";
  try {
    const result = errorResult.result();
    const name = result.switch().name;
    if (name === "txBadSeq") {
      return "tx_bad_seq (bundler account sequence was stale; retry submit)";
    }
    return name;
  } catch {
    return errorResult.toXDR("base64");
  }
}

export async function refreshBundlerSequence(
  server: rpc.Server,
  tx: Transaction,
  networkPassphrase: string,
  bundlerSecret: string
): Promise<Transaction> {
  const bundlerKeypair = Keypair.fromSecret(bundlerSecret);
  const freshAccount = await getBundlerAccount(server, bundlerKeypair);
  return TransactionBuilder.cloneFrom(tx, {
    fee: tx.fee,
    networkPassphrase,
    account: freshAccount,
  }).build();
}

export type SubmitAssembledParams = {
  server: rpc.Server;
  networkPassphrase: string;
  bundlerSecret: string;
  txWithAuth: Transaction;
  /** Max poll attempts after send (default 20). */
  pollAttempts?: number;
  /** Ms between getTransaction polls (default 500). */
  pollIntervalMs?: number;
  /**
   * Max times to re-fetch the bundler sequence and re-assemble/re-sign when the
   * network rejects the send with tx_bad_seq (default 3).
   */
  badSeqRetries?: number;
};

/** True when an RPC send failure was caused by a stale source-account sequence. */
function isBadSeqError(errorResult: xdr.TransactionResult | undefined): boolean {
  if (!errorResult) return false;
  try {
    return errorResult.result().switch().name === "txBadSeq";
  } catch {
    return false;
  }
}

export type SubmitAssembledResult = {
  hash: string;
  status: "SUCCESS" | "PENDING";
};

/**
 * Refresh sequence, enforcing-simulate, assemble, and fee-payer sign with the
 * bundler — but do NOT broadcast. Returns the submit-ready signed transaction
 * so a caller (e.g. a dApp) can send it via RPC itself (submit=false flow).
 */
export async function assembleSignedTxWithBundler(params: {
  server: rpc.Server;
  networkPassphrase: string;
  bundlerSecret: string;
  txWithAuth: Transaction;
}): Promise<{ signedTxXdr: string; hash: string }> {
  const { server, networkPassphrase, bundlerSecret, txWithAuth } = params;
  const bundlerKeypair = Keypair.fromSecret(bundlerSecret);

  const txFresh = await refreshBundlerSequence(
    server,
    txWithAuth,
    networkPassphrase,
    bundlerSecret
  );

  const enforcingSim = await server.simulateTransaction(txFresh);

  if (rpc.Api.isSimulationError(enforcingSim)) {
    const simError = enforcingSim.error ?? "";
    if (simError.includes("#3014") || simError.includes("InvalidAction")) {
      throw new Error(
        `Auth validation failed: Smart account rejected this swap authorization. Ensure swap context rule signers match your login method (passkey vs Freighter). (${simError})`
      );
    }
    throw new Error(`Auth validation failed: ${simError}`);
  }

  const assembledTx = rpc.assembleTransaction(txFresh, enforcingSim).build();
  await getBundlerAccount(server, bundlerKeypair);
  assembledTx.sign(bundlerKeypair);

  return {
    signedTxXdr: assembledTx.toXDR(),
    hash: assembledTx.hash().toString("hex"),
  };
}

export async function submitWithBundler(
  params: SubmitAssembledParams
): Promise<SubmitAssembledResult> {
  const {
    server,
    networkPassphrase,
    bundlerSecret,
    txWithAuth,
    pollAttempts = 20,
    pollIntervalMs = 500,
    badSeqRetries = 3,
  } = params;

  // Assemble + fee-payer sign with a fresh bundler sequence, then broadcast.
  // The bundler sequence can advance between assembly and broadcast (concurrent
  // submits, a prior in-flight tx). On tx_bad_seq we re-fetch the sequence and
  // re-assemble/re-sign before failing, since the signed sequence is immutable.
  let sendResult: Awaited<ReturnType<typeof server.sendTransaction>> | undefined;
  for (let attempt = 0; attempt <= badSeqRetries; attempt++) {
    const { signedTxXdr } = await assembleSignedTxWithBundler({
      server,
      networkPassphrase,
      bundlerSecret,
      txWithAuth,
    });
    const assembledTx = TransactionBuilder.fromXDR(
      signedTxXdr,
      networkPassphrase
    ) as Transaction;

    sendResult = await server.sendTransaction(assembledTx);
    if (sendResult.status !== "ERROR") break;

    if (isBadSeqError(sendResult.errorResult) && attempt < badSeqRetries) {
      // Brief backoff so any in-flight bundler tx settles before we re-fetch seq.
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      continue;
    }

    throw new Error(
      `Transaction submission failed: ${decodeTxResultError(sendResult.errorResult)}`
    );
  }

  if (!sendResult || sendResult.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${decodeTxResultError(sendResult?.errorResult)}`
    );
  }

  const txHash = sendResult.hash;
  let txResult: rpc.Api.GetTransactionResponse | undefined;

  for (let i = 0; i < pollAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    txResult = await server.getTransaction(txHash);
    if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: txHash, status: "SUCCESS" };
    }
    if (txResult.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${txResult.status}`);
    }
    if (txResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      break;
    }
  }

  if (txResult?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return { hash: txHash, status: "SUCCESS" };
  }

  // Submitted to the network; confirmation may still be in flight (client can poll Horizon).
  return { hash: txHash, status: "PENDING" };
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
