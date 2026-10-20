# Sponsorship & Tax Data Provenance

This document maps **generated/displayed amounts** to their **ledger sources, units, conversion/correction rules, and informational/legal limitations**. It removes the implicit assumptions in tax-document generation so operators can trace any displayed number back to the on-chain ledger entry it came from.

Scope: the platform's campaign sponsorship ledger and the tax-document generation pipeline in `packages/sdk/src/tax.ts` (issue #792).

## Amount Provenance Map

For every amount a user sees in a tax document, trace it through this table:

| Displayed value | Ledger source | Ledger unit | Conversion rule | Correction rule | Provenance |
|-----------------|---------------|-------------|-----------------|-----------------|------------|
| `grossEarningsUSDC` | `campaign_funding` sponsor ledger (per-creator, per-tax-year) | integer USDC units | sum of `amount` across qualifying transactions, `formatUsdcFromInteger` (×100→2dp) | none; amounts are recorded as-is in the ledger | SDK `computeAnnualEarnings` |
| `transaction.amount` | sponsor ledger `amount` field | integer USDC units | identity (no conversion) | none until ledger correction | on-chain contribution record |
| `usdEquivalent` (analytics) | sponsor ledger `amount` × price feed | USD (decimal string) | `amount × priceUsdPerUnit` | sourced from feed, re-source if feed changes | analytics service (not tax pipeline) |

## Units

- **Ledger amounts** are stored as **integer USDC units** (1 USDC = 100 base units) to match the Stellar native-denominated contribution records.
- **Display amounts** are rendered with two decimals (`"12500.00"`) by `formatUsdcFromInteger`.
- `co2Sequestration` and `treeCount` are displayed as printed in the ledger and are **not** currency-amount; they follow their own unit rules (metric tonnes for `co2Sequestration`, whole trees for `treeCount`).

## Conversion Rules

1. Only transactions whose UTC `timestamp` falls inside `taxYear` are counted (UTC calendar year filtering, `isInTaxYear` in `tax.ts`).
2. Each qualifying transaction contributes its ledger `amount` directly; amounts are never summed across different tokens in the tax pipeline (tax documents are token-grouped).
3. `grossEarningsUSDC` is the sum of integer units, formatted with `formatUsdcFromInteger` (two decimals, sign preserved).
4. Conversion to USD (`usdEquivalent`) is **not** part of the tax pipeline; it belongs to the analytics/impact service and uses a price feed. Do not mix it into a 1099 record.

## Correction Rules

- Ledger corrections are recorded as **new** contributor transactions, not by editing historical rows. The tax pipeline must be re-run against the corrected ledger to reflect a corrected amount.
- If a sponsor ledger entry is corrected after the tax year closes, the correction is counted only if its timestamp falls inside the target tax year.
- Tax documents do **not** fabricate amounts: when no transactions qualify, `computeAnnualEarnings` returns zeros (a documented, explicit behavior) rather than `null` or a fabricated figure.

## Informational & Legal Limitations

- Platform-recorded contribution amounts are **informational**. Tax deductibility depends on applicable law and any goods/services received; document issuance does **not** guarantee deductibility.
- A creator's tax attributes (legal name, EIN/VAT ID, residence) are KYC data collected at onboarding, not derived from the ledger. The endpoints take them optionally and default to the wallet address.
- Generated documents are not legal copies: the generated PDF is informational and does not replace statutory filings (e.g. IRS Copy A).
- VAT obligations depend on both supplier's and customer's member state; the generated EU summary reflects platform-measured funding and must be reviewed by the creator's accountant.

## Testing

The tax pipeline's correctness is covered by `packages/sdk/src/__tests__/tax.test.ts`. The docs-validation suite (`packages/sdk/src/__tests__/docs-validation.test.ts`) additionally validates the provenance map: each displayed value has a source, unit, conversion rule, and limitation recorded, and no discovery table row is missing a required field.

## Compatibility & Migration Implications

- Changing the ledger amount representation (for example, moving from integer USDC to a fractional type) requires updating `formatUsdcFromInteger` and the provenance map simultaneously; both must agree on scale.
- Adding a new displayed amount requires adding a row to the provenance map; omitting the `Ledger source` or `Correction rule` columns is a documentation defect and fails CI.
- Tax documents generated with an old ledger schema must be re-issued after a schema migration if the underlying amounts change.
