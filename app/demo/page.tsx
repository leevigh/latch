"use client";

import { useState, useCallback, useEffect } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import bs58 from "bs58"; // Import base58 decoder

// Helper to get Phantom provider
const getPhantomProvider = () => {
  if (typeof window === "undefined") return null;
  const provider = (window as any).phantom?.solana;
  if (provider?.isPhantom) return provider;
  return null;
};

type DemoState =
  | "disconnected"
  | "connecting"
  | "deploying"
  | "ready"
  | "building"
  | "signing"
  | "submitting"
  | "success"
  | "error";

export default function DemoPage() {
  const [state, setState] = useState<DemoState>("disconnected");
  const [phantomPubkey, setPhantomPubkey] = useState<string | null>(null);
  const [phantomPubkeyHex, setPhantomPubkeyHex] = useState<string | null>(null);
  const [smartAccountAddress, setSmartAccountAddress] = useState<string | null>(null);
  const [gAddress, setGAddress] = useState<string | null>(null);  // User's Stellar G-address
  const [error, setError] = useState<string | null>(null);
  const [counterValue, setCounterValue] = useState<number | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isPhantomAvailable, setIsPhantomAvailable] = useState(false);

  // Check if Phantom is available (only on client)
  useEffect(() => {
    // We can check if window.solana is present, or just let strict 'injected' provider handle it.
    // For UI feedback, checking window.phantom?.solana or similar is still useful.
    const checkPhantom = async () => {
      // Small delay to allow injection
      await new Promise(r => setTimeout(r, 500));
      const available = !!(window as any)?.phantom?.solana?.isPhantom;
      setIsPhantomAvailable(available);
    };
    checkPhantom();
  }, []);

  // Connect to Phantom and deploy smart account
  const connectAndDeploy = useCallback(async () => {
    setState("connecting");
    setError(null);

    try {
      // Get Phantom provider directly
      const provider = getPhantomProvider();
      if (!provider) {
        throw new Error("Phantom wallet not found. Please install Phantom extension.");
      }

      // Connect to Phantom
      const response = await provider.connect();
      const pubkey = response.publicKey || provider.publicKey;

      if (!pubkey) {
        throw new Error("Failed to get public key from Phantom");
      }

      // Convert Base58 pubkey to Hex
      const pubkeyBase58 = pubkey.toString();
      const pubkeyBytes = bs58.decode(pubkeyBase58);
      const pubkeyHex = Buffer.from(pubkeyBytes).toString("hex");

      setPhantomPubkey(pubkeyBase58);
      setPhantomPubkeyHex(pubkeyHex);

      console.log("Phantom connected:", pubkeyBase58);
      console.log("Pubkey hex:", pubkeyHex);

      // Deploy/get smart account for this user
      setState("deploying");

      const deployResponse = await fetch("/api/smart-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyHex: pubkeyHex }),
      });

      if (!deployResponse.ok) {
        const errorData = await deployResponse.json();
        console.error("Deploy error details:", errorData);
        throw new Error(errorData.error || "Failed to deploy smart account");
      }

      const { smartAccountAddress: addr, gAddress: userGAddress, alreadyDeployed } = await deployResponse.json();
      setSmartAccountAddress(addr);
      setGAddress(userGAddress);

      console.log(
        alreadyDeployed
          ? `Smart account already exists: ${addr}`
          : `Deployed new smart account: ${addr}`
      );
      console.log(`User G-address: ${userGAddress}`);

      setState("ready");
    } catch (err) {
      console.error("Connection error:", err);
      setState("error");
      setError(err instanceof Error ? err.message : "Failed to connect");
    }
  }, []);

  // Execute transaction via smart account
  const runDemo = useCallback(async () => {
    if (!phantomPubkeyHex || !smartAccountAddress) {
      setError("Connect Phantom first");
      return;
    }

    setState("building");
    setError(null);

    try {
      // Step 1: Build and simulate the transaction via API
      console.log("Building transaction...");
      const buildResponse = await fetch("/api/transaction/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smartAccountAddress }),
      });

      if (!buildResponse.ok) {
        const errorData = await buildResponse.json();
        throw new Error(errorData.error || "Failed to build transaction");
      }

      const { txXdr, authEntryXdr, authDigestHex, validUntilLedger } =
        await buildResponse.json();

      console.log("Auth digest hex:", authDigestHex);
      console.log("Valid until ledger:", validUntilLedger);

      // Step 2: Sign auth payload with Phantom (using direct provider)
      setState("signing");
      console.log("Requesting Phantom signature for smart account authorization...");

      const provider = getPhantomProvider();
      if (!provider) {
        throw new Error("Phantom wallet not connected");
      }

      // Phantom blocks raw 32-byte messages (look like Solana tx hashes)
      // We need to prefix with human-readable text
      // NOTE: The on-chain smart account verifier MUST expect this same format
      const AUTH_PREFIX = "Stellar Smart Account Auth:\n";

      // Sign the auth payload hash (for smart account authorization)
      console.log("Signing auth payload...");
      const prefixedMessage = AUTH_PREFIX + String(authDigestHex).toLowerCase();
      const authMessage = new TextEncoder().encode(prefixedMessage);
      // Phantom requires the display encoding; omitting it can change what gets signed vs shown.
      const authSignResult = await provider.signMessage(authMessage, "utf8");

      console.log("Auth signature result:", authSignResult);
      const authSignatureHex = Buffer.from(authSignResult.signature).toString("hex");
      console.log("Auth signature hex:", authSignatureHex);

      console.log("Note: Signature is over prefixed message, not raw hash");
      console.log("Note: Bundler will sign transaction envelope server-side");
      console.log("Note: Prefixed message is passed to verifier for validation (no on-chain hex conversion)");

      // Step 3: Submit the transaction via API
      setState("submitting");
      console.log("Submitting transaction...");

      const submitResponse = await fetch("/api/transaction/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txXdr,
          authEntryXdr,
          authSignatureHex,
          prefixedMessage,  // Pass the full message that was signed
          publicKeyHex: phantomPubkeyHex,
        }),
      });

      if (!submitResponse.ok) {
        const errorData = await submitResponse.json();
        throw new Error(errorData.error || "Failed to submit transaction");
      }

      const { hash } = await submitResponse.json();
      console.log("Transaction successful:", hash);

      // Success!
      setState("success");
      setTxHash(hash);

      // Fetch updated counter value
      const counterResponse = await fetch("/api/counter");
      if (counterResponse.ok) {
        const { value } = await counterResponse.json();
        setCounterValue(value);
      }

    } catch (err) {
      console.error("Transaction error:", err);
      setState("error");
      setError(err instanceof Error ? err.message : "Transaction failed");
    }
  }, [phantomPubkeyHex, smartAccountAddress]);


  const disconnect = useCallback(async () => {
    // SDK doesn't have a clear 'disconnect' method in the docs shown, 
    // but usually we just reset local state for "disconnecting" in a dapp.
    // phantom.md shows `sdk.disconnect()` isn't explicitly listed in the "Connect" section 
    // but `sdk.on('disconnect')` exists.
    // The previous code verified window.solana.
    
    // We will just reset state.
    setPhantomPubkey(null);
    setPhantomPubkeyHex(null);
    setSmartAccountAddress(null);
    setGAddress(null);
    setState("disconnected");
    setError(null);
    setCounterValue(null);
    setTxHash(null);
  }, []);

  const getStatusText = () => {
    switch (state) {
      case "disconnected": return "Not connected";
      case "connecting": return "Connecting to Phantom...";
      case "deploying": return "Deploying your Smart Account...";
      case "ready": return "Smart Account ready";
      case "building": return "Building transaction...";
      case "signing": return "Sign with Phantom to authorize...";
      case "submitting": return "Executing on Stellar...";
      case "success": return "Transaction successful!";
      case "error": return "Error";
      default: return "";
    }
  };

  const COUNTER_ADDRESS = "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U";
  const VERIFIER_ADDRESS = "CBNCF7QBTMIAEIZ3H6EN6JU5RDLBTFZZKGSWPAXW6PGPNY3HHIW5HKCH";

  return (
    <div className="min-h-svh bg-background">
      <div className="max-w-2xl mx-auto px-4 py-16">

        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center rounded-full border border-primary/30 px-3 py-1 text-xs font-mono text-primary mb-4 bg-primary/5">
            LIVE ON TESTNET
          </div>
          <h1 className="text-4xl font-mono font-bold tracking-tighter mb-4">
            Phantom → Stellar Smart Account
          </h1>
          <p className="text-muted-foreground">
            Control a Soroban Smart Account using your Phantom wallet.
            <br />
            <span className="text-xs">Ed25519 signatures verified on-chain — no Stellar wallet needed.</span>
          </p>
        </div>

        {/* Demo Card */}
        <div className="border rounded-lg p-8 bg-card">
          {/* Status Indicator */}
          <div className="flex items-center gap-2 mb-6">
            <div
              className={`w-2 h-2 rounded-full ${
                state === "ready" || state === "success"
                  ? "bg-green-500"
                  : state === "error"
                  ? "bg-red-500"
                  : state === "disconnected"
                  ? "bg-gray-400"
                  : "bg-yellow-500 animate-pulse"
              }`}
            />
            <span className="text-sm text-muted-foreground font-mono">
              {getStatusText()}
            </span>
          </div>

          {/* Phantom Pubkey Display */}
          {phantomPubkey && (
            <div className="mb-4 p-4 bg-muted rounded-md">
              <p className="text-xs text-muted-foreground mb-1">Phantom Public Key (Solana format)</p>
              <p className="font-mono text-sm break-all">{phantomPubkey}</p>
            </div>
          )}

          {/* G-Address Display */}
          {gAddress && (
            <div className="mb-4 p-4 bg-muted rounded-md">
              <p className="text-xs text-muted-foreground mb-1">Your Stellar Account (G-address)</p>
              <a
                href={`https://stellar.expert/explorer/testnet/account/${gAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm break-all text-blue-600 hover:underline"
              >
                {gAddress}
              </a>
            </div>
          )}

          {/* Smart Account Display */}
          {smartAccountAddress && (
            <div className="mb-4 p-4 bg-primary/10 border border-primary/20 rounded-md">
              <p className="text-xs text-muted-foreground mb-1">Your Smart Account (C-address)</p>
              <a
                href={`https://stellar.expert/explorer/testnet/contract/${smartAccountAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm break-all text-primary hover:underline"
              >
                {smartAccountAddress}
              </a>
            </div>
          )}

          {/* On-Chain Contracts Info */}
          {smartAccountAddress && (
            <div className="mb-4 p-4 bg-muted/50 rounded-md space-y-2">
              <p className="text-xs text-muted-foreground font-semibold mb-2">On-Chain Contracts (verify on Stellar Expert)</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Counter Contract</span>
                <a
                  href={`https://stellar.expert/explorer/testnet/contract/${COUNTER_ADDRESS}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:underline"
                >
                  {COUNTER_ADDRESS.slice(0, 8)}...{COUNTER_ADDRESS.slice(-6)}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Ed25519 Verifier</span>
                <a
                  href={`https://stellar.expert/explorer/testnet/contract/${VERIFIER_ADDRESS}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:underline"
                >
                  {VERIFIER_ADDRESS.slice(0, 8)}...{VERIFIER_ADDRESS.slice(-6)}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}

          {/* Success Result */}
          {state === "success" && txHash && (
            <div className="mb-4 p-5 bg-green-500/10 border border-green-500/20 rounded-md space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">✅</span>
                <span className="text-sm font-semibold text-green-700">Transaction Confirmed On-Chain</span>
              </div>
              
              {counterValue !== null && (
                <div className="text-center py-3">
                  <p className="text-xs text-muted-foreground mb-1">Counter Value (modified via your Smart Account)</p>
                  <p className="font-mono text-5xl font-bold text-foreground">{counterValue}</p>
                </div>
              )}

              <div className="space-y-2 pt-2 border-t border-green-500/20">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Transaction Hash</p>
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs break-all text-green-700 hover:underline"
                  >
                    {txHash}
                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
                  </a>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Authorized By</p>
                  <p className="font-mono text-xs text-foreground/70">Phantom Ed25519 → On-chain Verifier → Smart Account</p>
                </div>
              </div>
            </div>
          )}

          {/* Counter Display (non-success states) */}
          {counterValue !== null && state !== "success" && (
            <div className="mb-4 p-4 bg-muted rounded-md text-center">
              <p className="text-xs text-muted-foreground mb-1">Counter Value</p>
              <p className="font-mono text-4xl font-bold">{counterValue}</p>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="mb-4 p-4 bg-red-500/10 border border-red-500/20 rounded-md">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-col gap-3">
            {state === "disconnected" && (
              <Button
                onClick={connectAndDeploy}
                size="lg"
                className="w-full font-mono"
                disabled={!isPhantomAvailable}
              >
                {isPhantomAvailable
                  ? "Connect Phantom & Create Smart Account"
                  : "Install Phantom Wallet"}
              </Button>
            )}

            {(state === "ready" || state === "success") && (
              <>
                <Button
                  onClick={runDemo}
                  size="lg"
                  className="w-full font-mono bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {state === "success" ? "🔄 Increment Counter Again" : "⚡ Sign & Increment Counter"}
                </Button>
                <Button
                  onClick={disconnect}
                  variant="outline"
                  size="lg"
                  className="w-full font-mono"
                >
                  Disconnect
                </Button>
              </>
            )}

            {state === "error" && (
              <Button
                onClick={disconnect}
                variant="outline"
                size="lg"
                className="w-full font-mono"
              >
                Try Again
              </Button>
            )}

            {(state === "connecting" || state === "deploying" || state === "building" || state === "signing" || state === "submitting") && (
              <Button
                size="lg"
                className="w-full font-mono"
                disabled
              >
                {getStatusText()}
              </Button>
            )}
          </div>
        </div>

        {/* How it works */}
        <div className="mt-12 space-y-6">
          <h2 className="text-xl font-mono font-bold">How it works</h2>
          <ol className="space-y-4 text-sm text-muted-foreground">
            <li className="flex gap-3">
              <span className="font-mono text-primary">01</span>
              <span>Connect Phantom to get your Ed25519 public key</span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-primary">02</span>
              <span>A Smart Account (C-address) is deployed and configured to trust your key</span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-primary">03</span>
              <span>When you act, Phantom signs the authorization payload</span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-primary">04</span>
              <span>The on-chain Ed25519 verifier validates your signature</span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-primary">05</span>
              <span>The Smart Account authorizes the action - you control Stellar with Phantom</span>
            </li>
          </ol>

          <p className="text-xs text-muted-foreground border-t pt-6">
            <strong>This is Smart Account adoption.</strong> Your Phantom wallet controls a Soroban C-address.
            The same pattern works for MetaMask, Passkeys, or any Ed25519/secp256k1 signer.
          </p>

          <div className="mt-4 p-3 bg-green-500/10 border border-green-500/20 rounded-md">
            <p className="text-xs text-green-700">
              <strong>How it works:</strong> Phantom signs a prefixed message (&quot;Stellar Smart Account Auth:\n&quot; + hash).
              The on-chain Ed25519 verifier reconstructs this format and validates the signature.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

