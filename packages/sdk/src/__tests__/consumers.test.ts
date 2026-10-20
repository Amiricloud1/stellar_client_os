import { describe, it, expect } from 'vitest';
import * as sdk from '../index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('SDK Package Consumers (ESM, CJS, TypeScript)', () => {
  it('exposes all required core exports in ESM module', () => {
    expect(sdk.VERSION).toBeDefined();
    expect(typeof sdk.VERSION).toBe('string');

    // Clients
    expect(sdk.PaymentStreamClient).toBeDefined();
    expect(sdk.DistributorClient).toBeDefined();
    expect(sdk.PlanterClient).toBeDefined();
    expect(sdk.CampaignFundingClient).toBeDefined();
    expect(sdk.ContractDeployer).toBeDefined();

    // Math & Decimal
    expect(sdk.CheckedMath).toBeDefined();
    expect(sdk.ExactDecimal).toBeDefined();

    // RPC & Config
    expect(sdk.RpcFailoverClient).toBeDefined();
    expect(sdk.validateContractConfig).toBeDefined();
    expect(sdk.validateTransactionConfig).toBeDefined();

    // Events
    expect(sdk.decodeContractEvent).toBeDefined();
    expect(sdk.decodeAllContractEvents).toBeDefined();
    expect(sdk.validateContractEvent).toBeDefined();
  });

  it('validates package.json exports mapping format', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    expect(pkg.name).toBe('@fundable/sdk');
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['.']).toBeDefined();

    const root = pkg.exports['.'];
    expect(root.import).toBeDefined();
    expect(root.require).toBeDefined();

    expect(root.import.types).toBe('./dist/esm/index.d.ts');
    expect(root.import.default).toBe('./dist/esm/index.js');

    expect(root.require.types).toBe('./dist/cjs/index.d.cts');
    expect(root.require.default).toBe('./dist/cjs/index.cjs');
  });
});
