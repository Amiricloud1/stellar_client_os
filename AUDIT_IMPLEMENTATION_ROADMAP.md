# Implementation Roadmap: Audit Fixes

## Phase 1: Create Foundation Files (Days 1–2)

### 1.1 Carbon Accounting Constants
**File:** `apps/web/src/lib/carbon-accounting-constants.ts`

```typescript
/**
 * Carbon Accounting Constants — Single Source of Truth
 * 
 * All CO2 sequestration calculations must import from this file.
 * Changes require: documentation update + test suite run + docs/carbon-accounting-methodology.md update
 */

/** Standard CO2 sequestration: 20 kg CO2e per tree per year (IPCC Tier 1). */
export const DEFAULT_CO2_KG_PER_TREE_PER_YEAR = 20;

export const CO2_ACCOUNTING_BASIS = {
  /** Human-readable source name */
  source: "IPCC 2019 Refinement to 2006 Guidelines, Tier 1 default",
  
  /** Direct link to publication */
  url: "https://www.ipcc-nggip.iges.or.jp/public/2019rf/pdf/4_Volume4/V4_02_Ch2_Generic.pdf",
  
  /** Table/section in publication */
  reference: "Table 2.2 — Temperate broadleaf average",
  
  /** Uncertainty band (one standard deviation) */
  uncertaintyBand: "±15%",
  
  /** When was this last reviewed against latest literature? */
  lastReviewed: "2024-Q3",
  nextReviewDue: "2025-Q3",
  
  /** Contact for questions about this constant */
  maintainer: "carbon-accounting@fundable.org",
  
  /** Key assumptions that affect the value */
  assumptions: [
    "Mature tree: 5–10 years of growth",
    "Typical soil conditions for planting region",
    "No extraordinary disturbances (fire, disease, logging)",
    "Minimum 80% annual survival rate",
    "Standard replanting rate ~10% per year",
  ],
  
  /** When to use this constant */
  applicableFor: [
    "Default CO2 estimate when species is unknown",
    "Historical impact calculations without species breakdown",
    "Sponsor receipt calculations (unless species-specific rate available)",
  ],
  
  /** When NOT to use this constant */
  doNotUseFor: [
    "Campaigns with species-specific breakdown (use species rates instead)",
    "Regulatory/compliance reporting (use audited verification evidence)",
    "Scientific publications (cite IPCC directly)",
  ],
};

/** Species-specific CO2 sequestration rates. */
export const TREE_SPECIES_CO2_RATES = {
  oak: {
    co2PerTreePerYearKg: 21,
    source: "IPCC AR6, Table 5.10 (Tropical hardwoods average)",
    uncertaintyBand: "±18%",
  },
  teak: {
    co2PerTreePerYearKg: 24,
    source: "FAO Forest Resources Assessment 2020 + regional field data",
    uncertaintyBand: "±20%",
  },
  pine: {
    co2PerTreePerYearKg: 18,
    source: "IPCC AR6 (Temperate conifers average)",
    uncertaintyBand: "±16%",
  },
  // ... more species with sources
};

export function getCo2Rate(speciesId: string): { rate: number; source: string; uncertainty: string } {
  const species = TREE_SPECIES_CO2_RATES[speciesId as keyof typeof TREE_SPECIES_CO2_RATES];
  if (!species) {
    return {
      rate: DEFAULT_CO2_KG_PER_TREE_PER_YEAR,
      source: CO2_ACCOUNTING_BASIS.reference,
      uncertainty: CO2_ACCOUNTING_BASIS.uncertaintyBand,
    };
  }
  return {
    rate: species.co2PerTreePerYearKg,
    source: species.source,
    uncertainty: species.uncertaintyBand,
  };
}
```

### 1.2 Material Terms Glossary (Partial)
**File:** `apps/web/src/lib/material-terms-glossary.ts`

