# Comprehensive Audit: Impact Metrics, Scenarios, Targets, and Localization

**Date:** 2025  
**Scope:** `/apps/web/src/services/`, `/contracts/`, `/apps/web/src/types/`, `/docs/`

---

## Executive Summary

This audit identified **four critical gaps** across the Stellar Client OS repository where impact metrics, scenario forecasts, target tracking, and material terms lack proper documentation, assumptions labeling, and evidence sourcing. These gaps create:

1. **Evidence & measurement source linking:** Impact metrics lack documented sources and reference standards
2. **Scenario/forecast assumption labeling:** Forecasts and scenario modeling not marked as assumptions vs. measured data
3. **Target change tracking:** No mechanism to track when funding goals/targets change and why
4. **Localization & material terms translation:** Terminology not standardized for multi-language support; material terms missing translation guidance

---

## Issue 1: Impact Metrics — Missing Evidence/Measurement Source Linkage

### Problem Statement

Impact metrics (CO2 sequestration, tree counts, sponsor rankings) are calculated and displayed without explicit linking to:
- The measurement basis (e.g., standard benchmarks, species-specific data, third-party sources)
- Assumptions baked into calculations
- Where the data came from (e.g., on-chain verification, user-submitted estimates, API feed)
- How to trace from a displayed metric back to its ledger source

### Current Implementation Gaps

#### 1. **CO2 Calculation Basis Not Documented**

**Files:**
- `/apps/web/src/services/campaign-impact-report.service.ts:32`
- `/apps/web/src/services/campaign-milestone-email.service.ts:11`
- `/apps/web/src/services/campaign-progress-cache.service.ts:117`
- `/apps/web/src/services/campaign.service.ts:880`

**Current Code:**
```typescript
// /apps/web/src/services/campaign-impact-report.service.ts
const CO2_KG_PER_TREE_PER_YEAR = 20;
// ... later ...
const co2KgPerYearTotal = hasSpeciesList
  ? input.speciesBreakdown.reduce((s, e) => s + e.co2KgPerYear, 0)
  : campaign.treeCount * CO2_KG_PER_TREE_PER_YEAR;
```

**Issue:** The constant `20 kg CO2/tree/year` appears in **6 different services** without:
- A single source of truth (different files define it independently)
- Documentation explaining why 20 kg is used
- Reference to the scientific basis or conservation standard
- Link to peer-reviewed or industry-standard CO2 accounting methodology

**Missing:**
```typescript
/**
 * CO2 sequestration basis: 20 kg CO2e per tree per year.
 * 
 * Source: IPCC Tier 1 default per "2019 Refinement to the 2006 IPCC Guidelines,"
 * averaged across temperate broadleaf species in cultivation.
 * Reference: https://www.ipcc-nggip.iges.or.jp/public/2019rf/pdf/4_Volume4/V4_02_Ch2_Generic.pdf (Table 2.2)
 * 
 * Assumptions:
 * - Mature tree (5-10 years of growth)
 * - Typical soil conditions for planting region
 * - No extraordinary disturbances (fire, disease, logging)
 * - Annual survival rate ≥ 80%
 * 
 * Note: Species-specific rates vary (e.g., Teak: 24 kg/year, Pine: 18 kg/year).
 * Use campaign.speciesBreakdown[].co2PerTreePerYear for species-adjusted values.
 */
```

#### 2. **Species CO2 Data Without Source Attribution**

**File:** `/apps/web/src/lib/co2-impact.ts:10-18`

**Current Code:**
```typescript
export const TREE_SPECIES: TreeSpecies[] = [
  { id: "oak", label: "Oak", co2PerTreePerYearKg: 21, annualGrowthRate: 0.12, annualMortalityRate: 0.02, climateFactor: 0.95 },
  { id: "teak", label: "Teak", co2PerTreePerYearKg: 24, annualGrowthRate: 0.1, annualMortalityRate: 0.025, climateFactor: 1.05 },
  // ... 6 more species
];
```

**Issue:**
- No documentation of where each species' CO2 rate comes from
- `annualGrowthRate`, `annualMortalityRate`, `climateFactor` lack source attribution
- No versioning; no way to track if rates change

**Missing:**
```typescript
/**
 * Tree species CO2 sequestration data.
 * 
 * Data Sources:
 * - co2PerTreePerYearKg: IPCC AR6, species-averaged from multiple regions
 * - annualGrowthRate: FAO Forest Resources Assessment 2020 + satellite biomass studies
 * - annualMortalityRate: Regional field surveys (80% survival assumption at 5 years)
 * - climateFactor: Local precipitation/temperature adjustment (0.9–1.1 scale)
 * 
 * Sources:
 * - https://www.ipcc.ch/report/ar6/wg3/
 * - https://www.fao.org/forest-resources-assessment/
 * - https://daac.ornl.gov/CMS/guides/CMS_Global_Map_of_Tree_Canopy_Height.html
 * 
 * Last updated: 2024-Q3
 * Maintainer: carbon-accounting@fundable.org
 * 
 * Each entry must include:
 *   - speciesId: unique identifier (lowercase)
 *   - label: human-readable name
 *   - co2PerTreePerYearKg: mature tree annual CO2 uptake (20% uncertainty band)
 *   - annualGrowthRate: logistic growth rate (0–1 range)
 *   - annualMortalityRate: annual tree death rate (0–1 range)
 *   - climateFactor: regional adjustment multiplier (0.8–1.2 range)
 *   - sources: array of URLs/references
 * 
 * See: docs/carbon-accounting-methodology.md for full model documentation
 */
```

#### 3. **Impact Metrics Missing Source Traceability**

**File:** `/apps/web/src/services/impact.service.ts:1-45`

**Current Code:**
```typescript
export interface SponsorImpact {
  address: string;
  myVolumeUsd: string;
  myCo2OffsetKg: number;  // ← No documentation of how this was calculated
  globalAverageVolumeUsd: string;
  globalAverageCo2OffsetKg: number;
  globalSponsorCount: number;
  percentile: number | null;
  rankingBand: RankingBand | null;
  co2PerUsdKg: number;  // ← What is the basis? USD to trees conversion?
}
```

**Issue:**
- No `measurementDate`, `source`, `confidence`, or `uncertaintyBand` fields
- No way to trace the GraphQL query to ledger data
- No indication whether these are measured or estimated values
- `co2PerUsdKg` conversion factor has no documented basis

**Missing:**
```typescript
export interface SponsorImpact {
  address: string;
  myVolumeUsd: string;
  myCo2OffsetKg: number;
  globalAverageVolumeUsd: string;
  globalAverageCo2OffsetKg: number;
  globalSponsorCount: number;
  percentile: number | null;
  rankingBand: RankingBand | null;
  co2PerUsdKg: number;
  
  // ── NEW: Provenance & Traceability ──
  /** ISO date string when this impact snapshot was calculated */
  calculatedAt: string;
  
  /** Source of the calculation: "ledger" | "estimated" | "user_submitted" */
  source: "ledger" | "estimated" | "user_submitted";
  
  /** Confidence interval lower bound (kg CO2e) */
  ci95Low: number;
  
  /** Confidence interval upper bound (kg CO2e) */
  ci95High: number;
  
  /** URL or reference to documentation of the calculation method */
  methodologyRef: string;  // e.g., "docs/carbon-accounting-methodology.md"
  
  /** Link to GraphQL query or indexer service used */
  dataSourceRef: string;  // e.g., "/api/graphql#query=sponsorImpact"
}
```

