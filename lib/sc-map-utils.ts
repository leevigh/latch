import { xdr } from "@stellar/stellar-sdk";

/** Soroban ScMap keys must be lexicographically sorted by XDR bytes. */
export function sortScMapEntries(entries: xdr.ScMapEntry[]): xdr.ScMapEntry[] {
  return [...entries].sort((a, b) =>
    Buffer.from(a.key().toXDR()).compare(Buffer.from(b.key().toXDR()))
  );
}
