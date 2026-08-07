import "server-only";

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const HORIZON_MAINNET = "https://horizon.stellar.org";

type HorizonBalance = {
  balance: string;
  asset_type: string;
  asset_code?: string;
};

type HorizonAccount = {
  id: string;
  balances: HorizonBalance[];
};

type HorizonTransaction = {
  id: string;
  successful: boolean;
  created_at: string;
  memo?: string;
  memo_type: string;
};

export type PoolPaymentRecord = {
  transactionId: string;
  createdAt: string;
  memo: string | null;
  memoType: string;
  successful: boolean;
};

export type PoolAccountSnapshot = {
  poolAddress: string;
  network: "testnet" | "mainnet";
  xlmBalance: string;
  recentTransactions: PoolPaymentRecord[];
};

function horizonBase(network: "testnet" | "mainnet"): string {
  return network === "testnet" ? HORIZON_TESTNET : HORIZON_MAINNET;
}

async function horizonGet<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { next: { revalidate: 0 } });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Horizon request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchPoolAccountSnapshot(params: {
  poolAddress: string;
  network: "testnet" | "mainnet";
  memoFilter?: string;
}): Promise<PoolAccountSnapshot> {
  const base = horizonBase(params.network);
  const account = await horizonGet<HorizonAccount>(
    `${base}/accounts/${encodeURIComponent(params.poolAddress)}`
  );

  const native = account?.balances.find((b) => b.asset_type === "native");
  const xlmBalance = native?.balance ?? "0";

  if (!account) {
    return {
      poolAddress: params.poolAddress,
      network: params.network,
      xlmBalance,
      recentTransactions: [],
    };
  }

  const txPage = await horizonGet<{
    _embedded: { records: HorizonTransaction[] };
  }>(
    `${base}/accounts/${encodeURIComponent(params.poolAddress)}/transactions?order=desc&limit=20`
  );

  let recentTransactions = (txPage?._embedded.records ?? []).map((tx) => ({
    transactionId: tx.id,
    createdAt: tx.created_at,
    memo: tx.memo_type === "none" ? null : tx.memo ?? null,
    memoType: tx.memo_type,
    successful: tx.successful,
  }));

  if (params.memoFilter) {
    recentTransactions = recentTransactions.filter(
      (tx) => tx.memo === params.memoFilter
    );
  }

  return {
    poolAddress: params.poolAddress,
    network: params.network,
    xlmBalance,
    recentTransactions,
  };
}