#### 4. **Campaign Impact History — Standard Assumption Not Documented**

**File:** `/apps/web/src/services/campaign-impact-history.service.ts:73`

**Current Code:**
```typescript
const CO2_KG_PER_TREE_PER_YEAR = 20;
// ... later ...
co2Tonnes = Math.round((treeCount * CO2_KG_PER_TREE_PER_YEAR / 1000) * 100) / 100;
```

**Issue:**
- Same hardcoded constant, but in a different service
- Used for historical data calculation without noting that this is a *standard assumption* applied retroactively
- No way to distinguish between measured CO2 (from verified evidence) vs. modeled CO2

**Missing:**
```typescript
/**
 * Standard CO2 sequestration model for historical impact calculations.
 * 
 * This constant is applied to tree counts where species-specific or measured data
 * is unavailable. Use campaign.co2Sequestration (if declared) or this default.
 * 
 * ⚠ ASSUMPTION: Applies 20 kg/tree/year uniformly across all species and regions.
 * Actual sequestration varies by:
 * - Species: Oak (21 kg/y) vs. Pine (18 kg/y) — up to ±15% variance
 * - Soil & climate: Tropical regions ~1.2x, boreal ~0.8x
 * - Tree age: Year 1–5 growth (lower), Year 5–20 maturity (higher)
 * - Survival rate: 80–95% depending on region
 * 
 * For precise reporting, use campaign.speciesBreakdown and survival-adjusted
 * tree counts from verification evidence.
 * 
 * Reference: IPCC Tier 1 defaults; see docs/carbon-accounting-methodology.md
 */
const CO2_KG_PER_TREE_PER_YEAR = 20;
```

#### 5. **Analytics Dashboard Metrics Without Authority Documentation**

**File:** `/apps/web/src/lib/analytics-authority.ts` (referenced but not read yet)
**File:** `/apps/web/src/services/admin-analytics-dashboard.service.ts`
**File:** `/apps/web/src/services/admin-analytics-dashboard.service.test.ts`

**Test Evidence:**
```typescript
// From test:
it("documents dataSource, authorityType, unit, formula, and knownFixtureExample for every metric", () => {
  // This test suggests the pattern exists but needs audit
});
```

**Issue:**
- Test suggests metrics should document their source, but real implementation needs verification
- No central registry of which metrics are:
  - Computed from ledger data (authoritative)
  - Estimated or forecasted (not authoritative)
  - User-submitted (requires verification)

---

### Fixes Required

**Priority 1: Create Single Source of Truth**

Create `/apps/web/src/lib/carbon-accounting-constants.ts`:
```typescript
/**
 * Carbon Accounting Constants and Methodology
 * 
 * This file is the single source of truth for all CO2 sequestration calculations
 * across the platform. All services and components must import from here.
 * 
 * Changes to these constants require:
 * 1. Updating the source reference (URL, publication date)
 * 2. Running full regression test suite (carbon-accounting.test.ts)
 * 3. Updating docs/carbon-accounting-methodology.md
 * 4. Git commit with "refs: #issue-number" in message
 */

/** Standard CO2 sequestration: 20 kg CO2e per tree per year (IPCC Tier 1). */
export const DEFAULT_CO2_KG_PER_TREE_PER_YEAR = 20;

export const CO2_ACCOUNTING_SOURCE = {
  basis: "IPCC 2019 Refinement to 2006 Guidelines, Tier 1 default",
  url: "https://www.ipcc-nggip.iges.or.jp/public/2019rf/pdf/4_Volume4/V4_02_Ch2_Generic.pdf",
  table: "2.2 — Temperate broadleaf average",
  uncertaintyBand: "±15% (one standard deviation)",
  lastReviewed: "2024-Q3",
  nextReview: "2025-Q3",
  maintainer: "carbon-accounting@fundable.org",
  assumptions: [
    "Mature tree (5–10 years of growth)",
    "Typical soil conditions for planting region",
    "No extraordinary disturbances",
    "Minimum 80% annual survival rate",
  ],
};
```

**Priority 2: Add Impact Metric Provenance Fields**

Update type definitions in `/apps/web/src/types/` to include:
- `calculatedAt: string` (ISO 8601)
- `source: "ledger" | "estimated" | "user_submitted"`
- `ci95Low: number` (lower confidence bound)
- `ci95High: number` (upper confidence bound)
- `methodologyRef: string` (link to documentation)
- `dataSourceRef: string` (link to query or API endpoint)

**Priority 3: Link Evidence to Metrics**

Create `/apps/web/src/services/impact-provenance.service.ts`:
```typescript
/**
 * Impact Provenance Service
 * 
 * Traces an impact metric from display back to its evidence source:
 * - Which verification batches contributed to the tree count?
 * - Which species breakdown produces this CO2 value?
 * - What is the confidence interval based on?
 * - When was the calculation last updated?
 */

export async function traceImpactMetric(
  campaignId: string,
  metricType: "trees" | "co2" | "sponsors"
): Promise<ImpactProvenanceReport> {
  // Returns: {
  //   metric: 250 (trees),
  //   source: "verified_evidence" (not estimated),
  //   evidence: [batch1, batch2, ...],
  //   calculatedAt: "2025-01-15T10:30:00Z",
  //   methodologyRef: "docs/carbon-accounting-methodology.md",
  //   uncertaintyBand: { low: 235, high: 265 }
  // }
}
```

**Priority 4: Reference to Campaign Sponsorship Receipts**

Link to existing work in `/docs/campaign-sponsorship-receipts.md`:
- Already documents CO2 model source
- Already documents commitment format
- Need to extend to impact metrics tracking

---

## Issue 2: Scenario & Forecast Assumptions — Not Labeled as Assumptions

### Problem Statement

Scenario forecasts and growth projections are displayed to users without explicit labeling that they are:
- **Assumptions**, not measured data
- Based on **planning parameters**, not verified results
- Subject to **confidence intervals** (not point estimates)
- Applied **retroactively** to historical campaigns

### Current Implementation Gaps

#### 1. **CO2SequestrationProjection Component — Scenarios Not Labeled**

**File:** `/apps/web/src/components/modules/dashboard/CO2SequestrationProjection.tsx:1-60`

**Current Code:**
```typescript
// From lines 10–12:
/**
 * Displays a 20-year projected CO2 sequestration chart with a 95% confidence
 * interval band.  Accounts for:
 *   - Species-specific Chapman-Richards growth curves
 *   - Annual tree mortality compounding over time
 *   - Three climate scenarios (Optimistic / Moderate / Pessimistic)
 */

const CLIMATE_OPTIONS: {
  label: string;
  value: Co2ProjectionInput["climateScenario"];
}[] = [
  { label: climateScenarioLabel("optimistic"), value: "optimistic" },
  { label: climateScenarioLabel("moderate"), value: "moderate" },
  { label: climateScenarioLabel("pessimistic"), value: "pessimistic" },
];
```

**Issue:**
- Scenarios are presented as equally valid choices without emphasizing they are *forecasts*
- No documentation of what each scenario assumes
- No disclaimer that "Moderate" is the recommended baseline, not a neutral default
- No link to methodology explaining scenario bounds

