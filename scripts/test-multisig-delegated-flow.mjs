#!/usr/bin/env node
/**
 * E2E: 2-of-2 multisig using Delegated(G) signers only (no browser needed).
 *
 * Flow:
 * 1) Generate two test G-accounts and friendbot-fund them
 * 2) Deploy multisig smart account via factory (2 delegated signers, threshold=2)
 * 3) Register multisig metadata in DB (/api/multisig/accounts/register)
 * 4) Create a proposal to call counter.increment(smartAccount)
 * 5) For each signer:
 *    - Begin delegated approval -> get preimage + entry template
 *    - Sign payload hash locally with the signer keypair
 *    - Finish delegated approval -> store signature
 * 6) Execute proposal -> bundler submits tx
 *
 * Requires:
 * - NEXT_PUBLIC_FACTORY_ADDRESS, BUNDLER_SECRET in env (server)
 * - NEXT_PUBLIC_COUNTER_ADDRESS in env (or uses default in app/api/transaction/build/route.ts)
 * - Next.js app running locally (LATCH_API_BASE) OR deployed base URL
 */

import StellarSdk from "@stellar/stellar-sdk";

const { Keypair, hash, xdr, Networks } = StellarSdk;

const BASE = process.env.LATCH_API_BASE || "http://localhost:3000";
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
const COUNTER_ADDRESS =
  process.env.NEXT_PUBLIC_COUNTER_ADDRESS ||
  "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U";

async function friendbotFund(g) {
  const res = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(g)}`
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Friendbot failed: ${res.status} ${t}`);
  }
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${data.error ?? JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log("API base:", BASE);
  console.log("Counter:", COUNTER_ADDRESS);

  // 1) Create signers
  const s1 = Keypair.random();
  const s2 = Keypair.random();
  console.log("Signer1:", s1.publicKey());
  console.log("Signer2:", s2.publicKey());

  await friendbotFund(s1.publicKey());
  await friendbotFund(s2.publicKey());
  console.log("Funded signers via friendbot.");

  // 2) Draft + deploy multisig
  const draft = await postJson("/api/multisig/accounts/draft", {
    threshold: 2,
    signers: [
      { type: "delegated", gAddress: s1.publicKey(), label: "s1" },
      { type: "delegated", gAddress: s2.publicKey(), label: "s2" },
    ],
  });
  console.log("Predicted multisig:", draft.smartAccountAddress);

  const deploy = await postJson("/api/multisig/accounts/deploy", {
    threshold: 2,
    accountSaltHex: draft.accountSaltHex,
    signers: draft.signers,
  });
  console.log("Deployed multisig:", deploy.smartAccountAddress, "already:", deploy.alreadyDeployed);

  // 3) Register in DB (for proposal service)
  const reg = await postJson("/api/multisig/accounts/register", {
    smartAccountAddress: deploy.smartAccountAddress,
    threshold: 2,
    accountSaltHex: draft.accountSaltHex,
    members: draft.signers.map((s) => (s.type === "delegated" ? { type: "delegated", gAddress: s.gAddress } : s)),
  });
  const acct = reg.multisigAccount;
  console.log("Registered multisig id:", acct.id);

  const delegatedMembers = acct.members.filter((m) => m.memberType === "delegated");
  if (delegatedMembers.length !== 2) throw new Error("Expected 2 delegated members");

  // 4) Create proposal (counter increment)
  const proposalRes = await postJson("/api/multisig/proposals", {
    smartAccountAddress: deploy.smartAccountAddress,
    operationKind: "counter_increment",
    operationParams: {},
    targetContractId: COUNTER_ADDRESS,
    requireMatchedContextRule: false,
  });
  const proposalId = proposalRes.proposal.id;
  console.log("Created proposal:", proposalId);

  // 5) Approve with both signers
  const signerKeypairs = new Map([
    [s1.publicKey(), s1],
    [s2.publicKey(), s2],
  ]);

  for (const member of delegatedMembers) {
    const g = member.gAddress;
    const kp = signerKeypairs.get(g);
    if (!kp) throw new Error(`Missing keypair for ${g}`);

    const begin = await postJson(`/api/multisig/proposals/${proposalId}/approve/delegated/begin`, {
      memberId: member.id,
    });

    const entry = xdr.SorobanAuthorizationEntry.fromXDR(begin.gAddressEntryTemplateXdr, "base64");
    const preimage = xdr.HashIdPreimage.fromXDR(begin.gAddressPreimageXdr, "base64");
    const payloadHash = hash(preimage.toXDR());

    // Signature is ed25519 over 32-byte payload hash
    const sig = kp.sign(payloadHash);
    const signedAuthEntryBase64 = Buffer.from(sig).toString("base64");

    await postJson(`/api/multisig/proposals/${proposalId}/approve/delegated/finish`, {
      memberId: member.id,
      signedAuthEntryBase64,
      signerAddress: g,
    });
    console.log("Approved delegated:", g);
  }

  // 6) Execute
  const execRes = await postJson(`/api/multisig/proposals/${proposalId}/execute`, {});
  console.log("Executed tx:", execRes.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

