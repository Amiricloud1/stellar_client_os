import assert from "node:assert/strict";
import test from "node:test";
import { affectedPackages, planAffectedAreas } from "./validate-affected.mjs";

const packages = [
  { name: "@fundable/web", directory: "apps/web", dependencies: ["@fundable/sdk"] },
  { name: "@fundable/mobile", directory: "apps/mobile", dependencies: [] },
  { name: "@fundable/sdk", directory: "packages/sdk", dependencies: [] },
];

test("SDK changes include dependent web checks but not unrelated mobile checks", () => {
  assert.deepEqual(
    [...affectedPackages(["packages/sdk/src/client.ts"], packages)].sort(),
    ["@fundable/sdk", "@fundable/web"],
  );
});

test("workspace configuration changes include every package", () => {
  assert.deepEqual(
    [...affectedPackages(["pnpm-lock.yaml"], packages)].sort(),
    ["@fundable/mobile", "@fundable/sdk", "@fundable/web"],
  );
});

test("Rust changes schedule Rust checks without selecting unrelated JS packages", () => {
  const plan = planAffectedAreas(["contracts/payment-stream/src/lib.rs"], packages);
  assert.equal(plan.rust, true);
  assert.deepEqual([...plan.packages], []);
});

test("documentation-only changes do not select workspace validation", () => {
  const plan = planAffectedAreas(["docs/tax-reporting.md"], packages);
  assert.equal(plan.rust, false);
  assert.deepEqual([...plan.packages], []);
});