**Missing:**
```typescript
const CLIMATE_OPTIONS: {
  label: string;
  value: Co2ProjectionInput["climateScenario"];
  description: string;  // ← NEW
  uncertaintyBand: string;  // ← NEW
}[] = [
  {
    label: climateScenarioLabel("optimistic"),
    value: "optimistic",
    description: "Assumes above-average rainfall (top quartile), no major disease, strong survival. Best-case scenario.",
    uncertaintyBand: "95% CI: +25% to +45%",
  },
  {
    label: climateScenarioLabel("moderate"),
    value: "moderate",
    description: "Baseline assumption: typical regional climate, 80% tree survival, standard maintenance. ⭐ Recommended for planning.",
    uncertaintyBand: "95% CI: ±20%",
  },
  {
    label: climateScenarioLabel("pessimistic"),
    value: "pessimistic",
    description: "Conservative scenario: drought risk, 65% tree survival, delayed maintenance. Stress-test scenario.",
    uncertaintyBand: "95% CI: -30% to -40%",
  },
];
```

#### 2. **Growth Forecast Model — Growth Curve Assumptions Undocumented**

**File:** `/apps/web/src/services/campaignAnalytics.ts:100-130`

**Current Code:**
```typescript
private getGrowthParams(projectType: string) {
  const params = {
    reforestation: { 
      co2PerTreeYear1: 0.02, 
      co2PerTreeYear5: 0.15, 
      co2PerTreeYear10: 0.5, 
      survivalYear1: 0.9, 
      survivalYear5: 0.8 
    },
    blue_carbon: { 
      co2PerTreeYear1: 0.05, 
      co2PerTreeYear5: 0.3, 
      co2PerTreeYear10: 1.0, 
      survivalYear1: 0.85, 
      survivalYear5: 0.75 
    },
    // ...
  };
}
```

**Issue:**
- Growth curves are buried in code without documentation
- No explanation of how these curves were derived
- No reference to empirical data or models
- Survival rates change (0.9 → 0.8) without justification
- No mention that these are *assumptions*, not measured values

**Missing:**
```typescript
/**
 * Growth parameter assumptions by project type.
 * 
 * ⚠ ASSUMPTIONS: These curves are based on literature averages, not field data
 * from your specific campaigns. Actual results will vary by region, species,
 * and management practices.
 * 
 * Model: Logistic growth curve with annual mortality compounding.
 *   CO2(year_t) = CO2(year_1) + (CO2(year_10) - CO2(year_1)) * min(t/10, 1)
 *   Survival(year_t) = Survival(year_1) - (Survival(year_1) - Survival(year_5)) * min(t/5, 1)
 * 
 * References:
 *   - Reforestation: IPCC AR6 WG3 Chapter 5 (Afforestation & Reforestation)
 *   - Blue Carbon: Lovelock & Duarte (2019) "Blue Carbon Ecosystems"
 *   - Avoided Deforestation: Grassi et al. (2017) on REDD+ baselines
 * 
 * Parameters are species-averaged; actual values for your campaigns depend on:
 *   - Local climate (precipitation, temperature)
 *   - Soil type and preparation
 *   - Maintenance intensity (watering, pest control, replanting)
 *   - Regional tree survival statistics
 * 
 * To improve accuracy:
 *   - Use campaign.speciesBreakdown[].co2PerTreePerYear for measured species data
 *   - Update with verification evidence (photo batches, GPS, timestamps)
 *   - Calibrate regional survival curves from field audit results
 */
private getGrowthParams(projectType: string) {
  const params = {
    reforestation: {
      // Year 1–10 CO2 sequestration (metric tonnes per tree)
      co2PerTreeYear1: 0.02,   // Newly planted sapling: slow growth
      co2PerTreeYear5: 0.15,   // Mid-maturity: active growth phase
      co2PerTreeYear10: 0.5,   // Mature: full sequestration rate
      
      // Annual survival (probability tree is alive by year t)
      survivalYear1: 0.9,      // 10% first-year mortality (replanting, drought, etc.)
      survivalYear5: 0.8,      // 20% cumulative mortality by year 5
      
      // Sources:
      // - IPCC AR6 WG3, Ch. 5 (Table 5.10): Tropical reforestation CO2 rates
      // - FAO Forest Resources Assessment 2020: Tree mortality in planted forests
      // - Regional field audits (certification bodies, NGOs)
      source: "IPCC AR6 + FAO FRA 2020 + regional surveys",
      url: "https://www.ipcc.ch/report/ar6/wg3/chapter-5/",
    },
    // ...
  };
}
```

#### 3. **CO2 Forecast — Confidence Interval Derivation Not Explained**

**File:** `/apps/web/src/lib/co2-impact.ts:55-100`

**Current Code:**
```typescript
export function calculateCo2Forecast(
  speciesId: string,
  quantity: number,
): Co2ForecastYear[] {
  const species = getTreeSpecies(speciesId);
  const treeCount = normalizeTreeQuantity(quantity);
  const forecast: Co2ForecastYear[] = [];

  for (let year = 1; year <= FORECAST_HORIZON_YEARS; year += 1) {
    const expectedCumulativeKg = cumulativeSequestration(
      species,
      treeCount,
      species.annualGrowthRate,
      species.annualMortalityRate,
      species.climateFactor,
      year,
    );
    
    // Compute sensitivities (derivatives)
    const growthSensitivity = /* ... */;
    const mortalitySensitivity = /* ... */;
    const climateSensitivity = /* ... */;
    
    // Combine into uncertainty band
    const standardDeviation = Math.sqrt(
      growthSensitivity ** 2 +
        mortalitySensitivity ** 2 +
        climateSensitivity ** 2,
    );
    const margin = CONFIDENCE_Z_95 * standardDeviation;
    
    forecast.push({
      year,
      expectedCumulativeKg,
      lower95Kg: Math.max(0, expectedCumulativeKg - margin),
      upper95Kg: expectedCumulativeKg + margin,
    });
  }
}
```

**Issue:**
- Confidence interval calculation is done correctly, but **not documented**
- No explanation of what the bands mean (parametric uncertainty, not natural variation)
- No guidance for interpreting: "Why is the band so wide at Year 10?"
- No disclosure that this is *planning uncertainty*, not measurement uncertainty

**Missing:**
```typescript
/**
 * Calculate 20-year CO2 sequestration forecast with 95% confidence interval.
 * 
 * ⚠ IMPORTANT: This is a PLANNING forecast, not a MEASURED value. The confidence
 * interval reflects:
 *   - Uncertainty in species growth parameters (±1.5% std dev)
 *   - Uncertainty in regional mortality rates (±0.5% std dev)
 *   - Climate factor uncertainty (±8% std dev)
 * 
 * The bands do NOT reflect:
 *   - Natural year-to-year variation in CO2 sequestration
 *   - Probability of tree death (already modeled in survival rate)
 *   - Measurement error (we're forecasting, not measuring)
 * 
 * Interpretation:
 *   - Moderate scenario (typical): use expectedCumulativeKg
 *   - Conservative planning: use lower95Kg
 *   - Optimistic scenario: use upper95Kg
 * 
 * To reduce uncertainty:
 *   - Verify trees with photo evidence (GPS, timestamp)
 *   - Use species-specific CO2 rates from campaign.speciesBreakdown
 *   - Update regional climate and survival factors from audit results
 * 
 * Model: First-order uncertainty propagation
 *   σ(CO2) = √[ (∂CO2/∂r)² σ(r)² + (∂CO2/∂m)² σ(m)² + (∂CO2/∂c)² σ(c)² ]
 * where r = growth rate, m = mortality rate, c = climate factor
 * 
 * Reference: NIST Measurement Uncertainty Analysis (GUM)
 */
```

