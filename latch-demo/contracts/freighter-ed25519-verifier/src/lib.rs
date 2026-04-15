#![no_std]
use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};
use stellar_accounts::verifiers::Verifier;

/// Freighter `signMessage` scheme (per Freighter docs) signs:
///   ed25519_sign( sha256("Stellar Signed Message:\n" + message) )
///
/// In this app we set `message` to hex(signature_payload) where signature_payload is the 32-byte auth digest.
const FREIGHTER_PREFIX: &[u8] = b"Stellar Signed Message:\n";

#[contract]
pub struct FreighterEd25519Verifier;

#[contractimpl]
impl Verifier for FreighterEd25519Verifier {
    type KeyData = Bytes; // 32-byte Ed25519 public key bytes
    type SigData = Bytes; // 64-byte Ed25519 signature bytes

    fn verify(e: &Env, signature_payload: Bytes, key_data: Self::KeyData, sig_data: Self::SigData) -> bool {
        if signature_payload.len() != 32 {
            panic!("signature_payload must be 32 bytes");
        }
        if key_data.len() != 32 {
            panic!("key_data must be 32 bytes");
        }
        if sig_data.len() != 64 {
            panic!("sig_data must be 64 bytes");
        }

        let pk: BytesN<32> = key_data
            .try_into()
            .unwrap_or_else(|_| panic!("failed to convert key_data"));
        let sig: BytesN<64> = sig_data
            .try_into()
            .unwrap_or_else(|_| panic!("failed to convert sig_data"));

        // message = hex(signature_payload) lowercase
        let payload = signature_payload.to_buffer::<32>();
        let mut hex = [0u8; 64];
        hex_encode(&mut hex, payload.as_slice());

        // preimage = FREIGHTER_PREFIX + message
        let mut preimage = Bytes::from_slice(e, FREIGHTER_PREFIX);
        preimage.append(&Bytes::from_slice(e, &hex));

        let hashed = e.crypto().sha256(&preimage);
        e.crypto().ed25519_verify(&pk, &hashed, &sig)
    }
}

fn hex_encode(out: &mut [u8; 64], input: &[u8]) {
    const LUT: &[u8; 16] = b"0123456789abcdef";
    let mut i = 0usize;
    while i < 32 {
        let b = input[i];
        out[i * 2] = LUT[(b >> 4) as usize];
        out[i * 2 + 1] = LUT[(b & 0x0f) as usize];
        i += 1;
    }
}

