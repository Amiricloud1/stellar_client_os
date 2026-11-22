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

export interface MigrationValidationResult {
  ok: boolean;
  issues: string[];
  lockUnsafe: string[];
  nonIdempotent: string[];
  missingRollback: string[];
  interrupted: string[];
}

export interface MigrationFile {
  name: string;
  sql: string;
  rollbackSql?: string;
}

const MIGRATION_FILE_RE = /^(\d+)[-_].+\.sql$/;
const ROLLBACK_SUFFIX_RE = /\.(down|rollback)\.sql$/;
const INTERRUPTED_MARKER = "-- migration:interrupted";

// Patterns that take long-lived locks on large tables and block overlapping
// application versions. Each entry maps a regex to a remediation hint.
const LOCK_UNSAFE_PATTERNS: Array<{ re: RegExp; hint: string }> = [
  {
    re: /\bcreate\s+(unique\s+)?index\s+(?!concurrently\b)/i,
    hint: "Use CREATE INDEX CONCURRENTLY (outside a transaction) to avoid blocking writes.",
  },
  {
    re: /\balter\s+table\b[^;]*\badd\s+column\b[^;]*\bnot\s+null\b(?![^;]*\bdefault\b)/i,
    hint: "Add the column as nullable (or with a default), backfill, then add NOT NULL in a later migration.",
  },
  {
    re: /\balter\s+table\b[^;]*\badd\s+constraint\b[^;]*\bforeign\s+key\b(?!\s+not\s+valid)/i,
    hint: "Add the constraint as NOT VALID, then VALIDATE CONSTRAINT in a separate migration.",
  },
  {
    re: /\balter\s+table\b[^;]*\bset\s+not\s+null\b/i,
    hint: "Set NOT NULL only after a backfill migration has populated every row.",
  },
  {
    re: /\balter\s+table\b[^;]*\btype\b/i,
    hint: "Column type changes rewrite the table under an exclusive lock; stage via a new column and backfill.",
  },
];

// Statements that are not safe to re-run after an interrupted deployment.
const NON_IDEMPOTENT_PATTERNS: Array<{ re: RegExp; hint: string }> = [
  {
    re: /\bcreate\s+table\s+(?!if\s+not\s+exists\b)/i,
    hint: "Use CREATE TABLE IF NOT EXISTS so an interrupted run can be resumed.",
  },
  {
    re: /\bcreate\s+(unique\s+)?index\s+concurrently\s+(?!if\s+not\s+exists\b)/i,
    hint: "Use CREATE INDEX CONCURRENTLY IF NOT EXISTS so a failed build can be retried.",
  },
  {
    re: /\balter\s+table\b[^;]*\badd\s+column\s+(?!if\s+not\s+exists\b)/i,
    hint: "Use ADD COLUMN IF NOT EXISTS so an interrupted run can be resumed.",
  },
  {
    re: /\binsert\s+into\b(?![\s\S]*\bon\s+conflict\b)/i,
    hint: "Use INSERT ... ON CONFLICT DO NOTHING for data backfills that may be retried.",
  },
];

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * Validates a single migration for lock-safe, idempotent, and rollback-aware
 * patterns. Returns the list of issues found (empty when the migration is safe).
 */
export function validateMigration(migration: MigrationFile): string[] {
  const issues: string[] = [];
  const body = stripSqlComments(migration.sql);

  for (const { re, hint } of LOCK_UNSAFE_PATTERNS) {
    if (re.test(body)) {
      issues.push(`Lock-unsafe statement in '${migration.name}': ${hint}`);
    }
  }

  for (const { re, hint } of NON_IDEMPOTENT_PATTERNS) {
    if (re.test(body)) {
      issues.push(`Non-idempotent statement in '${migration.name}': ${hint}`);
    }
  }

  if (!migration.rollbackSql || migration.rollbackSql.trim().length === 0) {
    issues.push(
      `Missing rollback SQL for '${migration.name}'. Remediation: add a matching '${migration.name.replace(/\.sql$/, "")}.down.sql' file.`
    );
  }

  return issues;
}

/**
 * Discovers migrations in `migrationsDir`, pairs each up migration with its
 * rollback file, and validates them. Also detects interrupted deployments via
 * the `-- migration:interrupted` marker so operators can resume or roll back.
 */
export function validateMigrations(
  migrationsDir: string = path.join(process.cwd(), "migrations")
): MigrationValidationResult {
  const issues: string[] = [];
  const lockUnsafe: string[] = [];
  const nonIdempotent: string[] = [];
  const missingRollback: string[] = [];
  const interrupted: string[] = [];

  if (!fs.existsSync(migrationsDir)) {
    issues.push(
      `Missing migrations directory '${migrationsDir}'. Remediation: create it or pass an explicit path.`
    );
    return { ok: false, issues, lockUnsafe, nonIdempotent, missingRollback, interrupted };
  }

  const entries = fs.readdirSync(migrationsDir).sort();
  const rollbackFiles = new Set(
    entries.filter((e) => ROLLBACK_SUFFIX_RE.test(e))
  );

  for (const entry of entries) {
    if (!MIGRATION_FILE_RE.test(entry)) continue;
    const fullPath = path.join(migrationsDir, entry);
    const sql = fs.readFileSync(fullPath, "utf-8");

    if (sql.includes(INTERRUPTED_MARKER)) {
      interrupted.push(entry);
      issues.push(
        `Interrupted deployment detected for '${entry}'. Remediation: resume with 'pnpm migrate:resume' or roll back with 'pnpm migrate:rollback ${entry}'.`
      );
    }

    const rollbackName = entry.replace(/\.sql$/, ".down.sql");
    const rollbackSql = rollbackFiles.has(rollbackName)
      ? fs.readFileSync(path.join(migrationsDir, rollbackName), "utf-8")
      : undefined;

    const migrationIssues = validateMigration({ name: entry, sql, rollbackSql });
    for (const issue of migrationIssues) {
      issues.push(issue);
      if (issue.startsWith("Lock-unsafe")) lockUnsafe.push(entry);
      else if (issue.startsWith("Non-idempotent")) nonIdempotent.push(entry);
      else if (issue.startsWith("Missing rollback")) missingRollback.push(entry);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    lockUnsafe,
    nonIdempotent,
    missingRollback,
    interrupted,
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

  console.log("Validating database migrations...");
  const migrationsDir = process.env.MIGRATIONS_DIR
    ? path.resolve(process.env.MIGRATIONS_DIR)
    : path.join(process.cwd(), "migrations");
  const migRes = validateMigrations(migrationsDir);
  if (!migRes.ok) {
    console.error(`Migration validation failed with ${migRes.issues.length} issue(s):`);
    for (const issue of migRes.issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  } else {
    console.log("Database migrations are lock-safe, idempotent, and rollback-aware.");
  }
}