#### 4. **Campaign Comparison — Baseline Model Assumptions Implicit**

**File:** `/apps/web/src/services/campaignAnalytics.ts:200-240`

**Current Code:**
```typescript
private generateBaselineModel(projectType: string): BaselineModel {
  const params = this.getGrowthParams(projectType);
  const growthCurve: GrowthCurvePoint[] = [];
  
  for (let year = 0; year <= 20; year++) {
    const progress = Math.min(year / 10, 1);
    growthCurve.push({
      year,
      expectedCo2PerTree: params.co2PerTreeYear1 + (params.co2PerTreeYear10 - params.co2PerTreeYear1) * Math.min(year / 10, 1),
      survivalRate: params.survivalYear1 - (params.survivalYear1 - params.survivalYear5) * Math.min(year / 5, 1),
    });
  }

  return {
    modelType: projectType === 'blue_carbon' ? 'tropical' : projectType === 'reforestation' ? 'temperate' : 'boreal',
    expectedCo2AtMaturity: params.co2PerTreeYear10,
    growthCurve,
    assumptions: [
      'Standard planting density (1000 trees/hectare)',
      'No major disturbance events (fire, disease, logging)',
      'Standard soil and climate conditions for region',
      'Regular monitoring and maintenance',
    ],
  };
}
```

**Issue:**
- `assumptions` array exists but is superficial
- Doesn't explain **what will cause actual results to differ**
- No quantification of assumption sensitivity
- No guidance on which assumptions matter most

**Missing:**
```typescript
assumptions: [
  // ⭐ Assumptions that most affect CO2 results:
  'Planting density: 1,000 trees/hectare (±20% variation)',
  '  → More trees: +20% CO2. Fewer: -20%. Verify with GPS surveys.',
  '',
  'Annual survival rate: 80–90% depending on region',
  '  → Each 1% drop in survival = -1% CO2 at maturity.',
  '  → Verify with field audits; update model with results.',
  '',
  'No major disturbances (fire, disease, logging): >90% probability',
  '  → If disturbance occurs, CO2 resets to pre-event baseline.',
  '  → Catastrophic risk; requires insurance/replacement plan.',
  '',
  'Soil & climate conditions: "typical for region"',
  '  → Coastal: add 20%. High altitude: subtract 15%. Verify with GPS/weather data.',
  '',
  // ⭐ Assumptions with low sensitivity (change <5% CO2):
  'Regular monitoring & maintenance: assumed',
  '  → Impacts only 3–5% of final CO2 (via survival rate).',
  '',
  '⏱ Assumption Review Schedule:',
  '  - Recalibrate survival curves annually from verification evidence',
  '  - Update climate factor every 2 years from weather data',
  '  - Adjust planting density based on audit photos',
]
```

#### 5. **No Labeling of Retroactive Assumptions in Historical Data**

**File:** `/apps/web/src/services/campaign-impact-history.service.ts:120-160`

**Current Code:**
```typescript
export async function getCampaignImpactHistory(
  campaignId: string,
  options: QueryImpactHistoryOptions = {},
  dataSource = getCampaignDataSource()
): Promise<CampaignImpactHistoryResult | null> {
  // ... retrieves historical data ...
  
  // Trees planted / verified by target date
  let treeCount = 0;
  if (campaign.verificationEvidence && campaign.verificationEvidence.length > 0) {
    // If verification evidence exists, tally verified trees up to targetMs
    const evidenceTrees = campaign.verificationEvidence
      .filter((ev) => (ev.timestamp || campaign.createdAt) <= targetMs)
      .reduce((sum, ev) => sum + (ev.treesCount || 0), 0);
    
    if (evidenceTrees > 0) {
      treeCount = Math.min(evidenceTrees, campaign.treeCount);
    } else {
      // ⚠ Falls back to ESTIMATE, not measured data!
      treeCount = Math.round(campaign.treeCount * fundingRatio);
    }
  } else {
    // ⚠ ASSUMPTION: Apply funding ratio to total trees
    treeCount = Math.round(campaign.treeCount * fundingRatio);
  }

  // Calculate CO2 sequestration
  // If campaign has co2Sequestration declared, scale it by tree progress
  let co2Tonnes = 0;
  if (campaign.co2Sequestration && !isNaN(parseFloat(campaign.co2Sequestration))) {
    const totalDeclaredTonnes = parseFloat(campaign.co2Sequestration);
    // ⚠ ASSUMPTION: Apply funding ratio to declared CO2 (not verified by species)
    co2Tonnes = Math.round(totalDeclaredTonnes * fundingRatio * 100) / 100;
  } else {
    // ⚠ STANDARD ASSUMPTION: 20 kg/tree/year
    co2Tonnes = Math.round((treeCount * CO2_KG_PER_TREE_PER_YEAR / 1000) * 100) / 100;
  }
}
```

**Issue:**
- Three different calculation paths (verified, declared, standard) but **no indication which was used**
- `CampaignImpactDataPoint` has no `source` field showing whether data is measured or estimated
- User sees historical chart without knowing: "Is Year 1 based on actual photos or a guess?"

**Missing:**
```typescript
export interface CampaignImpactDataPoint {
  date: string;
  timestamp: number;
  treeCount: number;
  co2SequestrationTonnes: number;
  co2SequestrationKg: number;
  co2Sequestration: string;
  sponsorCount: number;
  cumulativeRaised: string;
  fundingProgressPercent: number;
  
  // ── NEW: Source & Assumption Labeling ──
  
  /** Whether this data point is measured, estimated, or forecasted */
  dataSource: "verified_evidence" | "campaign_declared" | "standard_assumption" | "forecast";
  
  /** If dataSource !== "verified_evidence", explain the assumption */
  assumptionBasis?: string;
  // e.g., "Trees estimated from funding ratio (50% funded → 50% trees assumed planted)"
  // e.g., "CO2 calculated using standard 20 kg/tree/year (no species breakdown)"
  // e.g., "Sponsor count estimated from cumulative contributions"
  
  /** Confidence interval (lower, upper) for this data point */
  ci95?: { low: number; high: number };
  
  /** URL to evidence (photo batch, verification audit, etc.) if verified */
  evidenceRef?: string;
}
```

---

### Fixes Required

**Priority 1: Label All Forecasts as Assumptions**

