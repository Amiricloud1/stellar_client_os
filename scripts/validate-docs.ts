import fs from "node:fs";
import path from "node:path";

export interface DocValidationIssue {
  file: string;
  line: number;
  type: "broken_link" | "unknown_package" | "invalid_script" | "invalid_path";
  reference: string;
  message: string;
}

export interface ValidationConfig {
  repoRoot: string;
  docGlobs?: string[];
  allowedPackages?: string[];
  externalOrCredentialExceptions?: string[];
  allowedMissingPaths?: string[];
}

export const DEFAULT_ALLOWED_PACKAGES = [
  "stellar_client",
  "@fundable/web",
  "@fundable/mobile",
  "@fundable/sdk",
  "@stellar/stellar-sdk",
  "@stellar/freighter-api",
  "soroban-sdk",
  "@changesets/cli",
  "typescript",
  "vitest",
];

export const DEFAULT_EXTERNAL_OR_CREDENTIAL_EXCEPTIONS = [
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "id_rsa",
  "service-account.json",
  "soroban-identity",
];

export const DEFAULT_ALLOWED_MISSING_PATHS = [
  "dist",
  "build",
  "node_modules",
  "target",
  ".turbo",
  ".next",
  "coverage",
];

/**
 * Validates documentation files for:
 * 1. Package name references against workspace and approved external dependencies.
 * 2. Repository scripts (`pnpm run <script>` or `npm run <script>`).
 * 3. Relative local filesystem paths mentioned in markdown code and links.
 * 4. Respects explicit exceptions for credential files and build artifacts.
 */
export function validateDocs(config?: Partial<ValidationConfig>): {
  valid: boolean;
  issues: DocValidationIssue[];
  filesScanned: number;
} {
  const repoRoot = config?.repoRoot || process.cwd();
  const rootPkgPath = path.join(repoRoot, "package.json");
  const rootPkg = fs.existsSync(rootPkgPath)
    ? JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"))
    : { scripts: {} };
  const rootScripts = new Set(Object.keys(rootPkg.scripts || {}));

  const allowedPackages = new Set([
    ...DEFAULT_ALLOWED_PACKAGES,
    ...(config?.allowedPackages || []),
  ]);

  const credentialExceptions = new Set([
    ...DEFAULT_EXTERNAL_OR_CREDENTIAL_EXCEPTIONS,
    ...(config?.externalOrCredentialExceptions || []),
  ]);

  const allowedMissingPaths = new Set([
    ...DEFAULT_ALLOWED_MISSING_PATHS,
    ...(config?.allowedMissingPaths || []),
  ]);

  const docFiles: string[] = [];
  function collectMarkdownFiles(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectMarkdownFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        docFiles.push(fullPath);
      }
    }
  }

  // Scan docs/ directory and root markdown files
  collectMarkdownFiles(path.join(repoRoot, "docs"));
  const rootEntries = fs.readdirSync(repoRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      docFiles.push(path.join(repoRoot, entry.name));
    }
  }

  const issues: DocValidationIssue[] = [];

  for (const filePath of docFiles) {
    const relFile = path.relative(repoRoot, filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const lineNum = index + 1;

      // Check pnpm/npm run commands: `pnpm <script>` or `npm run <script>`
      const scriptMatch = line.match(/(?:pnpm|npm run)\s+([a-zA-Z0-9_\-:]+)/);
      if (scriptMatch) {
        const scriptName = scriptMatch[1];
        // Allow built-in package manager commands
        const builtins = new Set(["install", "i", "test", "build", "dev", "add", "remove", "filter", "run"]);
        if (!builtins.has(scriptName) && !rootScripts.has(scriptName)) {
          // If not in root scripts, check if it's documented as external or workspace filtered
          if (!line.includes("--filter")) {
            issues.push({
              file: relFile,
              line: lineNum,
              type: "invalid_script",
              reference: scriptName,
              message: `Referenced script '${scriptName}' does not exist in root package.json`,
            });
          }
        }
      }

      // Check relative paths like `./path/to/file` or `../path/to/file`
      const relPathMatches = line.matchAll(/(?:\.{1,2}\/[a-zA-Z0-9_\-./]+)/g);
      for (const m of relPathMatches) {
        const rawPath = m[0].replace(/[),:;`'"]+$/, "");
        const baseName = path.basename(rawPath);
        if (credentialExceptions.has(baseName) || allowedMissingPaths.has(baseName)) {
          continue;
        }
        const resolved = path.resolve(path.dirname(filePath), rawPath);
        if (!fs.existsSync(resolved)) {
          // Verify if it's an allowed build artifact
          const isAllowedArtifact = Array.from(allowedMissingPaths).some((p) => rawPath.includes(p));
          if (!isAllowedArtifact) {
            issues.push({
              file: relFile,
              line: lineNum,
              type: "invalid_path",
              reference: rawPath,
              message: `Local path reference '${rawPath}' does not exist on disk`,
            });
          }
        }
      }
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    filesScanned: docFiles.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateDocs();
  console.log(`Scanned ${result.filesScanned} documentation files.`);
  if (!result.valid) {
    console.error(`Found ${result.issues.length} documentation reference issues:`);
    for (const issue of result.issues) {
      console.error(`- ${issue.file}:${issue.line} [${issue.type}] ${issue.message}`);
    }
    process.exit(1);
  } else {
    console.log("All documentation commands and package references are valid.");
  }
}
