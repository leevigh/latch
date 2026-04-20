import { isAllowed, setAllowed, getAddress, isConnected as isFreighterConnected } from "@stellar/freighter-api";
import { isConnected as isLobstrConnected, getPublicKey as getLobstrPublicKey } from "@lobstrco/signer-extension-api";
import bs58 from "bs58";
import { StrKey } from "@stellar/stellar-sdk";

export type WalletType = "phantom" | "freighter" | "lobstr";

export interface WalletConnectionResult {
  publicKeyHex: string;
  gAddress: string;
  walletType: WalletType;
}

/**
 * Derives hex and standard Stellar G-address from a Phantom base58 string.
 */
export function deriveKeysFromPhantom(phantomPubkeyBase58: string): { hex: string, gAddress: string } {
    const pubkeyBytes = bs58.decode(phantomPubkeyBase58);
    const pubkeyHex = Buffer.from(pubkeyBytes).toString("hex");
    const gAddress = StrKey.encodeEd25519PublicKey(Buffer.from(pubkeyBytes));
    return { hex: pubkeyHex, gAddress };
}

/**
 * Derives hex from standard Stellar G-address.
 */
export function deriveKeysFromStellar(stellarPubkeyG: string): { hex: string, gAddress: string } {
    const pubkeyBytes = StrKey.decodeEd25519PublicKey(stellarPubkeyG);
    const pubkeyHex = Buffer.from(pubkeyBytes).toString("hex");
    return { hex: pubkeyHex, gAddress: stellarPubkeyG };
}

export async function connectPhantom(): Promise<WalletConnectionResult> {
    if (typeof window === "undefined") throw new Error("Window not available");
    const provider = (window as any).phantom?.solana;
    if (!provider?.isPhantom) {
      throw new Error("Phantom wallet not found. Please install the Phantom extension.");
    }

    const response = await provider.connect();
    const pubkey = response.publicKey || provider.publicKey;
    if (!pubkey) throw new Error("Failed to get public key from Phantom");

    const base58Str = pubkey.toString();
    const { hex, gAddress } = deriveKeysFromPhantom(base58Str);

    return { publicKeyHex: hex, gAddress, walletType: "phantom" };
}

export async function connectFreighter(): Promise<WalletConnectionResult> {
    const { isConnected, error: connErr } = await isFreighterConnected();
    if (connErr) throw new Error(`Freighter error: ${connErr.message}`);
    if (!isConnected) throw new Error("Freighter wallet not found. Please install the Freighter extension.");

    // Request permissions if not already allowed
    const { isAllowed: allowed } = await isAllowed();
    if (!allowed) {
      await setAllowed();
    }

    const { address, error: addrErr } = await getAddress();
    if (addrErr) throw new Error(`Freighter error: ${addrErr.message}`);
    if (!address) throw new Error("Freighter did not return a public key.");

    const { hex, gAddress } = deriveKeysFromStellar(address);
    return { publicKeyHex: hex, gAddress, walletType: "freighter" };
}

export async function connectLobstr(): Promise<WalletConnectionResult> {
    // Lobstr exposes a similar global but usually accessed via @lobstrco/signer-extension-api directly
    const isConn = await isLobstrConnected();
    if (!isConn) {
        throw new Error("Lobstr extension not found. Please install the Lobstr extension.");
    }
    const publicKey = await getLobstrPublicKey();
    if (!publicKey) throw new Error("Lobstr did not return a public key.");
    
    const { hex, gAddress } = deriveKeysFromStellar(publicKey);
    return { publicKeyHex: hex, gAddress, walletType: "lobstr" };
}

export async function connectWallet(type: WalletType): Promise<WalletConnectionResult> {
    switch (type) {
        case "phantom": return connectPhantom();
        case "freighter": return connectFreighter();
        case "lobstr": return connectLobstr();
        default: throw new Error(`Unknown wallet type: ${type}`);
    }
}