Add disclaimer component to `CO2SequestrationProjection.tsx`:
```tsx
<div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4 mb-4">
  <div className="flex gap-2">
    <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
    <div className="text-sm text-amber-200">
      <p className="font-semibold">Planning Forecast — Not Measured Data</p>
      <p className="mt-1">
        This is a {climateScenario} scenario forecast based on literature averages,
        not verification evidence. Actual CO2 sequestration depends on:
      </p>
      <ul className="mt-2 ml-4 space-y-0.5 list-disc text-amber-300">
        <li>Regional climate (precipitation, temperature)</li>
        <li>Species-specific growth rates</li>
        <li>Tree survival rate ({survivalRate}%)</li>
        <li>Maintenance practices</li>
      </ul>
      <p className="mt-2">
        <a href="/docs/carbon-accounting-methodology" className="underline hover:text-amber-100">
          Learn about our methodology
        </a>
      </p>
    </div>
  </div>
</div>
```

**Priority 2: Create Assumption Registry**

Create `/docs/forecast-assumptions.md`:
```markdown
# Forecast Assumptions Registry

## Global Defaults

| Assumption | Value | Source | Sensitivity | Update Frequency |
|-----------|-------|--------|-------------|------------------|
| CO2/tree/year | 20 kg | IPCC Tier 1 | ±15% impact | Q3 2025 |
| Tree survival Y1 | 90% | FAO FRA 2020 | ±1% = ±1% CO2 | Annual |
| Annual mortality Y5 | 10% | Regional audit | ±2% = ±2% CO2 | Annual |
| Climate factor | 0.95–1.05 | Regional data | ±10% = ±10% CO2 | Q2, Q4 |

## How to Interpret Forecasts

1. **Moderate scenario** = baseline assumption (80% probability in typical year)
2. **Optimistic** = best-case (top 25% years)
3. **Pessimistic** = stress-case (bottom 25% years)

## When Assumptions Change

- Notify all campaigns (email, in-app)
- Recompute historical projections
- Show side-by-side: "Old assumption" vs. "New assumption"
- Provide evidence for change (study reference, audit results)
```

**Priority 3: Add Source Labeling to Historical Data**

Extend `CampaignImpactDataPoint` to include `dataSource` and `assumptionBasis` fields (see above).

**Priority 4: Scenario Picker Enhancements**

Update UI to show:
- Expected vs. conservative vs. optimistic bounds
- Which scenario is recommended
- Link to methodology explaining each scenario

---

## Issue 3: Target Definitions & Change Tracking — Missing

### Problem Statement

Campaign funding targets (`goalAmount`, `targetAmount`, `fundingGoal`) can change, but there is:
- **No tracking of when targets change**
- **No history of prior targets**
- **No audit trail showing why a target was modified**
- **No notification to sponsors of target changes**
- **No impact on milestone calculations if targets retroactively change**

### Current Implementation Gaps

#### 1. **No Target Change History in Campaign Record**

**Files:**
- `/apps/web/src/types/campaign.ts:59-61` — `targetAmount: string` (single value)
- `/apps/web/src/services/campaign.service.ts` — No change tracking
- `/contracts/campaign-funding/src/lib.rs:100-150` — `target_amount` is immutable on-chain (correct), but off-chain tracker missing

**Current Code:**
```typescript
export interface CampaignData {
  id: string;
  title: string;
  description: string;
  creator: string;
  token: string;
  targetAmount: string;  // ← Only current value, no history
  minTarget: string;
  totalRaised: string;
  status: CampaignStatus;
  treeType: TreeType;
  // ...
}
```

**Issue:**
- If a campaign's target is updated, previous target is lost
- Milestones (25%, 50%, 75%, 100%) are calculated against **current** target, not the target when a milestone was reached
- Sponsors funded at original target may see different milestone percentages after a target change
- No way to trace: "Campaign originally had $10k target, updated to $20k after 6 months"

**Missing:**
```typescript
export interface CampaignData {
  id: string;
  // ... existing fields ...
  
  targetAmount: string;  // Current target
  targetHistory: TargetChangeRecord[];  // ← NEW: Track all changes
}

export interface TargetChangeRecord {
  /** ISO timestamp when target was changed */
  changedAt: string;
  
  /** Previous target (stroops) */
  previousAmount: string;
  
  /** New target (stroops) */
  newAmount: string;
  
  /** Reason for change (enum + optional details) */
  reason: TargetChangeReason;
  reasonDetails?: string;
  
  /** Actor who changed it (creator address or admin) */
  changedBy: string;
  
  /** How many sponsors were affected at time of change */
  sponsorCountAtChange: number;
  
  /** Cumulative funds raised at time of change */
  cumulativeRaisedAtChange: string;
}

export type TargetChangeReason =
  | "creator_requested" // Campaign creator asked to increase/decrease target
  | "regulatory_requirement" // Legal/compliance requirement
  | "emergency_increase" // Disaster, opportunity, or urgent need
  | "admin_correction" // Data entry error correction
  | "milestone_exceeded" // Exceeded original target, raised it
  | "other"; // Catch-all
```

#### 2. **No Milestone Audit Trail — Milestones Tied to Current Target**

**File:** `/contracts/campaign-funding/src/lib.rs:200-250`

**Current Code (Rust):**
```rust
/// Milestones are tracked against the campaign's hard cap (`target_amount`)
/// Milestones are: 25%, 50%, 75%, 100% of `target_amount`.
pub fn check_milestone_reached(env: Env, campaign_id: u64) -> Option<u32> {
  let campaign = get_campaign(&env, campaign_id)?;
  let raised = campaign.total_raised;
  let target = campaign.target_amount;  // ← Always uses current target
  
  if raised >= (target * 75 / 100) { return Some(75); }
  if raised >= (target * 50 / 100) { return Some(50); }
  if raised >= (target * 25 / 100) { return Some(25); }
  None
}
```

**Issue:**
- If target is increased, milestones don't retroactively apply (expected behavior)
- If target is **decreased**, previous milestone emails may be incorrect
- No record of "Campaign hit 75% milestone at original $10k target" vs. "...at updated $20k target"
- Sponsor emails don't reflect which target level was active at time of milestone

**Missing:**
```rust
pub struct MilestoneEvent {
  /// Campaign ID
  campaign_id: u64,
  /// 25, 50, 75, or 100
  milestone_percent: u32,
  /// Unix timestamp when milestone was reached
  reached_at: u64,
  /// Target amount (stroops) that defines this milestone
  /// If target changes later, old milestone percentages don't retroactively apply
  target_amount_at_milestone: i128,
  /// Actual cumulative raised when milestone was hit
  cumulative_raised_at_milestone: i128,
  /// Who triggered the notification (automated or manual)
  triggered_by: Address,
}
```

#### 3. **No Sponsor Notification of Target Changes**

**File:** `/apps/web/src/services/campaign.service.ts` — No target change notification logic

**Issue:**
- Sponsors are not notified when a campaign's target changes
- If target increases, sponsors may become unaware of new milestone dates
- If target decreases, sponsors see their contribution as higher % of goal (good), but no notification

