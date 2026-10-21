import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AREA_DIRECTORIES = {
  web: "apps/web",
  mobile: "apps/mobile",
  sdk: "packages/sdk",
};
const PACKAGE_CHECKS = ["build", "test", "typecheck", "test:consumers"];
const SOURCE_FILE = /\.(?:cjs|js|jsx|mjs|ts|tsx|json)$/;
const ROOT_WIDE_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);

export function affectedPackages(changedFiles, packages) {
  const allPackageNames = new Set(packages.map((pkg) => pkg.name));
  const affected = new Set();
  const affectsWorkspace = changedFiles.some(
    (file) =>
      ROOT_WIDE_FILES.has(file) ||
      file.startsWith("scripts/") ||
      file.startsWith(".github/workflows/"),
  );

  for (const file of changedFiles) {
    if (file.startsWith("contracts/")) continue;
    const pkg = packages.find((candidate) => file.startsWith(`${candidate.directory}/`));
    if (pkg) affected.add(pkg.name);
  }

  if (affectsWorkspace) {
    return allPackageNames;
  }

  let hasNewDependents = true;
  while (hasNewDependents) {
    hasNewDependents = false;
    for (const pkg of packages) {
      if (affected.has(pkg.name)) continue;
      if (pkg.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(pkg.name);
        hasNewDependents = true;
      }
    }
  }

  return affected;
}

function loadWorkspacePackages() {
  const packages = [];
  for (const workspaceDirectory of ["apps", "packages"]) {
    const absoluteDirectory = path.join(ROOT, workspaceDirectory);
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.posix.join(workspaceDirectory, entry.name);
      const manifestPath = path.join(ROOT, directory, "package.json");
      if (!fs.existsSync(manifestPath)) continue;

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const dependencies = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ].flatMap((section) => Object.keys(manifest[section] ?? {}));
      packages.push({ name: manifest.name, directory, dependencies, scripts: manifest.scripts ?? {} });
    }
  }

  const workspaceNames = new Set(packages.map((pkg) => pkg.name));
  return packages.map((pkg) => ({
    ...pkg,
    dependencies: pkg.dependencies.filter((name) => workspaceNames.has(name)),
  }));
}

function changedFiles(baseRef) {
  return execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runRustChecks() {
  run("cargo", ["fmt", "--manifest-path", "contracts/Cargo.toml", "--all", "--", "--check"]);
  run("cargo", [
    "clippy",
    "--manifest-path",
    "contracts/Cargo.toml",
    "--workspace",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]);
  run("cargo", ["test", "--manifest-path", "contracts/Cargo.toml", "--workspace"]);
}

function runChangedSourceChecks(pkg, files) {
  const packageFiles = files.filter(
    (file) => file.startsWith(`${pkg.directory}/`) && SOURCE_FILE.test(file),
  );
  if (packageFiles.length === 0) {
    console.log(`${pkg.name}: lint and format skipped (no changed source files)`);
    return;
  }

  if (pkg.scripts.lint) {
    console.log(`${pkg.name}: lint changed files`);
    if (pkg.directory === AREA_DIRECTORIES.mobile) {
      run("pnpm", ["--filter", pkg.name, "run", "lint"]);
    } else {
      const lintPaths = packageFiles
        .filter((file) => /\.(?:cjs|js|jsx|mjs|ts|tsx)$/.test(file))
        .map((file) => path.posix.relative(pkg.directory, file));
      if (lintPaths.length > 0) {
        run("pnpm", ["--filter", pkg.name, "exec", "eslint", ...lintPaths]);
      }
    }
  }

  console.log(`${pkg.name}: format changed files`);
  {
    const prettierPaths = packageFiles.map((file) => path.posix.relative("packages/sdk", file));
    run("pnpm", [
      "--filter",
      "@fundable/sdk",
      "exec",
      "prettier",
      "--check",
      "--config",
      ".prettierrc.json",
      ...prettierPaths,
    ]);
  }
}

function runPackageChecks(pkg, files) {
  if (pkg.name === "@fundable/web") {
    console.log("@fundable/sdk: build (web workspace dependency)");
    run("pnpm", ["--filter", "@fundable/sdk", "run", "build"]);
  }
  for (const check of PACKAGE_CHECKS) {
    if (!pkg.scripts[check]) {
      console.log(`${pkg.name}: ${check} excluded (no package script)`);
      continue;
    }
    console.log(`${pkg.name}: ${check}`);
    run("pnpm", ["--filter", pkg.name, "run", check]);
  }
  runChangedSourceChecks(pkg, files);
}

export function planAffectedAreas(changedFiles, packages) {
  return {
    packages: affectedPackages(changedFiles, packages),
    rust:
      changedFiles.some((file) => file.startsWith("contracts/")) ||
      changedFiles.some(
        (file) =>
          ROOT_WIDE_FILES.has(file) ||
          file.startsWith("scripts/") ||
          file.startsWith(".github/workflows/"),
      ),
  };
}

async function main() {
  const areaIndex = process.argv.indexOf("--area");
  const area = areaIndex >= 0 ? process.argv[areaIndex + 1] : "all";
  const beforeCommit = process.env.GITHUB_EVENT_BEFORE_SHA;
  const baseRef = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : beforeCommit && !/^0+$/.test(beforeCommit)
      ? beforeCommit
      : "origin/main";
  const packages = loadWorkspacePackages();
  const files = changedFiles(baseRef);
  const plan = planAffectedAreas(files, packages);

  if (area === "rust") {
    if (!plan.rust) {
      console.log("Rust checks skipped: no Rust or workspace-wide files changed.");
      return;
    }
    runRustChecks();
    return;
  }

  if (area !== "all" && !AREA_DIRECTORIES[area]) {
    throw new Error(`Unknown validation area '${area}'.`);
  }

  const packageDirectory = area === "all" ? null : AREA_DIRECTORIES[area];
  const selected = packages.filter(
    (pkg) => plan.packages.has(pkg.name) && (!packageDirectory || packageDirectory === pkg.directory),
  );

  if (selected.length === 0) {
    console.log(`${area} checks skipped: no affected workspace packages.`);
    return;
  }

  const ordered = [];
  const visited = new Set();
  const selectedNames = new Set(selected.map((pkg) => pkg.name));
  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    visited.add(pkg.name);
    for (const dependencyName of pkg.dependencies) {
      if (selectedNames.has(dependencyName)) {
        visit(selected.find((candidate) => candidate.name === dependencyName));
      }
    }
    ordered.push(pkg);
  }
  selected.forEach(visit);
  for (const pkg of ordered) runPackageChecks(pkg, files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}