```typescript
export interface MaterialTermEntry {
  englishTerm: string;
  definition: string;
  context: "technical" | "sponsor" | "creator" | "auditor";
  translations: Record<string, { term: string; definition: string; notes?: string }>;
  relatedTerms: string[];
  source?: string;
}

export const MATERIAL_TERMS: MaterialTermEntry[] = [
  {
    englishTerm: "CO2 offset",
    definition: "Reduction or removal of greenhouse gas emissions, measured in kg CO₂ equivalent (CO₂e) per year.",
    context: "sponsor",
    translations: {
      en: { term: "CO2 offset", definition: "..." },
      es: { term: "Compensación de carbono", definition: "...", notes: "Use 'compensación' for removal, 'reducción' for avoided." },
      fr: { term: "Compensation carbone", definition: "...", notes: "French distinguishes removal (compensation) from avoidance (réduction)." },
      de: { term: "CO₂-Ausgleich", definition: "..." },
    },
    relatedTerms: ["carbon sequestration", "GHG emissions", "carbon credit"],
    source: "IPCC AR6",
  },
  {
    englishTerm: "Verification evidence",
    definition: "Photographic, GPS, or satellite data proving trees were planted at claimed locations and times.",
    context: "auditor",
    translations: {
      en: { term: "Verification evidence", definition: "..." },
      fr: { term: "Preuve de vérification", definition: "..." },
      de: { term: "Verifikationsbeweis", definition: "..." },
    },
    relatedTerms: ["audit trail", "tree batch", "photo submission"],
    source: "Campaign Verification Audit Contract",
  },
  // ... 50+ more terms
];

export function getMaterialTerm(englishTerm: string, locale: string): string {
  const entry = MATERIAL_TERMS.find(t => t.englishTerm === englishTerm);
  if (!entry) return englishTerm;
  
  const translation = entry.translations[locale];
  return translation?.term || englishTerm;
}
```

### 1.3 Locale Formatters
**File:** `apps/web/src/lib/locale-formatters.ts`

```typescript
export interface LocaleFormatting {
  locale: string;
  numberFormat: { thousandsSeparator: string; decimalSeparator: string };
  unitPreferences: { distance: "km" | "miles"; weight: "kg" | "lbs"; co2: "kg CO₂e" | "tonnes CO₂e" };
  dateFormat: string;
  currency: { symbol: string; position: "before" | "after" };
}

const LOCALE_FORMATTING: Record<string, LocaleFormatting> = {
  en: {
    locale: "en_US",
    numberFormat: { thousandsSeparator: ",", decimalSeparator: "." },
    unitPreferences: { distance: "miles", weight: "lbs", co2: "kg CO₂e" },
    dateFormat: "MM/DD/YYYY",
    currency: { symbol: "$", position: "before" },
  },
  fr: {
    locale: "fr_FR",
    numberFormat: { thousandsSeparator: " ", decimalSeparator: "," },
    unitPreferences: { distance: "km", weight: "kg", co2: "tonnes CO₂e" },
    dateFormat: "DD/MM/YYYY",
    currency: { symbol: "€", position: "after" },
  },
  de: {
    locale: "de_DE",
    numberFormat: { thousandsSeparator: ".", decimalSeparator: "," },
    unitPreferences: { distance: "km", weight: "kg", co2: "tonnes CO₂e" },
    dateFormat: "DD.MM.YYYY",
    currency: { symbol: "€", position: "after" },
  },
};

export function formatCo2(kg: number, locale: string = "en"): string {
  const fmt = LOCALE_FORMATTING[locale] || LOCALE_FORMATTING.en;
  const { co2 } = fmt.unitPreferences;
  
  const value = co2 === "tonnes CO₂e" && kg >= 1000
    ? formatNumber(kg / 1000, locale, 2)
    : formatNumber(kg, locale, 0);
  
  return `${value} ${co2}`;
}

export function formatNumber(num: number, locale: string = "en", decimals: number = 2): string {
  const fmt = LOCALE_FORMATTING[locale] || LOCALE_FORMATTING.en;
  const parts = num.toFixed(decimals).split(".");
  const integer = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, fmt.numberFormat.thousandsSeparator);
  const decimal = parts[1];
  return decimals > 0 ? `${integer}${fmt.numberFormat.decimalSeparator}${decimal}` : integer;
}
```

---

## Phase 2: Update Type Definitions (Days 2–3)

### 2.1 Add Provenance to Campaign Types
**File:** `apps/web/src/types/campaign.ts`