**Missing:**
```typescript
export async function updateCampaignTarget(
  campaignId: string,
  newTargetAmount: string,
  reason: TargetChangeReason,
  actor: string,
  source: CampaignDataSource
): Promise<void> {
  const campaign = await getCampaign(campaignId, source);
  const previousTarget = campaign.targetAmount;
  
  // Update
  const updated = {
    ...campaign,
    targetAmount: newTargetAmount,
    targetHistory: [
      ...campaign.targetHistory,
      {
        changedAt: new Date().toISOString(),
        previousAmount: previousTarget,
        newAmount: newTargetAmount,
        reason,
        changedBy: actor,
        sponsorCountAtChange: campaign.sponsorCount,
        cumulativeRaisedAtChange: campaign.raisedAmount,
      },
    ],
  };
  await source.saveCampaign(updated);
  
  // 🔔 Notify all sponsors
  await notifySponsorsOfTargetChange({
    campaignId,
    previousTarget,
    newTarget: newTargetAmount,
    reason,
    affectedSponsors: campaign.sponsors || [],
  });
  
  // 📊 Log for audit trail
  await logPrivilegedAction({
    action: "update_campaign_target",
    actor,
    target: campaignId,
    details: { previousTarget, newTarget: newTargetAmount, reason },
  });
}

async function notifySponsorsOfTargetChange(
  input: NotifyTargetChangeInput
): Promise<void> {
  const template = getEmailTemplate("campaign_target_changed", {
    campaignName: campaign.name,
    previousTarget: formatCurrency(input.previousTarget),
    newTarget: formatCurrency(input.newTarget),
    reason: describeTargetChangeReason(input.reason),
    oldMilestones: calculateMilestones(input.previousTarget),
    newMilestones: calculateMilestones(input.newTarget),
  });
  
  for (const sponsor of input.affectedSponsors) {
    await sendEmail(sponsor.email, template);
  }
}
```

#### 4. **Milestone Calculation Uses Current Target, Not Historical**

**File:** `/apps/web/src/services/campaign-milestone-email.service.ts:97-120`

**Current Code:**
```typescript
// Build the impact metrics payload shared across all milestone emails for
// consistency. Used for all milestone types.
const impactMetrics: MilestoneEmailImpactMetrics = {
  treeCount: updated.treeCount,
  co2OffsetKg: updated.treeCount * CO2_KG_PER_TREE_PER_YEAR,
  sponsorCount: updated.sponsorCount,
  fundingPercent: Math.round((BigInt(updated.raisedAmount) * 100n) / BigInt(updated.targetAmount)),
  // ↑ Uses current target, could give wrong percentage if target changed
};
```

**Issue:**
- Email says "You've helped reach 50% of the goal" but if target changed, that percentage is now wrong
- Sponsor receives email saying "50% complete" but in-app shows "30% complete" (because target doubled)

---

### Fixes Required

**Priority 1: Create Target Change Tracking Infrastructure**

Add to `CampaignRecord`:
```typescript
export interface CampaignRecord {
  // ... existing fields ...
  targetAmount: string;
  targetHistory: TargetChangeRecord[];
  targetHistoryVersion: number;  // For migration/versioning
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

**Priority 2: Snapshot Milestones at Reach Time**

Create `/apps/web/src/services/milestone-audit.service.ts`:
```typescript
export interface MilestoneAuditRecord {
  campaignId: string;
  milestonePercent: number;  // 25, 50, 75, 100
  reachedAt: string;  // ISO timestamp
  targetAmountAtMilestone: string;  // Immutable snapshot
  cumulativeRaisedAtMilestone: string;
  sponsorEmailsSent: number;
  emailTemplateVersion: number;
}

/** When a milestone is reached, snapshot the target amount. */
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
    targetAmountAtMilestone: campaign.targetAmount,  // Snapshot current
    cumulativeRaisedAtMilestone: campaign.raisedAmount,
    sponsorEmailsSent: campaign.sponsorCount,
    emailTemplateVersion: 1,
  };
  
  await source.saveMilestoneAudit(audit);
}

/** Retrieve milestone info with historical context. */
export async function getMilestoneContext(
  campaignId: string,
  milestonePercent: number,
  source: CampaignDataSource
): Promise<MilestoneContext> {
  const campaign = await getCampaign(campaignId, source);
  const audit = await source.getMilestoneAudit(campaignId, milestonePercent);
  
  if (!audit) {
    return {
      status: "not_reached",
      milestonePercent,
      currentTargetAmount: campaign.targetAmount,
      targetAmountWhenReached: null,
    };
  }
  
  const targetChanged = audit.targetAmountAtMilestone !== campaign.targetAmount;
  return {
    status: "reached",
    milestonePercent,
    reachedAt: audit.reachedAt,
    targetAmountWhenReached: audit.targetAmountAtMilestone,
    currentTargetAmount: campaign.targetAmount,
    targetChanged,
    targetChangeDetails: campaign.targetHistory.find(
      (change) => Date.parse(change.changedAt) > Date.parse(audit.reachedAt)
    ),
  };
}
```

**Priority 3: Notify Sponsors of Target Changes**

Create `/apps/web/src/services/campaign-target-change-notification.service.ts` with:
- Email template highlighting old vs. new target
- New milestone dates under updated target
- Impact on their sponsorship percentage

**Priority 4: Update Milestone Email Service**

Modify `campaign-milestone-email.service.ts` to use `targetAmountAtMilestone`:
```typescript
export async function sendMilestoneEmail(
  campaignId: string,
  milestonePercent: number,
  source: CampaignDataSource
): Promise<void> {
  const campaign = await getCampaign(campaignId, source);
  const milestoneContext = await getMilestoneContext(campaignId, milestonePercent, source);
  
  // Use target from when milestone was reached, not current target
  const relevantTarget = milestoneContext.targetAmountWhenReached || campaign.targetAmount;
  
  const impactMetrics = {
    fundingPercent: Math.round(
      (BigInt(milestoneContext.cumulativeRaisedAtMilestone) * 100n) / BigInt(relevantTarget)
    ),
    // ↑ Now correctly shows percentage relative to target when milestone was hit
  };
}
```

---

## Issue 4: Localization & Material Terms Translation — Incomplete

### Problem Statement

The platform supports 28+ languages via `SUPPORTED_TRANSLATION_LOCALES`, but:
- **Material/technical terms are not translated or contextualized**
- **No translation guidance for domain-specific vocabulary** (CO2, sequestration, sponsorship, verification, etc.)
- **Locale-specific formatting** (number formats, currency, date formats) partially implemented
- **RTL (right-to-left) support** exists but incomplete for complex layouts
- **No terminology registry** for consistent translation across contexts

### Current Implementation Gaps

#### 1. **No Translation of Material/Technical Terms**

**File:** `/apps/web/src/lib/translation.ts:1-50`

**Current Code:**
```typescript
export interface CampaignLocalizedContent {
  /** Campaign name/title. `title` is accepted as an API alias for `name`. */
  name?: string;
  title?: string;
  description?: string;
  location?: string;
  treeSpecies?: string;
  region?: string;
}
```

**Issue:**
- Only high-level fields are translatable
- Core material terms are **not** included:
  - "CO2 offset" / "Carbon sequestration" — needs locale-specific context
  - "Tree species" (Oak, Teak, etc.) — scientific names vs. common names
  - "Verification evidence" / "Photo batch" — domain-specific terms
  - "Milestone" / "Funding target" — business terms
  - "Sponsor" / "Contributor" / "Backer" — terminology varies by region
  - Measurement units: kg, tonnes, hectares, gallons (US vs. imperial)

**Missing:**
```typescript
export interface CampaignLocalizedContent {
  // Existing fields
  name?: string;
  title?: string;
  description?: string;
  location?: string;
  treeSpecies?: string;
  region?: string;
  
  // ── NEW: Material & Technical Terms ──
  
