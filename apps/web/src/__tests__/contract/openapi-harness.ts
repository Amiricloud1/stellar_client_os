import fs from 'fs';
import path from 'path';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Shared contract-test harness for the OpenAPI surface.
 *
 * Responsibilities:
 *  - Load and parse `docs/openapi.yaml` as an OpenAPI 3.0 document.
 *  - Enumerate documented operations (path + method).
 *  - Map documented operations to Next.js route handler files on disk.
 *  - Validate response bodies against documented JSON schemas (ajv).
 *  - Assert documented status codes for success/failure responses.
 *  - Assert auth (Bearer / admin) and pagination (limit/offset) parameters.
 *
 * The harness is intentionally dependency-light and deterministic: it never
 * touches the network or live funds. Suites that need a live handler should
 * import the handler directly and pass the resulting `Response` into the
 * assertion helpers below.
 */

export type HttpMethod =
  | 'get'
  | 'put'
  | 'post'
  | 'delete'
  | 'options'
  | 'head'
  | 'patch'
  | 'trace';

export const HTTP_METHODS: HttpMethod[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

export interface OpenApiParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
}

export interface OpenApiMediaType {
  schema?: Record<string, unknown>;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<string, OpenApiResponse>;
  security?: Array<Record<string, string[]>>;
  'x-sunset'?: string;
  'x-deprecated-since'?: string;
}

export interface OpenApiPathItem {
  parameters?: OpenApiParameter[];
  [method: string]: unknown;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; [key: string]: unknown };
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  security?: Array<Record<string, string[]>>;
  [key: string]: unknown;
}

export interface DocumentedOperation {
  path: string;
  method: HttpMethod;
  operation: OpenApiOperation;
  pathItem: OpenApiPathItem;
  /** Combined path-level + operation-level parameters. */
  parameters: OpenApiParameter[];
  /** Effective security requirements (operation overrides document). */
  security: Array<Record<string, string[]>>;
}

export interface OperationRouteMapping {
  operation: DocumentedOperation;
  /** Absolute path to the resolved route handler file, or null if missing. */
  routeFile: string | null;
  /** Relative path (from repo root) for readable assertions. */
  relativeRouteFile: string | null;
}

const REPO_ROOT = findRepoRoot();

function findRepoRoot(start: string = __dirname): string {
  let dir = start;
  // Walk up until we find a directory containing docs/openapi.yaml.
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'docs', 'openapi.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume monorepo layout relative to this file.
  return path.resolve(__dirname, '..', '..', '..', '..', '..');
}

export function getRepoRoot(): string {
  return REPO_ROOT;
}

export function getOpenApiPath(): string {
  return path.join(REPO_ROOT, 'docs', 'openapi.yaml');
}

export function getWebAppRoot(): string {
  return path.join(REPO_ROOT, 'apps', 'web');
}

/**
 * Minimal YAML parser sufficient for OpenAPI documents.
 *
 * We avoid pulling a full YAML dependency into the test bundle by using the
 * `yaml` package when available and falling back to `js-yaml`. Both are
 * common transitive deps; if neither is present we throw a clear error so CI
 * fails loudly rather than silently skipping contract coverage.
 */
function parseYaml(source: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('yaml');
    if (yaml && typeof yaml.parse === 'function') {
      return yaml.parse(source);
    }
  } catch {
    /* fall through */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jsYaml = require('js-yaml');
    if (jsYaml && typeof jsYaml.load === 'function') {
      return jsYaml.load(source);
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    'Unable to parse docs/openapi.yaml: install `yaml` or `js-yaml` as a dev dependency.',
  );
}

let cachedDocument: OpenApiDocument | null = null;

