export type OnRampIntentStatus = "created" | "pending" | "completed" | "failed";

export type CreateOnRampSessionRequest = {
  destinationCAddress: string;
  fiatAmount?: string;
  fiatCode?: string;
};

export type CreateOnRampSessionResponse = {
  intentId: string;
  memoId: string;
  destinationCAddress: string;
  poolAddress: string;
  fiatAmount: string;
  fiatCode: string;
  /** platform = headless Platform API + SDK; widget = signed buy.moonpay.com URL */
  integrationMode: "platform" | "widget";
  sessionToken?: string;
  widgetUrl?: string;
};

export type OnRampIntentResponse = {
  id: string;
  memoId: string;
  destinationCAddress: string;
  status: OnRampIntentStatus;
  moonpayTransactionId: string | null;
  fiatAmount: string;
  fiatCode: string;
  moonpayTransactionStatus?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdateOnRampIntentRequest = {
  status?: OnRampIntentStatus;
  moonpayTransactionId?: string;
};

export type PoolSnapshotResponse = {
  poolAddress: string;
  network: "testnet";
  xlmBalance: string;
  recentTransactions: Array<{
    transactionId: string;
    createdAt: string;
    memo: string | null;
    memoType: string;
    successful: boolean;
  }>;
};