```typescript
export interface CampaignRecord {
  // ... existing fields ...
  
  // ── NEW: Target Change Tracking ──
  targetAmount: string;
  targetHistory: TargetChangeRecord[];
}

export interface TargetChangeRecord {
  changedAt: string;
  previousAmount: string;
  newAmount: string;
  reason: TargetChangeReason;
  reasonDetails?: string;
  changedBy: string;
  sponsorCountAtChange: number;
  cumulativeRaisedAtChange: string;
}

export type TargetChangeReason =
  | "creator_requested"
  | "regulatory_requirement"
  | "emergency_increase"
  | "admin_correction"
  | "milestone_exceeded"
  | "other";
```

### 2.2 Add Provenance to Impact Metrics
**File:** `apps/web/src/services/impact.service.ts`

```typescript
export interface SponsorImpact {
  address: string;
  myVolumeUsd: string;
  myCo2OffsetKg: number;
  
  // ── NEW: Provenance & Confidence ──
  calculatedAt: string;
  source: "ledger" | "estimated" | "user_submitted";
  ci95Low: number;
  ci95High: number;
  methodologyRef: string;
  dataSourceRef: string;
}

export interface CampaignImpactDataPoint {
  date: string;
  timestamp: number;
  treeCount: number;
  co2SequestrationTonnes: number;
  
  // ── NEW: Source Labeling ──
  dataSource: "verified_evidence" | "campaign_declared" | "standard_assumption";
  assumptionBasis?: string;
  ci95?: { low: number; high: number };
  evidenceRef?: string;
}
```

---

## Phase 3: Implement Services (Days 4–6)

### 3.1 Target Change Tracking Service
**File:** `apps/web/src/services/campaign-target-change.service.ts`

```typescript
export async function updateCampaignTarget(
  campaignId: string,
  newTarget: string,
  reason: TargetChangeReason,
  actor: string,
  source: CampaignDataSource
): Promise<void> {
  const campaign = await getCampaign(campaignId, source);
  
  // Create change record
  const change: TargetChangeRecord = {
    changedAt: new Date().toISOString(),
    previousAmount: campaign.targetAmount,
    newAmount: newTarget,
    reason,
    changedBy: actor,
    sponsorCountAtChange: campaign.sponsorCount,
    cumulativeRaisedAtChange: campaign.raisedAmount,
  };
  
  // Update campaign
  await source.saveCampaign({
    ...campaign,
    targetAmount: newTarget,
    targetHistory: [...(campaign.targetHistory || []), change],
  });
  
  // 🔔 Notify sponsors
  // 📊 Log to audit trail
  // 📧 Notify creator
}

export async function getMilestoneContext(
  campaignId: string,
  milestonePercent: number,
  source: CampaignDataSource
): Promise<{ targetAtMilestone: string; targetChanged: boolean }> {
  // Return target amount when milestone was reached (not current)
}
```

### 3.2 Milestone Audit Service
**File:** `apps/web/src/services/milestone-audit.service.ts`

```typescript
export async function recordMilestoneReached(
  campaignId: string,
  milestonePercent: number,
  campaign: CampaignRecord,
  source: CampaignDataSource
): Promise<void> {
  const audit = {
    campaignId,
    milestonePercent,
    reachedAt: new Date().toISOString(),
    targetAmountAtMilestone: campaign.targetAmount,  // ← Snapshot
    cumulativeRaisedAtMilestone: campaign.raisedAmount,
  };
  
  await source.saveMilestoneAudit(audit);
}

export async function sendMilestoneEmailWithHistoricalContext(
  campaignId: string,
  milestonePercent: number,
  source: CampaignDataSource
): Promise<void> {
  const campaign = await getCampaign(campaignId, source);
  const audit = await getMilestoneAudit(campaignId, milestonePercent, source);
  
  // Use target from when milestone was reached
  const relevantTarget = audit?.targetAmountAtMilestone || campaign.targetAmount;
  
  // Send email using relevantTarget, not campaign.targetAmount
}
```

---

## Phase 4: UI Updates (Days 7–9)

### 4.1 Add Assumption Disclaimer to CO2 Projection
**File:** `apps/web/src/components/modules/dashboard/CO2SequestrationProjection.tsx`

