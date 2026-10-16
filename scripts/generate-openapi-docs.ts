import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface EndpointSummary {
  method: string;
  path: string;
  summary: string;
  operationId: string;
  tags: string[];
}

/**
 * Validates an OpenAPI 3.0.x / 3.1.x specification object.
 */
export function validateOpenApiSpec(spec: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!spec || typeof spec !== "object") {
    return { valid: false, errors: ["Spec must be a non-null object"], warnings };
  }

  // Version check
  if (!spec.openapi || typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    errors.push(`Invalid or missing 'openapi' version: expected 3.x, found ${spec.openapi}`);
  }

  // Info check
  if (!spec.info || typeof spec.info !== "object") {
    errors.push("Missing 'info' object in specification");
  } else {
    if (!spec.info.title || typeof spec.info.title !== "string") {
      errors.push("Missing or invalid 'info.title'");
    }
    if (!spec.info.version || typeof spec.info.version !== "string") {
      errors.push("Missing or invalid 'info.version'");
    }
  }

  // Paths check
  if (!spec.paths || typeof spec.paths !== "object") {
    errors.push("Missing 'paths' object in specification");
    return { valid: false, errors, warnings };
  }

  const pathKeys = Object.keys(spec.paths);
  if (pathKeys.length === 0) {
    errors.push("'paths' object must not be empty");
  }

  const allowedMethods = ["get", "post", "put", "delete", "patch", "options", "head"];

  for (const pathKey of pathKeys) {
    if (!pathKey.startsWith("/")) {
      errors.push(`Path key must start with '/': '${pathKey}'`);
      continue;
    }

    const pathItem = spec.paths[pathKey];
    if (!pathItem || typeof pathItem !== "object") {
      errors.push(`Path '${pathKey}' must be an object`);
      continue;
    }

    let hasMethod = false;
    for (const [key, value] of Object.entries(pathItem)) {
      if (key === "parameters" || key === "summary" || key === "description" || key.startsWith("x-")) {
        continue;
      }

      const methodLower = key.toLowerCase();
      if (!allowedMethods.includes(methodLower)) {
        errors.push(`Path '${pathKey}' contains unsupported HTTP method or field '${key}'`);
        continue;
      }

      hasMethod = true;
      const op = value as any;
      if (!op || typeof op !== "object") {
        errors.push(`Operation '${key.toUpperCase()} ${pathKey}' must be an object`);
        continue;
      }

      if (!op.summary && !op.description) {
        warnings.push(`Operation '${key.toUpperCase()} ${pathKey}' has neither summary nor description`);
      }

      if (!op.responses || typeof op.responses !== "object") {
        errors.push(`Operation '${key.toUpperCase()} ${pathKey}' is missing 'responses' object`);
      } else {
        const responseCodes = Object.keys(op.responses);
        if (responseCodes.length === 0) {
          errors.push(`Operation '${key.toUpperCase()} ${pathKey}' has empty 'responses'`);
        } else {
          const hasSuccessResponse = responseCodes.some(
            (code) => code.startsWith("2") || code === "default" || code === "304"
          );
          if (!hasSuccessResponse) {
            warnings.push(`Operation '${key.toUpperCase()} ${pathKey}' lacks a 2xx success response`);
          }
        }
      }

      // Check parameter formatting
      if (Array.isArray(op.parameters)) {
        for (const [idx, param] of op.parameters.entries()) {
          if (param.$ref) {
            continue;
          }
          if (!param.name) {
            errors.push(`Operation '${key.toUpperCase()} ${pathKey}' parameter at index ${idx} is missing 'name'`);
          }
          if (!param.in) {
            errors.push(`Operation '${key.toUpperCase()} ${pathKey}' parameter '${param.name}' is missing 'in'`);
          } else if (!["query", "path", "header", "cookie"].includes(param.in)) {
            errors.push(
              `Operation '${key.toUpperCase()} ${pathKey}' parameter '${param.name}' has invalid 'in': ${param.in}`
            );
          }
        }
      }
    }

    if (!hasMethod) {
      errors.push(`Path '${pathKey}' has no HTTP operations defined`);
    }
  }

  // Verify $ref resolution locally within components
  const refRegex = /"\\$ref":\s*"#\/components\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)"/g;
  const specJson = JSON.stringify(spec);
  let match;
  while ((match = refRegex.exec(specJson)) !== null) {
    const [, section, refName] = match;
    if (!spec.components || !spec.components[section] || !spec.components[section][refName]) {
      errors.push(`Unresolved $ref: '#/components/${section}/${refName}'`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Generates Markdown reference documentation from an OpenAPI specification object.
 */
export function generateMarkdownReference(spec: any): string {
  const lines: string[] = [];

  lines.push("<!-- This file is auto-generated by scripts/generate-openapi-docs.ts from docs/openapi.yaml. Do not edit manually. -->");
  lines.push("");
  lines.push(`# ${spec.info?.title || "API Reference"}`);
  lines.push("");
  lines.push(`**Version:** \`${spec.info?.version || "0.1.0"}\`  `);
  lines.push(`**OpenAPI Spec:** \`${spec.openapi || "3.0.3"}\`  `);
  if (spec.info?.license) {
    lines.push(`**License:** [${spec.info.license.name || "MIT"}](${spec.info.license.url || "#"})  `);
  }
  lines.push("");

  if (spec.info?.description) {
    lines.push("## Overview");
    lines.push("");
    lines.push(spec.info.description.trim());
    lines.push("");
  }

  if (Array.isArray(spec.servers) && spec.servers.length > 0) {
    lines.push("## Servers");
    lines.push("");
    lines.push("| URL | Description |");
    lines.push("| --- | --- |");
    for (const server of spec.servers) {
      lines.push(`| \`${server.url}\` | ${server.description || "-"} |`);
    }
    lines.push("");
  }

  // Collect endpoints
  const endpoints: EndpointSummary[] = [];
  const allowedMethods = ["get", "post", "put", "delete", "patch", "options", "head"];

  for (const [pathKey, pathItem] of Object.entries<any>(spec.paths || {})) {
    for (const [methodKey, op] of Object.entries<any>(pathItem || {})) {
      if (!allowedMethods.includes(methodKey.toLowerCase())) continue;
      endpoints.push({
        method: methodKey.toUpperCase(),
        path: pathKey,
        summary: op.summary || "",
        operationId: op.operationId || "",
        tags: Array.isArray(op.tags) && op.tags.length > 0 ? op.tags : ["General"],
      });
    }
  }

  // Endpoints Index Table
  lines.push("## Endpoints Summary");
  lines.push("");
  lines.push("| Method | Endpoint | Tag | Summary |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const ep of endpoints) {
    const anchor = `${ep.method.toLowerCase()}-${ep.path.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    lines.push(`| \`${ep.method}\` | [\`${ep.path}\`](#${anchor}) | \`${ep.tags.join(", ")}\` | ${ep.summary.replace(/\|/g, "\\|") || "-"} |`);
  }
  lines.push("");

  // Detailed endpoint sections grouped by tags
  const tagsMap = new Map<string, EndpointSummary[]>();
  for (const ep of endpoints) {
    for (const tag of ep.tags) {
      if (!tagsMap.has(tag)) {
        tagsMap.set(tag, []);
      }
      tagsMap.get(tag)!.push(ep);
    }
  }

  lines.push("## API Reference by Resource");
  lines.push("");

  for (const [tag, tagEndpoints] of tagsMap.entries()) {
    lines.push(`### Tag: ${tag}`);
    lines.push("");

    for (const ep of tagEndpoints) {
      const pathItem = spec.paths[ep.path];
      const op = pathItem[ep.method.toLowerCase()];
      const anchor = `${ep.method.toLowerCase()}-${ep.path.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

      lines.push(`#### \`${ep.method} ${ep.path}\`<a id="${anchor}"></a>`);
      lines.push("");
      if (ep.summary) {
        lines.push(`**Summary:** ${ep.summary}`);
        lines.push("");
      }
      if (op.operationId) {
        lines.push(`**Operation ID:** \`${op.operationId}\`  `);
      }
      lines.push("");

      if (op.description) {
        lines.push(op.description.trim());
        lines.push("");
      }

      // Parameters
      const allParams: any[] = [];
      if (Array.isArray(pathItem.parameters)) {
        allParams.push(...pathItem.parameters);
      }
      if (Array.isArray(op.parameters)) {
        allParams.push(...op.parameters);
      }

      if (allParams.length > 0) {
        lines.push("##### Parameters");
        lines.push("");
        lines.push("| Name | In | Type | Required | Description |");
        lines.push("| :--- | :--- | :--- | :--- | :--- |");

        for (const rawParam of allParams) {
          let param = rawParam;
          if (param.$ref && param.$ref.startsWith("#/components/parameters/")) {
            const paramName = param.$ref.replace("#/components/parameters/", "");
            param = spec.components?.parameters?.[paramName] || rawParam;
          }
          const pName = param.name || "-";
          const pIn = param.in || "-";
          const pType = param.schema?.type || (param.schema?.$ref ? "object" : "string");
          const pReq = param.required ? "**Yes**" : "No";
          const pDesc = (param.description || "-").replace(/\|/g, "\\|").replace(/\n/g, " ");
          lines.push(`| \`${pName}\` | \`${pIn}\` | \`${pType}\` | ${pReq} | ${pDesc} |`);
        }
        lines.push("");
      }

      // Request Body
      if (op.requestBody) {
        lines.push("##### Request Body");
        lines.push("");
        if (op.requestBody.description) {
          lines.push(`${op.requestBody.description}`);
          lines.push("");
        }
        const contentTypes = Object.keys(op.requestBody.content || {});
        for (const ct of contentTypes) {
          lines.push(`- **Content-Type:** \`${ct}\``);
          const schema = op.requestBody.content[ct]?.schema;
          if (schema) {
            if (schema.$ref) {
              lines.push(`- **Schema:** [\`${schema.$ref.replace("#/components/schemas/", "")}\`](#components)`);
            } else if (schema.type) {
              lines.push(`- **Type:** \`${schema.type}\``);
            }
          }
        }
        lines.push("");
      }

      // Responses
      if (op.responses) {
        lines.push("##### Responses");
        lines.push("");
        lines.push("| Status Code | Description | Schema |");
        lines.push("| :--- | :--- | :--- |");

        for (const [statusCode, rawResp] of Object.entries<any>(op.responses)) {
          let resp = rawResp;
          if (resp.$ref && resp.$ref.startsWith("#/components/responses/")) {
            const respName = resp.$ref.replace("#/components/responses/", "");
            resp = spec.components?.responses?.[respName] || rawResp;
          }
          const desc = (resp.description || "-").replace(/\|/g, "\\|").replace(/\n/g, " ");
          let schemaStr = "-";
          const jsonContent = resp.content?.["application/json"]?.schema;
          if (jsonContent) {
            if (jsonContent.$ref) {
              schemaStr = `\`${jsonContent.$ref.replace("#/components/schemas/", "")}\``;
            } else if (jsonContent.type) {
              schemaStr = `\`${jsonContent.type}\``;
            }
          }
          lines.push(`| \`${statusCode}\` | ${desc} | ${schemaStr} |`);
        }
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }
  }

  // Components / Schemas Reference
  if (spec.components?.schemas && Object.keys(spec.components.schemas).length > 0) {
    lines.push("## Components Schemas<a id=\"components\"></a>");
    lines.push("");
    lines.push("| Schema | Type | Description / Properties |");
    lines.push("| :--- | :--- | :--- |");

    for (const [schemaName, schema] of Object.entries<any>(spec.components.schemas)) {
      const sType = schema.type || (schema.enum ? "enum" : "object");
      const props = schema.properties ? Object.keys(schema.properties).join(", ") : "-";
      const desc = schema.description ? schema.description.replace(/\|/g, "\\|") : `Properties: \`${props}\``;
      lines.push(`| \`${schemaName}\` | \`${sType}\` | ${desc} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Main execution entry point.
 */
export function run(args: string[] = process.argv.slice(2)): { exitCode: number; message: string } {
  const rootDir = path.resolve(__dirname, "..");
  const specPath = path.resolve(rootDir, "docs/openapi.yaml");
  const outputPath = path.resolve(rootDir, "docs/api-reference.md");

  if (!fs.existsSync(specPath)) {
    return { exitCode: 1, message: `OpenAPI specification not found at: ${specPath}` };
  }

  const rawYaml = fs.readFileSync(specPath, "utf8");
  let spec: any;
  try {
    spec = yaml.load(rawYaml);
  } catch (err: any) {
    return { exitCode: 1, message: `Failed to parse YAML from ${specPath}: ${err.message}` };
  }

  const validation = validateOpenApiSpec(spec);

  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      console.warn(`[OpenAPI Warning] ${warning}`);
    }
  }

  if (!validation.valid) {
    const errorList = validation.errors.map((e) => `  - ${e}`).join("\n");
    return {
      exitCode: 1,
      message: `OpenAPI validation failed with ${validation.errors.length} error(s):\n${errorList}`,
    };
  }

  console.log(`✓ OpenAPI specification is valid (${Object.keys(spec.paths).length} paths).`);

  if (args.includes("--validate-only")) {
    return { exitCode: 0, message: "OpenAPI validation succeeded." };
  }

  const generatedMarkdown = generateMarkdownReference(spec);

  if (args.includes("--check")) {
    if (!fs.existsSync(outputPath)) {
      return {
        exitCode: 1,
        message: `Reference documentation missing at ${outputPath}. Run 'pnpm docs:openapi:generate' to generate it.`,
      };
    }
    const existingMarkdown = fs.readFileSync(outputPath, "utf8");
    if (existingMarkdown.trim() !== generatedMarkdown.trim()) {
      return {
        exitCode: 1,
        message: `Reference documentation at ${outputPath} is out of sync with docs/openapi.yaml. Run 'pnpm docs:openapi:generate'.`,
      };
    }
    console.log(`✓ Reference documentation is up to date: ${outputPath}`);
    return { exitCode: 0, message: "Reference documentation check passed." };
  }

  fs.writeFileSync(outputPath, generatedMarkdown, "utf8");
  console.log(`✓ Reference documentation generated at: ${outputPath}`);

  return { exitCode: 0, message: `Reference documentation written to ${outputPath}` };
}

// Execute when run directly via CLI
if (process.argv[1] && (process.argv[1].endsWith("generate-openapi-docs.ts") || process.argv[1].endsWith("generate-openapi-docs.js"))) {
  const result = run();
  if (result.exitCode !== 0) {
    console.error(result.message);
    process.exit(result.exitCode);
  }
}
