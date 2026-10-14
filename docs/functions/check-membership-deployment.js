"use strict";
const base = "https://us-central1-ourweddingdayhub.cloudfunctions.net/api";
async function main() {
  const health = await fetch(base + "/membership-health", { signal: AbortSignal.timeout(15000) });
  if (!health.ok || (await health.json()).version !== "20261014-reconciliation-v1") throw new Error("Expected membership backend is not deployed.");
  for (const route of ["/verify-membership", "/confirm-checkout"]) {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15000) });
    if (response.status !== 401) throw new Error(route + " should return 401 to unauthenticated requests; got " + response.status);
  }
  console.log("Membership backend version and authenticated routes verified.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