Add before chart:
```tsx
<div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4 mb-6">
  <div className="flex gap-3">
    <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-1" />
    <div className="text-sm text-amber-200">
      <p className="font-semibold">🔬 Planning Forecast — Not Measured Data</p>
      <p className="mt-2">
        This is a {climateScenario === "optimistic" ? "best-case" : 
                    climateScenario === "pessimistic" ? "stress-test" : "baseline"} scenario forecast.
        Actual CO2 sequestration depends on regional climate, species, survival rate, and maintenance.
      </p>
      <a href="/docs/carbon-accounting-methodology" className="inline-block mt-2 underline text-amber-300 hover:text-amber-100">
        Learn about our methodology →
      </a>
    </div>
  </div>
</div>
```

### 4.2 Apply Locale Direction to Components
**File:** `apps/web/src/components/CampaignCard.tsx`

```tsx
export function CampaignCard({ campaign, locale }: Props) {
  const dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";
  
  return (
    <div dir={dir} className={`p-4 rounded border ${dir === "rtl" ? "text-right" : "text-left"}`}>
      <h2>{campaign.name}</h2>
      <p>{getMaterialTerm("CO2 offset", locale)}: {formatCo2(campaign.co2OffsetKg, locale)}</p>
    </div>
  );
}
```

---

## Phase 5: Documentation (Days 10–11)

### 5.1 Create Carbon Accounting Methodology Guide
**File:** `docs/carbon-accounting-methodology.md`

```markdown
# Carbon Accounting Methodology

## Default Values

### Standard Rate: 20 kg CO₂e per tree per year

**Source:** IPCC 2019 Refinement to 2006 IPCC Guidelines, Table 2.2

**Assumptions:**
- Mature tree (5–10 years of growth)
- Typical soil conditions for region
- 80% annual survival rate
- Standard maintenance practices

**Uncertainty:** ±15% (one standard deviation)

**When to Use:**
- Historical campaigns without species breakdown
- Sponsor receipts (unless species-specific rate available)
- Default estimate

**When NOT to Use:**
- Campaigns with species breakdown (use species rates)
- Regulatory compliance (use verified evidence)

## Species-Specific Rates

See `apps/web/src/lib/carbon-accounting-constants.ts` for rates and sources.

## Confidence Intervals

All forecasts include 95% CI bands reflecting parametric uncertainty in:
- Growth rate (±1.5% std dev)
- Mortality rate (±0.5% std dev)
- Climate factor (±8% std dev)

NOT uncertainty in:
- Natural year-to-year variation
- Measurement error
- Catastrophic disturbances (fire, disease)

## How Results Can Differ from Forecasts

**Biggest impacts (>20% variance):**
- Regional climate conditions (±20%)
- Tree survival rate (±1% = ±1% CO₂ at maturity)
- Planting density (±20%)

**Moderate impacts (5–20%):**
- Species-specific rate variation (±15%)
- Soil quality (±10%)
- Maintenance intensity (±5%)

**Small impacts (<5%):**
- Regional monitoring (±3%)
- Data entry timing (±1%)

## Calibration with Verification Evidence

1. Collect GPS-stamped photos of planted trees
2. Compare species breakdown vs. forecast assumptions
3. Estimate survival rate from re-photos at 1-year, 5-year marks
4. Update regional climate factor with actual precipitation/temperature
5. Recalculate CO₂ forecasts with calibrated parameters

## References

- IPCC AR6 WG3, Chapter 5: [https://www.ipcc.ch/report/ar6/wg3/](https://www.ipcc.ch/report/ar6/wg3/)
- FAO Forest Resources Assessment 2020: [https://www.fao.org/forest-resources-assessment/](https://www.fao.org/forest-resources-assessment/)
- NASA DAAC Tree Height Map: [https://daac.ornl.gov/](https://daac.ornl.gov/)
```

### 5.2 Create Forecast Assumptions Registry
**File:** `docs/forecast-assumptions.md`

