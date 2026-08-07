import { NextRequest, NextResponse } from "next/server";
import { Networks, rpc, StrKey } from "@stellar/stellar-sdk";
import { fetchBalancesForCatalog } from "@/lib/soroban-balances";
import { getAssetCatalog } from "@/lib/stellar-assets";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const smartAccountAddress = searchParams.get("smartAccountAddress");
    const all = searchParams.get("all") === "1";

    if (!smartAccountAddress) {
      return NextResponse.json(
        { error: "Missing smartAccountAddress query param" },
        { status: 400 }
      );
    }

    if (!StrKey.isValidContract(smartAccountAddress)) {
      return NextResponse.json(
        { error: "smartAccountAddress must be a valid C-address" },
        { status: 400 }
      );
    }

    const config = getConfig();
    const catalog = getAssetCatalog(config.networkPassphrase);
    const server = new rpc.Server(config.rpcUrl);

    const balances = await fetchBalancesForCatalog(
      server,
      config.networkPassphrase,
      smartAccountAddress,
      catalog,
      !all
    );

    return NextResponse.json({
      smartAccountAddress,
      balances,
    });
  } catch (error) {
    console.error("Error fetching balances:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch balances" },
      { status: 500 }
    );
  }
}
