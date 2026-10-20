import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * API versioning & deprecation policy tests.
 *
 * These tests enforce the compatibility contract documented in
 * `docs/api/versioning.md`:
 *
 *  - Breaking changes to the documented OpenAPI surface (removed paths,
 *    removed methods, removed/changed schemas, newly required request
 *    fields) require a major version bump.
 *  - Deprecated operations must be annotated with `deprecated: true` and
 *    an `x-sunset` extension (RFC 8594 / ISO-8601 date).
 *  - Deprecated operations must emit `Deprecation` and `Sunset` response
 *    headers where documented.
 *
 * A baseline snapshot of the OpenAPI surface is checked in alongside this
 * test. When an intentional breaking change is made, the baseline must be
 * regenerated together with a version bump.
 */

type JsonSchema = Record<string, unknown>;

interface OperationObject {
  deprecated?: boolean;
  'x-sunset'?: string;
  parameters?: Array<{ name?: string; in?: string; required?: boolean; schema?: JsonSchema }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<string, { headers?: Record<string, unknown>; content?: Record<string, { schema?: JsonSchema }> }>;
  [key: string]: unknown;
}

interface PathItemObject {
  [method: string]: OperationObject | unknown;
}

interface OpenApiSpec {
  openapi?: string;
  info?: { version?: string; [key: string]: unknown };
  paths?: Record<string, PathItemObject>;
  components?: { schemas?: Record<string, JsonSchema>; [key: string]: unknown };
  [key: string]: unknown;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const SPEC_CANDIDATES = [
  join(__dirname, '../../../openapi.json'),
  join(__dirname, '../../../public/openapi.json'),
  join(__dirname, '../../../src/openapi.json'),
  join(__dirname, '../../../../openapi.json'),
];

const BASELINE_CANDIDATES = [
  join(__dirname, 'openapi.baseline.json'),
  join(__dirname, 'fixtures/openapi.baseline.json'),
];

function findFirstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadJson(path: string): OpenApiSpec {
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiSpec;
}

function isOperation(value: unknown): value is OperationObject {
  return typeof value === 'object' && value !== null;
}

function getOperations(spec: OpenApiSpec): Map<string, OperationObject> {
  const ops = new Map<string, OperationObject>();
  const paths = spec.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = (item as PathItemObject)[method];
      if (isOperation(op)) {
        ops.set(`${method.toUpperCase()} ${path}`, op);
      }
    }
  }
  return ops;
}

function requiredRequestFields(op: OperationObject): string[] {
  const fields: string[] = [];
  for (const param of op.parameters ?? []) {
    if (param.required && param.in === 'query' && param.name) {
      fields.push(`query:${param.name}`);
    }
    if (param.required && param.in === 'path' && param.name) {
      fields.push(`path:${param.name}`);
    }
  }
  if (op.requestBody?.required) {
    const content = op.requestBody.content ?? {};
    for (const [mediaType, media] of Object.entries(content)) {
      const schema = media.schema;
      if (schema && typeof schema === 'object') {
        const required = (schema as { required?: unknown }).required;
        if (Array.isArray(required)) {
          for (const field of required) {
            if (typeof field === 'string') fields.push(`body:${mediaType}:${field}`);
          }
        }
      }
    }
  }
  return fields.sort();
}

function responseSchemaKeys(op: OperationObject): string[] {
  const keys: string[] = [];
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    for (const mediaType of Object.keys(response.content ?? {})) {
      keys.push(`${status}:${mediaType}`);
    }
  }
  return keys.sort();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function isMajorBump(baselineVersion: string | undefined, currentVersion: string | undefined): boolean {
  if (!baselineVersion || !currentVersion) return false;
  const baseMajor = Number.parseInt(baselineVersion.split('.')[0] ?? '', 10);
  const currMajor = Number.parseInt(currentVersion.split('.')[0] ?? '', 10);
  if (Number.isNaN(baseMajor) || Number.isNaN(currMajor)) return false;
  return currMajor > baseMajor;
}

function isDeprecated(op: OperationObject): boolean {
  return op.deprecated === true;
}

function hasSunset(op: OperationObject): boolean {
  const sunset = op['x-sunset'];
  return typeof sunset === 'string' && sunset.length > 0;
}

const specPath = findFirstExisting(SPEC_CANDIDATES);
const baselinePath = findFirstExisting(BASELINE_CANDIDATES);