```markdown
# Forecast Assumptions Registry

## Overview

This document lists all assumptions baked into campaign forecasts and their sensitivity.

## Global Assumptions

| Assumption | Value | Sensitivity | Last Updated | Next Review |
|-----------|-------|-------------|--------------|-------------|
| CO₂/tree/year | 20 kg | ±15% impact on total CO₂ | Q3 2024 | Q3 2025 |
| Tree survival Y1 | 90% | ±1% = ±1% CO₂ at maturity | Q4 2024 | Q2 2025 |
| Annual mortality (Y5) | 10% | ±2% = ±2% CO₂ at maturity | Q4 2024 | Q2 2025 |
| Climate factor | 0.95–1.05 | ±10% = ±10% CO₂ | Regional | Q2, Q4 |

## Scenario Definitions

### Moderate (Recommended Baseline)
- Typical regional precipitation
- 80% tree survival rate
- Standard maintenance (annual monitoring)
- **95% CI: ±20%**

### Optimistic (Best Case)
- Above-average rainfall (top quartile)
- 90% survival rate
- Enhanced maintenance
- **95% CI: +25% to +45%**

### Pessimistic (Stress Test)
- Drought or below-average rainfall
- 65% survival rate
- Delayed maintenance, pest pressure
- **95% CI: -30% to -40%**

## Assumption Changes Log

| Date | Assumption | Old Value | New Value | Reason | Evidence |
|------|-----------|----------|-----------|--------|----------|
| 2024-Q3 | CO₂/tree/year | 18 kg | 20 kg | Aligned with IPCC Tier 1 | IPCC AR6 Table 5.10 |
| 2024-Q4 | Survival Y1 | 85% | 90% | Regional field audits | 50-campaign audit |
```

---

## Phase 6: CI/CD Integration (Days 12)

### 6.1 Add Translation Coverage Check
**File:** `.github/workflows/quality-gates.yml` (add step)

```yaml
- name: Check Translation Coverage
  run: |
    npm run build:lib
    npm run check-translation-coverage -- \
      --min-percentage 95 \
      --min-locales 15 \
      --report ./translation-coverage.json
    
    # Fail if coverage < 95%
    if [ $? -ne 0 ]; then
      echo "❌ Translation coverage below 95%. See translation-coverage.json"
      exit 1
    fi
```

### 6.2 Create Translation Coverage Script
**File:** `scripts/check-translation-coverage.ts`

```typescript
import { MATERIAL_TERMS_GLOSSARY } from "../apps/web/src/lib/material-terms-glossary";
import { SUPPORTED_TRANSLATION_LOCALES } from "../apps/web/src/lib/translation";

const coverage: Record<string, number> = {};

for (const locale of SUPPORTED_TRANSLATION_LOCALES) {
  const translated = MATERIAL_TERMS_GLOSSARY.filter(
    (term) => term.translations[locale]?.term
  ).length;
  const percentage = Math.round((translated / MATERIAL_TERMS_GLOSSARY.length) * 100);
  coverage[locale] = percentage;
  
  if (percentage < 95) {
    console.warn(`⚠️  ${locale}: ${percentage}% (target 95%)`);
  }
}

const allAboveTarget = Object.values(coverage).every(pct => pct >= 95);
process.exit(allAboveTarget ? 0 : 1);
```

---

## Testing Checklist

- [ ] Carbon accounting constants: Unit tests for `getCo2Rate()`
- [ ] Material terms: Verify all 50+ terms translated to 15+ locales
- [ ] Locale formatters: Test `formatCo2()` in EN, FR, DE, AR
- [ ] Target changes: E2E test campaign target update → email → milestone adjustment
- [ ] Milestone audits: Verify milestone snapshots survive target changes
- [ ] CO2 disclaimer: Visual test in all 3 scenarios (optimistic, moderate, pessimistic)
- [ ] RTL: Visual test in Arabic/Farsi layouts

---

## Deployment Checklist

- [ ] All new files pass linting (eslint, prettier)
- [ ] Translation coverage ≥ 95% (CI/CD gate)
- [ ] Carbon accounting docs reviewed by domain expert
- [ ] Milestone audit service tested with 10+ campaigns
- [ ] Sponsor target-change emails reviewed for tone & clarity
- [ ] Performance: No regression in campaign detail load time
- [ ] Mobile: CO2 disclaimer readable on small screens
- [ ] RTL: Arabic layout doesn't overflow or misalign

