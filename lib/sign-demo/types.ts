export type Network = "testnet" | "mainnet";
export type DemoAction = "noop" | "transfer";

export interface BuildSignDemoRequest {
  network: Network;
  smartAccountAddress: string;
  demoAction: DemoAction;
  recipient?: string;
  amount?: string;
  assetId?: string;
}

export interface BuildSignDemoResponse {
  unsignedTxXdr: string;
  description: string;
  network: Network;
  smartAccountAddress: string;
}

/** Go latch-backend build-send request (Section B2). */
export interface BuildSendRemoteRequest {
  smartAccountAddress: string;
  signerType: "passkey" | "phantom" | "freighter";
  recipient: string;
  amount: string;
  assetId?: string;
  contractId?: string;
  signerG?: string;
  publicKeyHex?: string;
  keyDataHex?: string;
}

export interface BuildSendRemoteResponse {
  txXdr?: string;
  authEntryXdr?: string;
  authDigestHex?: string;
  contextRuleId?: number | string;
  validUntilLedger?: number;
  estimatedFeeXlm?: string;
  [key: string]: unknown;
}

export interface PrepareSignRequest {
  network: Network;
  smartAccountAddress: string;
  unsignedTxXdr: string;
  signerType?: "passkey" | "phantom" | "freighter";
  signerG?: string;
}

export interface PreparedSignOperation {
  type: string;
  summary: string;
  details?: Record<string, string>;
}

export interface PrepareSignResponse {
  network: Network;
  smartAccountAddress: string;
  txXdr: string;
  authEntryXdr: string;
  authDigestHex: string;
  contextRuleId: number | string;
  validUntilLedger: number;
  estimatedFeeXlm?: string;
  estimatedFeeUsd?: string;
  feeLabel?: string;
  operations: PreparedSignOperation[];
  warnings?: string[];
  smartAccountAuthEntryXdr?: string;
  gAddressEntryTemplateXdr?: string;
  [key: string]: unknown;
}

export interface SignPayloadStoreRequest {
  network: Network;
  smartAccountAddress: string;
  unsignedTxXdr: string;
  callback: string;
  requestId?: string;
  origin?: string;
  submit?: boolean;
  ttlSeconds?: number;
}

export interface SignPayloadStoreResponse {
  payloadRef: string;
  expiresAt: string;
}

export type SignCallbackStatus = "signed" | "rejected" | "error";

export interface SignTransactionRequest {
  xdr: string;
  network: Network;
  accountToSign: string;
  /**
   * When false, the extension may return signed auth material instead of
   * submitting. The dApp can then submit via backend submit endpoints.
   */
  submit?: boolean;
}

export interface SignTransactionResponse {
  txHash?: string;
  signedAuthEntry?: string;
  signedTxXdr?: string;
  /** @deprecated Prefer txHash when wallet submits */
  signedXdr?: string;
}

export interface OpenSignRequestParams {
  network: Network;
  account: string;
  callback: string;
  requestId: string;
  xdr?: string;
  payloadRef?: string;
  submit?: boolean;
  origin?: string;
}

export interface SignCallbackResult {
  requestId?: string;
  status: SignCallbackStatus;
  txHash?: string;
  network?: string;
  code?: string;
  message?: string;
  signedAuthEntry?: string;
  /** Present when the wallet used submit=false; a submit-ready signed tx envelope. */
  signedTxXdr?: string;
}

export type WalletConnectionStatus =
  | "disconnected"
  | "no_extension"
  | "connecting"
  | "connected"
  | "error";

export interface WalletConnectionState {
  status: WalletConnectionStatus;
  publicKey: string | null;
  network: Network | null;
  origin: string;
  error: string | null;
  connectedAt: string | null;
}
