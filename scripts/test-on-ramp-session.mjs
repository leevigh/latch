/**
 * Smoke test for POST /api/on-ramp/session (no MoonPay browser flow).
 * Requires dev server running and env vars set.
 *
 * Usage: node scripts/test-on-ramp-session.mjs [baseUrl]
 */
const baseUrl = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

const testCAddress =
  process.env.TEST_C_ADDRESS ??
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

async function main() {
  const res = await fetch(`${baseUrl}/api/on-ramp/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      destinationCAddress: testCAddress,
      fiatAmount: "25",
      fiatCode: "USD",
    }),
  });

  const data = await res.json().catch(() => ({}));
  console.log("status:", res.status);
  console.log(JSON.stringify(data, null, 2));

  if (!res.ok) {
    process.exit(1);
  }

  const required = ["intentId", "memoId", "destinationCAddress", "poolAddress", "integrationMode"];
  for (const key of required) {
    if (!data[key]) {
      console.error(`Missing field: ${key}`);
      process.exit(1);
    }
  }

  if (data.integrationMode === "platform" && !data.sessionToken) {
    console.error("Missing sessionToken for platform mode");
    process.exit(1);
  }
  if (data.integrationMode === "widget" && !data.widgetUrl) {
    console.error("Missing widgetUrl for widget mode");
    process.exit(1);
  }

  const poolRes = await fetch(`${baseUrl}/api/on-ramp/pool`);
  const poolData = await poolRes.json().catch(() => ({}));
  console.log("pool status:", poolRes.status);
  console.log(JSON.stringify(poolData, null, 2));

  if (!poolRes.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
