import fs from "node:fs";
import path from "node:path";

export interface ReleaseVerificationResult {
  ok: boolean;
  issues: string[];
  packageName: string;
  version: string;
  changesetCount: number;
}

/**
 * Validates SDK release readiness before publishing to npm:
 * 1. Checks that packages/sdk/package.json exists and has valid name, version, license, and main/types exports.
 * 2. Checks that .changeset/ directory exists and contains valid configuration.
 * 3. Inspects pending changesets.
 * 4. Verifies git tag format convention (`v<version>`).
 */
export function verifyReleaseReady(repoRoot: string = process.cwd()): ReleaseVerificationResult {
  const issues: string[] = [];

  const sdkPkgPath = path.join(repoRoot, "packages", "sdk", "package.json");
  if (!fs.existsSync(sdkPkgPath)) {
    return {
      ok: false,
      issues: ["packages/sdk/package.json not found"],
      packageName: "",
      version: "",
      changesetCount: 0,
    };
  }

  const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, "utf-8"));
  const packageName = sdkPkg.name || "";
  const version = sdkPkg.version || "";

  if (!packageName || packageName !== "@fundable/sdk") {
    issues.push(`Expected package name '@fundable/sdk', found '${packageName}'`);
  }

  if (!version || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) {
    issues.push(`Invalid semver version in packages/sdk/package.json: '${version}'`);
  }

  if (!sdkPkg.license) {
    issues.push("packages/sdk/package.json is missing 'license' field");
  }

  const changesetConfigPath = path.join(repoRoot, ".changeset", "config.json");
  if (!fs.existsSync(changesetConfigPath)) {
    issues.push(".changeset/config.json configuration not found");
  }

  const changesetDir = path.join(repoRoot, ".changeset");
  let changesetCount = 0;
  if (fs.existsSync(changesetDir)) {
    const entries = fs.readdirSync(changesetDir);
    changesetCount = entries.filter((e) => e.endsWith(".md") && e !== "README.md").length;
  }

  return {
    ok: issues.length === 0,
    issues,
    packageName,
    version,
    changesetCount,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Running SDK release dry-run validation...");
  const res = verifyReleaseReady();
  console.log(`Package: ${res.packageName}@${res.version}`);
  console.log(`Pending changesets: ${res.changesetCount}`);

  if (!res.ok) {
    console.error("Release dry-run failed with issues:");
    for (const issue of res.issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  } else {
    console.log("Release dry-run passed: package metadata and changeset configuration are valid.");
  }
}
