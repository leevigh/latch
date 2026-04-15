declare module "@stellar/stellar-base/lib/auth" {
  export function authorizeInvocation(
    signer:
      | ((preimage: any) => Promise<{ signature: Uint8Array | Buffer; publicKey: string }>)
      | ((preimage: any) => Promise<Uint8Array | Buffer>),
    validUntilLedgerSeq: number,
    invocation: any,
    publicKey?: string,
    networkPassphrase?: string
  ): Promise<any>;
}

