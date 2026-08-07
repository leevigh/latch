import {
  Address,
  Keypair,
  StrKey,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  addressStringFromCredentials,
  isUnsignedAddressAuthEntry,
} from "@/lib/soroban-auth-entries";
import { delegatedCheckAuthArgHex } from "@/lib/delegated-check-auth-entry";

/** True when entry authorizes smartAccount.__check_auth via an unsigned G-address credential. */
export function isBundlerDelegatedCheckAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  bundlerPublicKey: string
): boolean {
  const addr = addressStringFromCredentials(entry);
  if (addr !== bundlerPublicKey) return false;
  if (!delegatedCheckAuthArgHex(entry)) return false;
  return isUnsignedAddressAuthEntry(entry);
}

/**
 * Server-side sign a synthesized bundler delegated `__check_auth` auth entry
 * (same Ed25519 preimage as Freighter signAuthEntry).
 */
export function signBundlerDelegatedAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  bundlerKeypair: Keypair,
  networkPassphrase: string
): xdr.SorobanAuthorizationEntry {
  const addrAuth = entry.credentials().address();
  const signerAddress = Address.fromScAddress(addrAuth.address()).toString();

  if (signerAddress !== bundlerKeypair.publicKey()) {
    throw new Error(
      `Delegated auth entry signer ${signerAddress} does not match bundler ${bundlerKeypair.publicKey()}`
    );
  }

  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: addrAuth.nonce(),
      signatureExpirationLedger: addrAuth.signatureExpirationLedger(),
      invocation: entry.rootInvocation(),
    })
  );
  const payload = hash(preimage.toXDR());
  const signature = bundlerKeypair.sign(payload);

  const pubkeyBytes = StrKey.decodeEd25519PublicKey(signerAddress);
  const sigScVal = nativeToScVal(
    {
      public_key: pubkeyBytes,
      signature: signature,
    },
    {
      type: {
        public_key: ["symbol", null],
        signature: ["symbol", null],
      },
    }
  );

  const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR(), "base64");
  signed.credentials().address().signature(xdr.ScVal.scvVec([sigScVal]));
  return signed;
}