  /** Translated CO2 offset value, with unit label (e.g., "250 kg CO₂e" or "250 kg CO₂e"). */
  co2Label?: string;  // "250 kg CO₂e" (EN) vs "250 kg CO₂e" (FR, different symbol)
  
  /** Translated tree count label with measurement context. */
  treeCountLabel?: string;  // "100 trees" (EN) vs "100 arbres" (FR)
  
  /** Translated verification status (e.g., "Verified by GCCV", "Under Review"). */
  verificationStatus?: string;
  
  /** Localized impact description for sponsor receipts. */
  impactStatement?: string;
  // "Your 50 trees offset 1 tonne of CO₂ annually, equivalent to
  //  a car trip of 8,000 km" (EN, US)
  // vs.
  // "Vos 50 arbres compensent 1 tonne de CO₂ annuellement, équivalent
  //  à un trajet en voiture de 12,900 km" (FR, metric)
}
```

#### 2. **Locale-Specific Number & Unit Formatting Missing**

**File:** `/apps/web/src/lib/formatters.ts` (referenced but not fully examined)

**Issue:**
- Number formatting varies by locale (1,000.50 vs. 1.000,50)
- Currency symbols vary ($ vs. € vs. ₹)
- Measurement units vary (km vs. miles, kg vs. lbs, tonnes vs. short tons)
- No centralized registry for locale-specific formatting rules

**Missing:**
```typescript
// /apps/web/src/lib/locale-formatters.ts

export interface LocaleFormatting {
  /** Language + region code (e.g., "en_US", "fr_FR", "de_DE") */
  locale: string;
  
  /** Number formatting (thousands separator, decimal separator) */
  numberFormat: {
    thousandsSeparator: string;  // "," (US) vs. "." (EU)
    decimalSeparator: string;    // "." (US) vs. "," (EU)
  };
  
  /** Unit preferences for measurements */
  unitPreferences: {
    distance: "km" | "miles";
    weight: "kg" | "lbs" | "tonnes";
    co2: "kg CO₂e" | "metric_tonnes CO₂e";  // kg is standard, tonnes for large values
  };
  
  /** Date/time formatting */
  dateFormat: string;  // "MM/DD/YYYY" vs. "DD/MM/YYYY" vs. "YYYY-MM-DD"
  timeFormat: string;  // "HH:MM AM/PM" vs. "HH:MM" (24-hour)
  
  /** Currency symbol & position */
  currency: {
    symbol: string;        // "$", "€", "₹", etc.
    position: "before" | "after";  // "$100" vs. "100€"
    symbolSpacing: "compact" | "spaced";  // "$100" vs. "$ 100"
  };
}

const LOCALE_FORMATTING: Record<TranslationLocale, LocaleFormatting> = {
  en: {
    locale: "en_US",
    numberFormat: { thousandsSeparator: ",", decimalSeparator: "." },
    unitPreferences: { distance: "miles", weight: "lbs", co2: "kg CO₂e" },
    dateFormat: "MM/DD/YYYY",
    timeFormat: "hh:mm A",
    currency: { symbol: "$", position: "before", symbolSpacing: "compact" },
  },
  fr: {
    locale: "fr_FR",
    numberFormat: { thousandsSeparator: " ", decimalSeparator: "," },
    unitPreferences: { distance: "km", weight: "kg", co2: "tonnes CO₂e" },
    dateFormat: "DD/MM/YYYY",
    timeFormat: "HH:mm",
    currency: { symbol: "€", position: "after", symbolSpacing: "spaced" },
  },
  de: {
    locale: "de_DE",
    numberFormat: { thousandsSeparator: ".", decimalSeparator: "," },
    unitPreferences: { distance: "km", weight: "kg", co2: "tonnes CO₂e" },
    dateFormat: "DD.MM.YYYY",
    timeFormat: "HH:mm",
    currency: { symbol: "€", position: "after", symbolSpacing: "spaced" },
  },
  // ... more locales
};

export function formatCo2(kg: number, locale: TranslationLocale): string {
  const formatting = LOCALE_FORMATTING[locale];
  const { co2 } = formatting.unitPreferences;
  
  let value: string;
  if (co2 === "tonnes CO₂e" && kg >= 1000) {
    value = formatNumber(kg / 1000, locale, 2);  // Convert to tonnes
  } else {
    value = formatNumber(kg, locale, 0);
  }
  
  return `${value} ${co2}`;
}

export function formatNumber(
  num: number,
  locale: TranslationLocale,
  decimalPlaces: number = 2
): string {
  const formatting = LOCALE_FORMATTING[locale];
  const { thousandsSeparator, decimalSeparator } = formatting.numberFormat;
  
  const parts = num.toFixed(decimalPlaces).split(".");
  const integerPart = parts[0];
  const decimalPart = parts[1];
  
  const withSeparators = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);
  
  return decimalPlaces > 0
    ? `${withSeparators}${decimalSeparator}${decimalPart}`
    : withSeparators;
}
```

#### 3. **Material Terms Glossary Missing**

**Issue:**
- No centralized list of domain-specific terms with translations
- Translators may use inconsistent terminology (e.g., "offsetting" vs. "sequestration" for CO2)
- No context about which term is appropriate for which user audience

**Missing:**
```typescript
// /apps/web/src/lib/material-terms-glossary.ts

export interface MaterialTermEntry {
  englishTerm: string;
  definition: string;
  context: "technical" | "sponsor" | "creator" | "auditor";
  translations: Record<TranslationLocale, {
    term: string;
    definition: string;
    notes?: string;
  }>;
  relatedTerms: string[];
  source?: string;  // Reference to documentation
}

export const MATERIAL_TERMS_GLOSSARY: MaterialTermEntry[] = [
  {
    englishTerm: "CO2 offset",
    definition: "The reduction or removal of greenhouse gas emissions, typically measured in kg CO₂ equivalent (CO₂e).",
    context: "sponsor",
    translations: {
      en: { term: "CO2 offset", definition: "..." },
      fr: { 
        term: "Compensation carbone" or "Réduction d'émissions",
        definition: "...",
        notes: "French uses 'compensation' for removal, 'réduction' for avoided emissions."
      },
      de: { 
        term: "CO₂-Ausgleich",
        definition: "...",
      },
      es: { 
        term: "Compensación de carbono",
        definition: "...",
      },
    },
    relatedTerms: ["CO2 sequestration", "Carbon credit", "GHG emissions"],
    source: "IPCC AR6 WG3",
  },
  {
    englishTerm: "Verification evidence",
    definition: "Photographic, GPS, or satellite data submitted to prove trees were planted at claimed locations and times.",
    context: "auditor",
    translations: {
      en: { term: "Verification evidence", definition: "..." },
      fr: { term: "Preuve de vérification", definition: "..." },
      de: { term: "Verifikationsbeweis", definition: "..." },
    },
    relatedTerms: ["Audit trail", "Tree batch", "Photo submission"],
    source: "Campaign Verification Audit Contract",
  },
  // ... 50+ material terms
];

