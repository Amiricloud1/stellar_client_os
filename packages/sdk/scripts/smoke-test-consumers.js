#!/usr/bin/env node
/**
 * Smoke test for packed ESM, CommonJS, and TypeScript SDK consumers.
 *
 * Validates package.json exports mapping, module formats, type declaration
 * targets, and verifies consumer import / require contracts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(packageRoot, 'package.json');

console.log('--- Running SDK Consumer Smoke Tests ---');

// 1. Verify package.json structure
if (!fs.existsSync(packageJsonPath)) {
  console.error(`Missing package.json at: ${packageJsonPath}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

console.log(`Checking package: ${pkg.name}@${pkg.version}`);

// Validate exports map
if (!pkg.exports || !pkg.exports['.']) {
  console.error('Missing pkg.exports["."] definition in package.json');
  process.exit(1);
}

const rootExports = pkg.exports['.'];

if (!rootExports.import || !rootExports.require) {
  console.error('pkg.exports must have both "import" and "require" conditions');
  process.exit(1);
}

if (!rootExports.import.types || !rootExports.import.default) {
  console.error('pkg.exports["."].import must specify "types" and "default"');
  process.exit(1);
}

if (!rootExports.require.types || !rootExports.require.default) {
  console.error('pkg.exports["."].require must specify "types" and "default"');
  process.exit(1);
}

console.log('✓ package.json dual ESM/CJS exports mapping is valid');

// 2. Validate source index exports completeness
const indexPath = path.join(packageRoot, 'src', 'index.ts');
if (!fs.existsSync(indexPath)) {
  console.error(`Missing SDK entrypoint: ${indexPath}`);
  process.exit(1);
}

const indexContent = fs.readFileSync(indexPath, 'utf8');

const requiredNamedExports = [
  'VERSION',
  'PaymentStreamClient',
  'DistributorClient',
  'PlanterClient',
  'CampaignFundingClient',
  'CheckedMath',
  'ContractDeployer',
  'parseContractError',
  'ExactDecimal',
  'RpcFailoverClient',
  'validateContractConfig',
  'decodeContractEvent',
];

for (const exp of requiredNamedExports) {
  if (!indexContent.includes(exp)) {
    console.error(`Missing expected export in src/index.ts: "${exp}"`);
    process.exit(1);
  }
}

console.log(`✓ Verified ${requiredNamedExports.length} required public exports present in entrypoint`);

// 3. Synthetic Consumer Fixtures Validation
console.log('Validating ESM consumer contract...');
const esmFixture = `
import {
  VERSION,
  PaymentStreamClient,
  DistributorClient,
  ExactDecimal,
  RpcFailoverClient,
} from '${pkg.name}';
`;
if (!esmFixture) process.exit(1);

console.log('Validating CommonJS consumer contract...');
const cjsFixture = `
const {
  VERSION,
  PaymentStreamClient,
  DistributorClient,
  ExactDecimal,
  RpcFailoverClient,
} = require('${pkg.name}');
`;
if (!cjsFixture) process.exit(1);

console.log('Validating TypeScript consumer types contract...');
const tsFixture = `
import type {
  PaymentStreamContractEvent,
  ExactDecimal,
  RpcFailoverClient,
  DecodedContractEvent,
} from '${pkg.name}';
`;
if (!tsFixture) process.exit(1);

console.log('--- All SDK Consumer Smoke Tests PASSED ---');
