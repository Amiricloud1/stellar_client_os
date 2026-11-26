/**
 * Canary release controller exports and the process-wide singleton used by the
 * admin API. Deployments that need real journey metrics or integrity checks
 * should configure the singleton at startup (see
 * `docs/operations/canary-release-runbook.md`).
 */

export * from "./canary-release";

import { CanaryReleaseController } from "./canary-release";

let controller: CanaryReleaseController | null = null;

export function getCanaryReleaseController(): CanaryReleaseController {
  if (!controller) {
    controller = new CanaryReleaseController();
  }
  return controller;
}

/** Replaces the singleton; pass `null` to recreate defaults on next access. */
export function setCanaryReleaseController(
  next: CanaryReleaseController | null,
): void {
  controller = next;
}