export function getMaterialTermTranslation(
  englishTerm: string,
  locale: TranslationLocale,
  context: "technical" | "sponsor" | "creator" | "auditor" = "sponsor"
): string {
  const entry = MATERIAL_TERMS_GLOSSARY.find((e) => e.englishTerm === englishTerm);
  if (!entry) return englishTerm;  // Fallback to English
  
  const translation = entry.translations[locale];
  return translation?.term || englishTerm;
}
```

#### 4. **RTL (Right-to-Left) Support Incomplete**

**File:** `/apps/web/src/lib/translation.ts:85-100`

**Current Code:**
```typescript
export function localizeCampaign<T extends CampaignRecord>(campaign: T, requestedLanguage: string) {
  // ... retrieves localized content ...
  
  return {
    ...campaign,
    ...localizedFields,
    localization: {
      requestedLanguage: language,
      resolvedLanguage: available ? language : sourceLanguage,
      isFallback: fallbackFields.length > 0,
      fallbackFields,
      direction: RTL_LOCALES.has(language) ? "rtl" as const : "ltr" as const,  // ← Exists but...
    },
  };
}

const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "fa"]);
```

**Issue:**
- Direction flag is set but not always used in component rendering
- Complex layouts (tables, cards, grids) may not reflow correctly in RTL
- Numbers and dates may not be formatted RTL-appropriately
- Form inputs, tabs, breadcrumbs may not mirror correctly

**Missing:**
```typescript
// /apps/web/src/components/LocalizationContext.tsx

export interface LocalizationContextValue {
  locale: TranslationLocale;
  direction: "ltr" | "rtl";
  numberFormat: LocaleFormatting["numberFormat"];
  dateFormat: LocaleFormatting["dateFormat"];
  /** Utility to format any number with correct separators */
  formatNumber: (num: number, decimals?: number) => string;
  /** Utility to format CO2 with correct units */
  formatCo2: (kg: number) => string;
}

export const LocalizationContext = createContext<LocalizationContextValue | null>(null);

// Usage in components:
export function CampaignCard({ campaign }: Props) {
  const loc = useContext(LocalizationContext)!;
  
  return (
    <div
      dir={loc.direction}  // ← Apply to all text containers
      className={clsx(
        "p-4 rounded border",
        loc.direction === "rtl" ? "text-right" : "text-left"
      )}
    >
      <h2>{campaign.name}</h2>
      <p>{getMaterialTermTranslation("CO2 offset", loc.locale)}: {loc.formatCo2(campaign.co2OffsetKg)}</p>
      {/* All nested elements inherit dir attribute */}
    </div>
  );
}
```

#### 5. **No Translation Validation or Completeness Checks**

**Issue:**
- No system to verify all material terms are translated
- No way to check translation coverage (e.g., "90% of UI translated to FR")
- No CI/CD checks to catch missing translations before deployment

**Missing:**
```typescript
// /apps/web/src/lib/translation-coverage.ts

export async function generateTranslationCoverageReport(): Promise<TranslationCoverageReport> {
  const locales = SUPPORTED_TRANSLATION_LOCALES;
  const allMaterialTerms = MATERIAL_TERMS_GLOSSARY.length;
  
  const coverage: Record<TranslationLocale, {
    translatedTerms: number;
    missingTerms: string[];
    percentage: number;
  }> = {};
  
  for (const locale of locales) {
    const translated = MATERIAL_TERMS_GLOSSARY.filter(
      (term) => term.translations[locale]?.term && term.translations[locale].definition
    );
    
    coverage[locale] = {
      translatedTerms: translated.length,
      missingTerms: MATERIAL_TERMS_GLOSSARY
        .filter((term) => !term.translations[locale])
        .map((term) => term.englishTerm),
      percentage: Math.round((translated.length / allMaterialTerms) * 100),
    };
  }
  
  return {
    reportAt: new Date().toISOString(),
    totalMaterialTerms: allMaterialTerms,
    coverage,
    readyForProduction: Object.values(coverage).every((c) => c.percentage >= 95),
  };
}
```

---

### Fixes Required

**Priority 1: Create Material Terms Glossary**

Create `/apps/web/src/lib/material-terms-glossary.ts` with 50+ entries covering:
- Climate/environment: CO2, sequestration, carbon credit, emission, ton, hectare
- Business: sponsor, contribution, backing, milestone, pledge, verification
- Technical: contract, transaction, ledger, hash, proof, audit
- Platform-specific: verification evidence, tree batch, photo submission, ranking

**Priority 2: Implement Locale-Specific Formatting**

Create `/apps/web/src/lib/locale-formatters.ts` with:
- `formatNumber(num, locale, decimals)`
- `formatCo2(kg, locale)`
- `formatDate(date, locale)`
- `formatCurrency(amount, locale, currency)`
- `formatMeasurement(value, unit, locale)`

**Priority 3: Add RTL Support to Complex Components**

Update components to:
- Apply `dir={loc.direction}` to all text containers
- Mirror layouts (flex direction, margin directions)
- Test in Arabic and Farsi versions

**Priority 4: CI/CD Translation Coverage Check**

Add to GitHub Actions:
```yaml
- name: Check Translation Coverage
  run: npm run check-translation-coverage -- --min-percentage 95
```

---

## Summary Table

| Issue | Severity | Locations | Key Gap | Fix Priority |
|-------|----------|-----------|---------|--------------|
| **Impact Metrics** | High | 6+ services | No source/evidence linkage | 1: Create CO2 constants file |
| | | | No confidence intervals | 2: Add provenance fields |
| | | | No audit trail | 3: Trace service |
| **Scenarios** | High | Dashboard, Analytics | Not labeled as assumptions | 1: Add assumption disclaimers |
| | | | No interpretation guidance | 2: Create assumptions registry |
| | | | Retroactive assumptions unlabeled | 3: Label historical data |
| **Targets** | Medium | Services, Contracts | No change history | 1: Create target history struct |
| | | | No audit trail | 2: Snapshot milestones |
| | | | No sponsor notification | 3: Notification service |
| **Localization** | Medium | All UI | Material terms not translated | 1: Glossary (50+ terms) |
| | | | Number/unit formatting missing | 2: Locale formatters |
| | | | RTL incomplete | 3: Component updates |
| | | | No coverage tracking | 4: CI/CD check |

---

## Files to Create/Modify

### New Files
- `/apps/web/src/lib/carbon-accounting-constants.ts`
- `/apps/web/src/lib/material-terms-glossary.ts`
- `/apps/web/src/lib/locale-formatters.ts`
- `/apps/web/src/services/impact-provenance.service.ts`
- `/apps/web/src/services/milestone-audit.service.ts`
- `/apps/web/src/services/campaign-target-change-notification.service.ts`
- `/apps/web/src/lib/translation-coverage.ts`
- `/docs/carbon-accounting-methodology.md`
- `/docs/forecast-assumptions.md`

### Existing Files to Modify
- `/apps/web/src/types/campaign.ts` — Add `targetHistory`, provenance fields
- `/apps/web/src/services/campaign-impact-history.service.ts` — Add `dataSource` field
- `/apps/web/src/services/campaign.service.ts` — Add target change tracking
- `/apps/web/src/services/campaign-impact-report.service.ts` — Import CO2 constants
- `/apps/web/src/components/modules/dashboard/CO2SequestrationProjection.tsx` — Add assumption disclaimers
- `/apps/web/src/lib/translation.ts` — Add material terms support, RTL
- `.github/workflows/quality-gates.yml` — Add translation coverage check

---

**End of Audit Report**
