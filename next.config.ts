import type { NextConfig } from "next";

const extraDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Origin-only entries for CSP connect-src (scheme + host, no path). */
function connectSrcOrigin(urlOrHost: string | undefined): string | null {
  const raw = urlOrHost?.trim();
  if (!raw) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

// /dev pages call Go (counter-dapp, sign-demo B2) and Soroban RPC from the browser.
const DEFAULT_GO_API = "https://latch-backend.onrender.com";
const DEFAULT_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

const devConnectSrc = Array.from(
  new Set(
    [
      "'self'",
      "https://*.moonpay.com",
      "https://*.stellar.org",
      "https://*.onrender.com",
      "https://mainnet.sorobanrpc.com",
      connectSrcOrigin(process.env.NEXT_PUBLIC_LATCH_API_URL) ??
        connectSrcOrigin(DEFAULT_GO_API),
      connectSrcOrigin(process.env.NEXT_PUBLIC_RPC_URL) ??
        connectSrcOrigin(DEFAULT_TESTNET_RPC),
      connectSrcOrigin(process.env.MAINNET_RPC_URL),
      connectSrcOrigin(DEFAULT_TESTNET_HORIZON),
    ].filter((v): v is string => Boolean(v))
  )
).join(" ");

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Allow opening the dev app via LAN hostname (e.g. phone on http(s)://192.168.x.x:3000).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", ...extraDevOrigins],
  async headers() {
    return [
      {
        source: "/dev/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
              "frame-src 'self' https://*.moonpay.com",
              `connect-src ${devConnectSrc}`,
              "img-src 'self' data: https://*.moonpay.com",
              "style-src 'self' 'unsafe-inline'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
