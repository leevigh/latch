import { NextRequest, NextResponse } from "next/server";
import { rpc } from "@stellar/stellar-sdk";
import { isNetwork, NetworkConfigError, resolveNetwork } from "@/lib/network";
import { listContextRules } from "@/lib/soroban-context-rules";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");
    const networkParam = searchParams.get("network") ?? "testnet";

    if (!address) {
      return NextResponse.json({ error: "Missing address query parameter." }, { status: 400 });
    }
    if (!isNetwork(networkParam)) {
      return NextResponse.json(
        { error: 'network must be "testnet" or "mainnet".' },
        { status: 400 }
      );
    }

    const { rpcUrl, networkPassphrase } = resolveNetwork(networkParam);
    const server = new rpc.Server(rpcUrl);
    const rules = await listContextRules(server, networkPassphrase, address);

    return NextResponse.json({
      smartAccountAddress: address,
      network: networkParam,
      ruleCount: rules.length,
      rules,
    });
  } catch (error) {
    if (error instanceof NetworkConfigError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    console.error("context-rules error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list context rules" },
      { status: 500 }
    );
  }
}