export function loadOpenApiDocument(): OpenApiDocument {
  if (cachedDocument) return cachedDocument;
  const file = getOpenApiPath();
  if (!fs.existsSync(file)) {
    throw new Error(`OpenAPI document not found at ${file}`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseYaml(raw) as OpenApiDocument;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAPI document did not parse to an object.');
  }
  if (typeof parsed.openapi !== 'string' || !parsed.openapi.startsWith('3.')) {
    throw new Error(
      `Expected an OpenAPI 3.x document, got version ${String(parsed.openapi)}`,
    );
  }
  if (!parsed.paths || typeof parsed.paths !== 'object') {
    throw new Error('OpenAPI document is missing a `paths` object.');
  }
  cachedDocument = parsed;
  return parsed;
}

/** Reset the cached document (useful for tests that mutate the file). */
export function resetOpenApiCache(): void {
  cachedDocument = null;
}

function isHttpMethod(key: string): key is HttpMethod {
  return (HTTP_METHODS as string[]).includes(key);
}

/**
 * Enumerate every documented operation across all paths.
 */
export function enumerateOperations(
  doc: OpenApiDocument = loadOpenApiDocument(),
): DocumentedOperation[] {
  const operations: DocumentedOperation[] = [];
  for (const [routePath, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as OpenApiParameter[])
      : [];
    for (const [method, value] of Object.entries(pathItem)) {
      if (!isHttpMethod(method)) continue;
      const operation = (value ?? {}) as OpenApiOperation;
      const opParams = Array.isArray(operation.parameters)
        ? operation.parameters
        : [];
      const parameters = mergeParameters(pathParams, opParams);
      const security =
        operation.security !== undefined
          ? operation.security
          : doc.security ?? [];
      operations.push({
        path: routePath,
        method,
        operation,
        pathItem,
        parameters,
        security,
      });
    }
  }
  return operations;
}

function mergeParameters(
  base: OpenApiParameter[],
  override: OpenApiParameter[],
): OpenApiParameter[] {
  const key = (p: OpenApiParameter) => `${p.in}:${p.name}`;
  const map = new Map<string, OpenApiParameter>();
  for (const p of base) map.set(key(p), p);
  for (const p of override) map.set(key(p), p);
  return Array.from(map.values());
}

/**
 * Convert an OpenAPI path template (e.g. `/api/campaigns/{id}`) into the
 * candidate Next.js App Router route handler locations.
 */
export function openApiPathToRouteCandidates(routePath: string): string[] {
  const segments = routePath
    .split('/')
    .filter((s) => s.length > 0)
    .map((segment) => {
      const match = segment.match(/^\{(.+)\}$/);
      if (match) {
        return `[${match[1]}]`;
      }
      return segment;
    });
  const appDir = path.join(getWebAppRoot(), 'src', 'app');
  const routeDir = path.join(appDir, ...segments);
  return [
    path.join(routeDir, 'route.ts'),
    path.join(routeDir, 'route.tsx'),
    path.join(routeDir, 'route.js'),
    path.join(routeDir, 'route.jsx'),
  ];
}

/**
 * Resolve the Next.js route handler file for a documented operation.
 */
export function resolveRouteFile(routePath: string): string | null {
  for (const candidate of openApiPathToRouteCandidates(routePath)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Map every documented operation to its route handler file.
 */
export function mapOperationsToRoutes(
  doc: OpenApiDocument = loadOpenApiDocument(),
): OperationRouteMapping[] {
  return enumerateOperations(doc).map((operation) => {
    const routeFile = resolveRouteFile(operation.path);
    return {
      operation,
      routeFile,
      relativeRouteFile: routeFile
        ? path.relative(REPO_ROOT, routeFile).split(path.sep).join('/')
        : null,
    };
  });
}

/**
 * Assert that every documented path/method maps to an existing route handler
 * file. Returns the list of missing mappings (empty when all resolve).
 */
export function findUnmappedOperations(
  doc: OpenApiDocument = loadOpenApiDocument(),
): OperationRouteMapping[] {
  return mapOperationsToRoutes(doc).filter((m) => m.routeFile === null);
}

// ---------------------------------------------------------------------------
// JSON schema validation
// ---------------------------------------------------------------------------

let ajvInstance: Ajv | null = null;

export function getAjv(): Ajv {
  if (ajvInstance) return ajvInstance;
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    validateFormats: true,
  });
  try {
    addFormats(ajv);
  } catch {
    /* formats optional */
  }
  ajvInstance = ajv;
  return ajv;
}

export function resetAjv(): void {
  ajvInstance = null;
}

/**
 * Resolve `$ref` pointers (only local `#/...` refs are supported) against the
 * loaded document.
 */
export function resolveRef(
  ref: string,
  doc: OpenApiDocument = loadOpenApiDocument(),
): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local $ref pointers are supported, got: ${ref}`);
  }
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = doc;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      throw new Error(`Unable to resolve $ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) {
    throw new Error(`Unable to resolve $ref: ${ref}`);
  }
  return current;
}

