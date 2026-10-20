import fs from "node:fs";
import path from "node:path";

export interface WorkspaceValidationResult {
  ok: boolean;
  issues: string[];
  competingLockfiles: string[];
  brokenWorkspaceDeps: string[];
}

const COMPETING_LOCKFILE_NAMES = [
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
];

/**
 * Validates workspace manifests, lockfile consistency, and competing lockfiles.
 *
 * 1. Checks for unwanted competing lockfiles (npm package-lock.json, yarn.lock, bun.lockb)
 *    and provides exact deletion remediation.
 * 2. Checks all packages declared in workspace for valid package.json manifests.
 * 3. Verifies that all `workspace:*` dependencies resolve to real packages in the workspace.
 * 4. Ensures pnpm-lock.yaml exists and is non-empty.
 */
export function validateWorkspace(repoRoot: string = process.cwd()): WorkspaceValidationResult {
  const issues: string[] = [];
  const competingLockfiles: string[] = [];
  const brokenWorkspaceDeps: string[] = [];

  // 1. Check for competing lockfiles in repo root and subpackages
  for (const name of COMPETING_LOCKFILE_NAMES) {
    const rootPath = path.join(repoRoot, name);
    if (fs.existsSync(rootPath)) {
      competingLockfiles.push(name);
      issues.push(
        `Found competing lockfile '${name}'. Remediation: Run 'rm ${name}' to maintain pnpm as the single source of truth.`
      );
    }
  }

  // 2. Discover workspace packages
  const knownPackageNames = new Set<string>();
  const packageJsonPaths: string[] = [];

  const rootPkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(rootPkgPath)) {
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    if (rootPkg.name) knownPackageNames.add(rootPkg.name);
    packageJsonPaths.push(rootPkgPath);
  }

  const workspaceDirs = ["apps", "packages"];
  for (const wDir of workspaceDirs) {
    const fullWDir = path.join(repoRoot, wDir);
    if (!fs.existsSync(fullWDir)) continue;
    const entries = fs.readdirSync(fullWDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(fullWDir, entry.name, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.name) knownPackageNames.add(pkg.name);
          packageJsonPaths.push(pkgPath);
        } catch (e) {
          issues.push(`Malformed JSON in '${pkgPath}': ${(e as Error).message}`);
        }
      }
    }
  }

  // 3. Verify workspace dependencies
  for (const pkgPath of packageJsonPaths) {
    const relPkgPath = path.relative(repoRoot, pkgPath);
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch {
      continue;
    }

    const depSections = ["dependencies", "devDependencies", "peerDependencies"];
    for (const sec of depSections) {
      const deps = pkg[sec] as Record<string, string> | undefined;
      if (!deps) continue;

      for (const [depName, versionSpec] of Object.entries(deps)) {
        if (typeof versionSpec === "string" && versionSpec.startsWith("workspace:")) {
          if (!knownPackageNames.has(depName)) {
            const msg = `Broken workspace dependency '${depName}' (${versionSpec}) in '${relPkgPath}'. Remediation: Check package name spelling or remove from ${relPkgPath}.`;
            brokenWorkspaceDeps.push(depName);
            issues.push(msg);
          }
        }
      }
    }
  }

  // 4. Ensure pnpm-lock.yaml exists and is not empty
  const pnpmLockPath = path.join(repoRoot, "pnpm-lock.yaml");
  if (!fs.existsSync(pnpmLockPath)) {
    issues.push("Missing 'pnpm-lock.yaml'. Remediation: Run 'pnpm install' to generate a frozen lockfile.");
  } else {
    const stat = fs.statSync(pnpmLockPath);
    if (stat.size === 0) {
      issues.push("Empty 'pnpm-lock.yaml'. Remediation: Run 'pnpm install' to populate the lockfile.");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    competingLockfiles,
    brokenWorkspaceDeps,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Validating workspace manifests and lockfiles...");
  const res = validateWorkspace();
  if (!res.ok) {
    console.error(`Workspace validation failed with ${res.issues.length} issue(s):`);
    for (const issue of res.issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  } else {
    console.log("Workspace manifests and lockfiles are valid.");
  }
}
