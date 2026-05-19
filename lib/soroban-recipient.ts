import { Address, StrKey } from "@stellar/stellar-sdk";

export function parseRecipientAddress(recipient: string): Address {
  const trimmed = recipient.trim();
  if (StrKey.isValidEd25519PublicKey(trimmed)) {
    return new Address(trimmed);
  }
  if (StrKey.isValidContract(trimmed)) {
    return new Address(trimmed);
  }
  throw new Error("recipient must be a valid G-address or C-address (contract)");
}