describe('API versioning & deprecation policy', () => {
  it('locates the OpenAPI spec and baseline snapshot', () => {
    expect(specPath, 'OpenAPI spec must exist for versioning checks').not.toBeNull();
    expect(baselinePath, 'OpenAPI baseline snapshot must be checked in').not.toBeNull();
  });

  describe('breaking change detection against baseline', () => {
    it('does not remove any documented path or method without a major version bump', () => {
      if (!specPath || !baselinePath) return;
      const baseline = loadJson(baselinePath);
      const current = loadJson(specPath);

      const baselineOps = getOperations(baseline);
      const currentOps = getOperations(current);

      const removed: string[] = [];
      for (const key of baselineOps.keys()) {
        if (!currentOps.has(key)) removed.push(key);
      }

      if (removed.length > 0) {
        expect(
          isMajorBump(baseline.info?.version, current.info?.version),
          `Removed operations [${removed.join(', ')}] require a major version bump ` +
            `(baseline ${baseline.info?.version ?? 'unknown'} -> current ${current.info?.version ?? 'unknown'}). ` +
            `Alternatively, mark them deprecated with deprecated: true and x-sunset before removal.`,
        ).toBe(true);
      }
      expect(removed).toEqual([]);
    });

    it('does not introduce new required request fields without a major version bump', () => {
      if (!specPath || !baselinePath) return;
      const baseline = loadJson(baselinePath);
      const current = loadJson(specPath);

      const baselineOps = getOperations(baseline);
      const currentOps = getOperations(current);

      const violations: string[] = [];
      for (const [key, baselineOp] of baselineOps.entries()) {
        const currentOp = currentOps.get(key);
        if (!currentOp) continue;
        const before = new Set(requiredRequestFields(baselineOp));
        const after = requiredRequestFields(currentOp);
        const added = after.filter((f) => !before.has(f));
        if (added.length > 0) {
          violations.push(`${key}: ${added.join(', ')}`);
        }
      }

      if (violations.length > 0) {
        expect(
          isMajorBump(baseline.info?.version, current.info?.version),
          `New required request fields [${violations.join('; ')}] are a breaking change and require a major version bump.`,
        ).toBe(true);
      }
      expect(violations).toEqual([]);
    });

    it('does not change response schemas without a major version bump', () => {
      if (!specPath || !baselinePath) return;
      const baseline = loadJson(baselinePath);
      const current = loadJson(specPath);

      const baselineOps = getOperations(baseline);
      const currentOps = getOperations(current);

      const violations: string[] = [];
      for (const [key, baselineOp] of baselineOps.entries()) {
        const currentOp = currentOps.get(key);
        if (!currentOp) continue;
        const before = responseSchemaKeys(baselineOp);
        const after = responseSchemaKeys(currentOp);
        if (stableStringify(before) !== stableStringify(after)) {
          violations.push(key);
        }
      }

      if (violations.length > 0) {
        expect(
          isMajorBump(baseline.info?.version, current.info?.version),
          `Response schema changes on [${violations.join(', ')}] require a major version bump.`,
        ).toBe(true);
      }
      expect(violations).toEqual([]);
    });

    it('does not change component schemas without a major version bump', () => {
      if (!specPath || !baselinePath) return;
      const baseline = loadJson(baselinePath);
      const current = loadJson(specPath);

      const baselineSchemas = baseline.components?.schemas ?? {};
      const currentSchemas = current.components?.schemas ?? {};

      const violations: string[] = [];
      for (const [name, schema] of Object.entries(baselineSchemas)) {
        const currentSchema = currentSchemas[name];
        if (currentSchema === undefined) {
          violations.push(`${name} (removed)`);
          continue;
        }
        if (stableStringify(schema) !== stableStringify(currentSchema)) {
          violations.push(`${name} (changed)`);
        }
      }

      if (violations.length > 0) {
        expect(
          isMajorBump(baseline.info?.version, current.info?.version),
          `Component schema changes [${violations.join(', ')}] require a major version bump.`,
        ).toBe(true);
      }
      expect(violations).toEqual([]);
    });
  });

  describe('deprecation annotations', () => {
    it('requires deprecated: true and x-sunset together on every deprecated operation', () => {
      if (!specPath) return;
      const current = loadJson(specPath);
      const ops = getOperations(current);

      const violations: string[] = [];
      for (const [key, op] of ops.entries()) {
        if (isDeprecated(op) && !hasSunset(op)) {
          violations.push(`${key} (missing x-sunset)`);
        }
        if (!isDeprecated(op) && hasSunset(op)) {
          violations.push(`${key} (x-sunset without deprecated: true)`);
        }
      }
      expect(violations).toEqual([]);
    });

    it('uses ISO-8601 dates for x-sunset values', () => {
      if (!specPath) return;
      const current = loadJson(specPath);
      const ops = getOperations(current);

      const isoDate = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;
      const violations: string[] = [];
      for (const [key, op] of ops.entries()) {
        const sunset = op['x-sunset'];
        if (typeof sunset === 'string' && !isoDate.test(sunset)) {
          violations.push(`${key}: ${sunset}`);
        }
      }
      expect(violations).toEqual([]);
    });

    it('does not remove operations that were deprecated in the baseline without a major bump', () => {
      if (!specPath || !baselinePath) return;
      const baseline = loadJson(baselinePath);
      const current = loadJson(specPath);

      const baselineOps = getOperations(baseline);
      const currentOps = getOperations(current);

      const removedDeprecated: string[] = [];
      for (const [key, op] of baselineOps.entries()) {
        if (isDeprecated(op) && !currentOps.has(key)) {
          removedDeprecated.push(key);
        }
      }

      if (removedDeprecated.length > 0) {
        expect(
          isMajorBump(baseline.info?.version, current.info?.version),
          `Removing previously deprecated operations [${removedDeprecated.join(', ')}] still requires a major version bump.`,
        ).toBe(true);
      }
      expect(removedDeprecated).toEqual([]);
    });
  });

  describe('deprecation response headers', () => {
    it('documents Deprecation and Sunset headers on deprecated operations', () => {
      if (!specPath) return;
      const current = loadJson(specPath);
      const ops = getOperations(current);

      const violations: string[] = [];
      for (const [key, op] of ops.entries()) {
        if (!isDeprecated(op)) continue;
        const responses = op.responses ?? {};
        const documentedHeaders = new Set<string>();
        for (const response of Object.values(responses)) {
          for (const headerName of Object.keys(response.headers ?? {})) {
            documentedHeaders.add(headerName.toLowerCase());
          }
        }
        if (!documentedHeaders.has('deprecation')) {
          violations.push(`${key} (missing Deprecation header)`);
        }
        if (!documentedHeaders.has('sunset')) {
          violations.push(`${key} (missing Sunset header)`);
        }
      }
      expect(violations).toEqual([]);
    });
  });
});