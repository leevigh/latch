import {
  Account,
  Address,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { ApiRequestError } from "@/lib/api-errors";

/**
 * External dApps must send invoke ops without auth entries. If auth is already
 * attached, Soroban simulates in enforcing mode and fails before signatures exist.
 */
export function stripInvokeAuthEntries(
  tx: Transaction,
  networkPassphrase: string
): Transaction {
  const invokeOps = getInvokeHostFunctionOps(tx);
  const hasAuth = invokeOps.some((op) => (op.auth?.length ?? 0) > 0);
  if (!hasAuth) return tx;

  const builder = new TransactionBuilder(new Account(tx.source, tx.sequence), {
    fee: tx.fee,
    networkPassphrase,
  });

  if (tx.timeBounds) {
    builder.setTimebounds(
      Number(tx.timeBounds.minTime),
      Number(tx.timeBounds.maxTime)
    );
  }

  for (const op of tx.operations) {
    if (op.type === "invokeHostFunction") {
      const invoke = op as Operation.InvokeHostFunction;
      builder.addOperation(
        Operation.invokeHostFunction({
          source: invoke.source,
          func: invoke.func,
          auth: [],
        })
      );
    } else {
      builder.addOperation(op);
    }
  }

  return builder.build();
}

export function parseExternalTransaction(
  unsignedTxXdr: string,
  networkPassphrase: string
): Transaction {
  try {
    return TransactionBuilder.fromXDR(unsignedTxXdr, networkPassphrase) as Transaction;
  } catch {
    throw new ApiRequestError("invalid_xdr", "Cannot parse transaction XDR.");
  }
}

export function getInvokeHostFunctionOps(
  tx: Transaction
): Operation.InvokeHostFunction[] {
  return tx.operations.filter(
    (op): op is Operation.InvokeHostFunction => op.type === "invokeHostFunction"
  );
}

/** Contract id (`C...`) from the first Soroban invoke op, if any. */
export function extractTargetContractId(tx: Transaction): string | null {
  const ops = getInvokeHostFunctionOps(tx);
  if (ops.length === 0) return null;

  const func = ops[0].func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") return null;

  try {
    return Address.fromScAddress(func.invokeContract().contractAddress()).toString();
  } catch {
    return null;
  }
}

/**
 * True when the first invoke targets the smart account itself (admin ops such as
 * `add_context_rule`). These use the Default context rule, not CallContract(SAC).
 */
export function isSmartAccountSelfInvoke(
  targetContractId: string,
  smartAccountAddress: string
): boolean {
  return targetContractId === smartAccountAddress;
}

/**
 * Pre-simulation binding check: invoke source matches smart account, or the
 * smart account contract is the invoke target (ops on the account itself).
 */
export function preValidateSmartAccountBinding(
  tx: Transaction,
  smartAccountAddress: string
): void {
  const ops = getInvokeHostFunctionOps(tx);
  if (ops.length === 0) {
    throw new ApiRequestError(
      "unsupported_tx",
      "Transaction has no Soroban invoke operations."
    );
  }

  for (const op of ops) {
    if (op.source === smartAccountAddress) return;

    const func = op.func;
    if (func.switch().name === "hostFunctionTypeInvokeContract") {
      const contractId = Address.fromScAddress(
        func.invokeContract().contractAddress()
      ).toString();
      if (contractId === smartAccountAddress) return;
    }
  }
}

export function assertPostSimAccountBinding(
  hasSmartAccountAuthEntry: boolean,
  tx: Transaction,
  smartAccountAddress: string
): void {
  if (hasSmartAccountAuthEntry) return;

  for (const op of getInvokeHostFunctionOps(tx)) {
    if (op.source === smartAccountAddress) return;
  }

  throw new ApiRequestError(
    "account_mismatch",
    `Transaction does not require authorization from ${smartAccountAddress}.`
  );
}

/** Read function name from an invoke-host-function op. */
export function invokeFunctionName(op: Operation.InvokeHostFunction): string | null {
  const func = op.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") return null;
  const nameBuf = func.invokeContract().functionName();
  return typeof nameBuf === "string"
    ? nameBuf
    : Buffer.from(nameBuf).toString("utf8");
}

/** Invoke contract args as ScVal array. */
export function invokeFunctionArgs(
  op: Operation.InvokeHostFunction
): xdr.ScVal[] {
  const func = op.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") return [];
  return func.invokeContract().args();
}