/**
 * Fully dereference a schema (recursively resolving local `$ref`s) so ajv can
 * validate without needing the whole document registered.
 */
export function dereferenceSchema(
  schema: Record<string, unknown> | undefined,
  doc: OpenApiDocument = loadOpenApiDocument(),
  seen: Set<string> = new Set(),
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) {
      // Circular reference: return a permissive schema to avoid infinite loops.
      return {};
    }
    const nextSeen = new Set(seen);
    nextSeen.add(schema.$ref);
    const resolved = resolveRef(schema.$ref, doc) as Record<string, unknown>;
    return dereferenceSchema(resolved, doc, nextSeen);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] = dereferenceSchema(
          propSchema as Record<string, unknown>,
          doc,
          seen,
        );
      }
      out.properties = props;
    } else if (key === 'items' && value && typeof value === 'object') {
      out.items = dereferenceSchema(
        value as Record<string, unknown>,
        doc,
        seen,
      );
    } else if (
      (key === 'allOf' || key === 'anyOf' || key === 'oneOf') &&
      Array.isArray(value)
    ) {
      out[key] = value.map((sub) =>
        dereferenceSchema(sub as Record<string, unknown>, doc, seen),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build (and cache) an ajv validator for a documented response schema.
 */
const validatorCache = new Map<string, ValidateFunction>();

export function getResponseValidator(
  operation: DocumentedOperation,
  statusCode: string,
  mediaType: string = 'application/json',
  doc: OpenApiDocument = loadOpenApiDocument(),
): ValidateFunction {
  const cacheKey = `${operation.method}:${operation.path}:${statusCode}:${mediaType}`;
  const cached = validatorCache.get(cacheKey);
  if (cached) return cached;

  const response = operation.operation.responses?.[statusCode];
  if (!response) {
    throw new Error(
      `Operation ${operation.method.toUpperCase()} ${operation.path} does not document status ${statusCode}`,
    );
  }
  const content = response.content?.[mediaType];
  if (!content || !content.schema) {
    throw new Error(
      `Operation ${operation.method.toUpperCase()} ${operation.path} status ${statusCode} has no ${mediaType} schema`,
    );
  }
  const schema = dereferenceSchema(content.schema, doc);
  const validator = getAjv().compile(schema ?? {});
  validatorCache.set(cacheKey, validator);
  return validator;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a response body against the documented schema for a status code.
 */
export function validateResponseBody(
  operation: DocumentedOperation,
  statusCode: string,
  body: unknown,
  mediaType: string = 'application/json',
  doc: OpenApiDocument = loadOpenApiDocument(),
): SchemaValidationResult {
  const validator = getResponseValidator(
    operation,
    statusCode,
    mediaType,
    doc,
  );
  const valid = validator(body) as boolean;
  const errors = valid
    ? []
    : (validator.errors ?? []).map(
        (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      );
  return { valid, errors };
}

/**
 * Assert a response body matches the documented schema. Throws with a
 * descriptive message on failure so test output is actionable.
 */
export function assertResponseMatchesSchema(
  operation: DocumentedOperation,
  statusCode: string,
  body: unknown,
  mediaType: string = 'application/json',
  doc: OpenApiDocument = loadOpenApiDocument(),
): void {
  const result = validateResponseBody(
    operation,
    statusCode,
    body,
    mediaType,
    doc,
  );
  if (!result.valid) {
    throw new Error(
      `Response for ${operation.method.toUpperCase()} ${operation.path} [${statusCode}] does not match documented schema:\n  ${result.errors.join(
        '\n  ',
      )}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Status code assertions
// ---------------------------------------------------------------------------

export function documentedStatusCodes(
  operation: DocumentedOperation,
): string[] {
  return Object.keys(operation.operation.responses ?? {});
}

/**
 * Assert that a status code is documented for the operation. Accepts exact
 * codes and the OpenAPI `default` fallback.
 */
export function assertStatusDocumented(
  operation: DocumentedOperation,
  statusCode: number | string,
): void {
  const codes = documentedStatusCodes(operation);
  const code = String(statusCode);
  if (codes.includes(code) || codes.includes('default')) return;
  throw new Error(
    `Status ${code} is not documented for ${operation.method.toUpperCase()} ${operation.path}. Documented: ${codes.join(', ') || '(none)'}`,
  );
}

/**
 * Assert that a success (2xx) status code is documented.
 */
export function assertSuccessStatusDocumented(
  operation: DocumentedOperation,
  statusCode: number | string,
): void {
  const code = String(statusCode);
  if (!/^2\d\d$/.test(code)) {
    throw new Error(`Expected a 2xx status, got ${code}`);
  }
  assertStatusDocumented(operation, code);
}

/**
 * Assert that a failure (4xx/5xx) status code is documented.
 */
export function assertFailureStatusDocumented(
  operation: DocumentedOperation,
  statusCode: number | string,
): void {
  const code = String(statusCode);
  if (!/^[45]\d\d$/.test(code)) {
    throw new Error(`Expected a 4xx/5xx status, got ${code}`);
  }
  assertStatusDocumented(operation, code);
}

// ---------------------------------------------------------------------------
// Auth assertions
// ---------------------------------------------------------------------------

export interface SecuritySchemeInfo {
  name: string;
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
}

export function getSecuritySchemes(
  doc: OpenApiDocument = loadOpenApiDocument(),
): Record<string, SecuritySchemeInfo> {
  const schemes = doc.components?.securitySchemes ?? {};
  const out: Record<string, SecuritySchemeInfo> = {};
  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = raw as Record<string, unknown>;
    out[name] = {
      name,
      type: String(scheme.type ?? ''),
      scheme: scheme.scheme ? String(scheme.scheme) : undefined,
      bearerFormat: scheme.bearerFormat
        ? String(scheme.bearerFormat)
        : undefined,
      in: scheme.in ? String(scheme.in) : undefined,
    };
  }
  return out;
}

/**
 * True when the operation requires authentication (any security requirement
 * with at least one scheme).
 */
export function operationRequiresAuth(
  operation: DocumentedOperation,
): boolean {
  return operation.security.some(
    (requirement) => Object.keys(requirement).length > 0,
  );
}

/**
 * True when the operation requires an admin-scoped credential. Detected via a
 * security scheme name containing "admin" (case-insensitive) or an explicit
 * `x-requires-admin: true` extension.
 */
export function operationRequiresAdmin(
  operation: DocumentedOperation,
): boolean {
  if (operation.operation['x-requires-admin'] === true) return true;
  return operation.security.some((requirement) =>
    Object.keys(requirement).some((scheme) => /admin/i.test(scheme)),
  );
}

/**
 * True when the operation documents a Bearer auth scheme.
 */
export function operationUsesBearer(
  operation: DocumentedOperation,
  doc: OpenApiDocument = loadOpenApiDocument(),
): boolean {
  const schemes = getSecuritySchemes(doc);
  return operation.security.some((requirement) =>
    Object.keys(requirement).some((schemeName) => {
      const scheme = schemes[schemeName];
      return (
        scheme?.type === 'http' &&
        (scheme.scheme ?? '').toLowerCase() === 'bearer'
      );
    }),
  );
}

/**
 * Assert that an unauthenticated request is rejected with a documented 401
 * (or 403) status. `response` is the actual Response from the handler.
 */
export function assertUnauthenticatedRejected(
  operation: DocumentedOperation,
  response: Response,
): void {
  if (!operationRequiresAuth(operation)) {
    throw new Error(
      `Operation ${operation.method.toUpperCase()} ${operation.path} does not require auth; cannot assert unauthenticated rejection.`,
    );
  }
  const status = response.status;
  if (status !== 401 && status !== 403) {
    throw new Error(
      `Expected 401/403 for unauthenticated request to ${operation.method.toUpperCase()} ${operation.path}, got ${status}`,
    );
  }
  assertStatusDocumented(operation, status);
}

/**
 * Assert that an admin-only operation rejects a non-admin credential with a
 * documented 403 (or 401) status.
 */
export function assertNonAdminRejected(
  operation: DocumentedOperation,
  response: Response,
): void {
  if (!operationRequiresAdmin(operation)) {
    throw new Error(
      `Operation ${operation.method.toUpperCase()} ${operation.path} is not admin-scoped; cannot assert non-admin rejection.`,
    );
  }
  const status = response.status;
  if (status !== 403 && status !== 401) {
    throw new Error(
      `Expected 403/401 for non-admin request to ${operation.method.toUpperCase()} ${operation.path}, got ${status}`,
    );
  }
  assertStatusDocumented(operation, status);
}

// ---------------------------------------------------------------------------
// Pagination assertions
// ---------------------------------------------------------------------------

export interface PaginationParams {
  limit?: OpenApiParameter;
  offset?: OpenApiParameter;
}

/**
 * Detect documented pagination parameters (`limit` / `offset`) on an
 * operation. Returns undefined entries when not documented.
 */
export function getPaginationParams(
  operation: DocumentedOperation,
): PaginationParams {
  const find = (name: string) =>
    operation.parameters.find(
      (p) => p.in === 'query' && p.name.toLowerCase() === name,
    );
  return { limit: find('limit'), offset: find('offset') };
}

/**
 * True when the operation documents both `limit` and `offset` query params.
 */
export function operationSupportsPagination(
  operation: DocumentedOperation,
): boolean {
  const { limit, offset } = getPaginationParams(operation);
  return Boolean(limit && offset);
}

/**
 * Assert that a paginated response body honors the documented pagination
 * contract: it must expose the requested `limit`/`offset` (or a `meta`/`page`
 * envelope carrying them) and a total count field.
 */
export function assertPaginationHonored(
  operation: DocumentedOperation,
  body: unknown,
  requested: { limit: number; offset: number },
): void {
  if (!operationSupportsPagination(operation)) {
    throw new Error(
      `Operation ${operation.method.toUpperCase()} ${operation.path} does not document pagination.`,
    );
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Paginated response body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const envelope =
    (record.meta as Record<string, unknown> | undefined) ??
    (record.pagination as Record<string, unknown> | undefined) ??
    record;

  const limit = envelope.limit ?? record.limit;
  const offset = envelope.offset ?? record.offset;
  if (limit !== undefined && Number(limit) !== requested.limit) {
    throw new Error(
      `Expected response limit ${requested.limit}, got ${String(limit)}`,
    );
  }
  if (offset !== undefined && Number(offset) !== requested.offset) {
    throw new Error(
      `Expected response offset ${requested.offset}, got ${String(offset)}`,
    );
  }
  const hasTotal =
    envelope.total !== undefined ||
    record.total !== undefined ||
    envelope.totalCount !== undefined ||
    record.totalCount !== undefined;
  if (!hasTotal) {
    throw new Error(
      'Paginated response must include a total/totalCount field.',
    );
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers for suites
// ---------------------------------------------------------------------------

/**
 * Find a documented operation by path + method. Throws if not documented.
 */
export function findOperation(
  routePath: string,
  method: HttpMethod,
  doc: OpenApiDocument = loadOpenApiDocument(),
): DocumentedOperation {
  const op = enumerateOperations(doc).find(
    (o) => o.path === routePath && o.method === method,
  );
  if (!op) {
    throw new Error(
      `Operation ${method.toUpperCase()} ${routePath} is not documented in OpenAPI.`,
    );
  }
  return op;
}

/**
 * Read a JSON response body safely. Returns `undefined` for empty bodies.
 */
export async function readJsonBody(
  response: Response,
): Promise<unknown | undefined> {
  const text = await response.clone().text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Build a `Request` for a documented operation, filling in path params.
 */
export function buildRequest(
  operation: DocumentedOperation,
  options: {
    baseUrl?: string;
    pathParams?: Record<string, string>;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    body?: unknown;
    method?: HttpMethod;
  } = {},
): Request {
  const baseUrl = options.baseUrl ?? 'http://localhost:3000';
  let resolvedPath = operation.path;
  for (const [key, value] of Object.entries(options.pathParams ?? {})) {
    resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(value));
  }
  const url = new URL(resolvedPath, baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = JSON.stringify(options.body);
  }
  return new Request(url.toString(), {
    method: (options.method ?? operation.method).toUpperCase(),
    headers,
    body,
  });
}