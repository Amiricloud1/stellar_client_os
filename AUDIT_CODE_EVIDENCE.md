# Code Evidence: Specific Locations of All 4 Issues

## Issue 1: Impact Metrics — Hardcoded Constants Without Attribution

### Problem #1a: Duplicate Constants Across 6 Services

**Location 1:** `apps/web/src/services/campaign-impact-report.service.ts:32`
```typescript
/** Average CO2 sequestered per tree per year (kg). */
const CO2_KG_PER_TREE_PER_YEAR = 20;  // ← NO SOURCE, NO LINK
```

**Location 2:** `apps/web/src/services/campaign-milestone-email.service.ts:11`
```typescript
/** Conservative CO₂ sequestration estimate used throughout the platform. */
const CO2_KG_PER_TREE_PER_YEAR = 20;  // ← DUPLICATE, DIFFERENT COMMENT
```

**Location 3:** `apps/web/src/services/campaign-progress-cache.service.ts:117`
```typescript
const co2PerTreeKg = 20;  // ← NO COMMENT
const co2ImpactKg = treeCount * co2PerTreeKg;
```

**Location 4:** `apps/web/src/services/campaign.service.ts:880`
```typescript
// CO2 estimate: use a conservative average of 20 kg CO2/tree/year.
const CO2_KG_PER_TREE_PER_YEAR = 20;  // ← COMMENT SAYS "CONSERVATIVE" (IS IT?)
const impactMetrics: MilestoneEmailImpactMetrics = {
  treeCount: updated.treeCount,
  co2OffsetKg: updated.treeCount * CO2_KG_PER_TREE_PER_YEAR,
  sponsorCount: updated.sponsorCount,
```

**Location 5:** `apps/web/src/services/campaign-hall-of-fame.service.ts` (related usage)
```typescript
const CO2_KG_PER_TREE_PER_YEAR = 20;
const co2OffsetTonnes = (treesSponsored * CO2_KG_PER_TREE_PER_YEAR / 1000).toFixed(2);
```

**Location 6:** `apps/web/src/services/campaign-impact-history.service.ts:73`
```typescript
export function calculateImpactAtTimestamp(
  campaign: CampaignRecord,
  targetTimestamp: number,
  targetDateStr: string
): CampaignImpactDataPoint {
  // ... later in function ...
  const CO2_KG_PER_TREE_PER_YEAR = 20;  // ← DUPLICATE AGAIN
  co2Tonnes = Math.round((treeCount * CO2_KG_PER_TREE_PER_YEAR / 1000) * 100) / 100;
```

---

### Problem #1b: Species CO2 Data Without Source

**Location:** `apps/web/src/lib/co2-impact.ts:10-18`
```typescript
export const TREE_SPECIES: TreeSpecies[] = [
  { id: "oak", label: "Oak", co2PerTreePerYearKg: 21, annualGrowthRate: 0.12, annualMortalityRate: 0.02, climateFactor: 0.95 },
  { id: "maple", label: "Maple", co2PerTreePerYearKg: 12, annualGrowthRate: 0.13, annualMortalityRate: 0.025, climateFactor: 1 },
  { id: "pine", label: "Pine", co2PerTreePerYearKg: 18, annualGrowthRate: 0.15, annualMortalityRate: 0.03, climateFactor: 0.9 },
  { id: "teak", label: "Teak", co2PerTreePerYearKg: 24, annualGrowthRate: 0.1, annualMortalityRate: 0.025, climateFactor: 1.05 },
  // ...
];
```

**Problem:**
- `co2PerTreePerYearKg: 21` — where does 21 come from?
- `annualGrowthRate: 0.12` — what is the source?
- `climateFactor: 0.95` — what does 0.95 mean? Why this value?
- **No comments, no references, no confidence intervals**

---

### Problem #1c: Impact Metrics Missing Confidence Bounds

**Location:** `apps/web/src/services/impact.service.ts:23-51`
```typescript
export interface SponsorImpact {
  /** The sponsor's Stellar address. */
  address: string;
  /** Total volume funded by this sponsor (USDC-equivalent, as string). */
  myVolumeUsd: string;
  /** Estimated CO2 offset from this sponsor's funding (kg CO2e). */
  myCo2OffsetKg: number;  // ← POINT ESTIMATE, NO RANGE
  /** Average volume funded per sponsor (USDC-equivalent, as string). */
  globalAverageVolumeUsd: string;
  /** Estimated CO2 offset of the average sponsor (kg CO2e). */
  globalAverageCo2OffsetKg: number;  // ← NO CONFIDENCE INTERVAL
  /** Number of unique sponsors (senders) in the dataset. */
  globalSponsorCount: number;
  /**
   * Percentage of sponsors this sponsor beats (0–100).
   * `null` when there is no sponsor data to compare against.
   */
  percentile: number | null;
  /** Ranking band (e.g. "top_10"). `null` when there is no data. */
  rankingBand: RankingBand | null;
  /** CO2 conversion factor applied (kg CO2e per 1 USD funded). */
  co2PerUsdKg: number;  // ← WHAT IS THE BASIS? USD→TREES CONVERSION?
}
```

**Missing Fields:**
- `calculatedAt: string` — when was this snapshot taken?
- `source: "ledger" | "estimated"` — is this measured or estimated?
- `ci95Low: number; ci95High: number` — confidence range?
- `methodologyRef: string` — link to methodology?

---

## Issue 2: Scenarios & Forecasts — Not Labeled as Assumptions

### Problem #2a: Climate Scenarios Presented Without Context

**Location:** `apps/web/src/components/modules/dashboard/CO2SequestrationProjection.tsx:47-59`
```typescript
const CLIMATE_OPTIONS: {
  label: string;
  value: Co2ProjectionInput["climateScenario"];
}[] = [
  { label: climateScenarioLabel("optimistic"), value: "optimistic" },    // ← NO DESCRIPTION
  { label: climateScenarioLabel("moderate"), value: "moderate" },        // ← NO INDICATION THIS IS BASELINE
  { label: climateScenarioLabel("pessimistic"), value: "pessimistic" },  // ← NO STRESS-TEST LABEL
];
```

**Problem:**
- User sees three equal options
- No indication that "moderate" is recommended
- No explanation: "Optimistic assumes +25% rainfall, 90% survival"
- No disclaimer: "These are planning forecasts, not measured data"

---

### Problem #2b: Growth Curve Assumptions Buried in Code

**Location:** `apps/web/src/services/campaignAnalytics.ts:100-130`
```typescript
private getGrowthParams(projectType: string) {
  const params = {
    reforestation: { 
      co2PerTreeYear1: 0.02,  // ← WHERE DOES 0.02 COME FROM?
      co2PerTreeYear5: 0.15,  // ← WHY DOES IT INCREASE? NO EXPLANATION
      co2PerTreeYear10: 0.5,  // ← WHAT MODEL IS THIS?
      survivalYear1: 0.9,     // ← ASSUMES 90% SURVIVAL, BUT NOT DOCUMENTED
      survivalYear5: 0.8      // ← DROPS TO 80%? WHY?
    },
    blue_carbon: { 
      co2PerTreeYear1: 0.05, 
      co2PerTreeYear5: 0.3, 
      co2PerTreeYear10: 1.0, 
      survivalYear1: 0.85, 
      survivalYear5: 0.75 
    },
    // ... more assumptions without explanation
  };
  // NO DOCUMENTATION LINKING THESE TO IPCC, FAO, OR FIELD DATA
}
```

**Missing:**
- Why does reforestation CO2 go 0.02 → 0.15 → 0.5?
- Is this linear interpolation? Logistic? Chapman-Richards?
- What happens after year 10?
- Why 90% → 80% survival? Is this species-specific?
- **All assumptions are implicit, not documented**

---

### Problem #2c: Confidence Intervals Not Explained to Users

**Location:** `apps/web/src/lib/co2-impact.ts:55-120`
```typescript
export function calculateCo2Forecast(
  speciesId: string,
  quantity: number,
): Co2ForecastYear[] {
  // ... calculate point estimates ...
  
  // Compute sensitivities (derivatives)
  const growthSensitivity = /* complex math */;
  const mortalitySensitivity = /* complex math */;
  const climateSensitivity = /* complex math */;
  
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
    lower95Kg: Math.max(0, expectedCumulativeKg - margin),  // ← WHAT DOES THIS MEAN?
    upper95Kg: expectedCumulativeKg + margin,                // ← IS IT REAL UNCERTAINTY?
  });
}
```

**Problem:**
- Code correctly computes 95% CI using sensitivity analysis
- **But nowhere explains what the band means:**
  - Is it parametric uncertainty (growth rate ±1.5%)? YES.
  - Is it natural variation year-to-year? NO.
  - Is it measurement error? NO.
  - Can I expect actual CO2 to fall in this range 95% of the time? NO.
- **User sees wide bands and gets no interpretation guide**

---

### Problem #2d: Historical Data Uses Assumptions Without Labeling

**Location:** `apps/web/src/services/campaign-impact-history.service.ts:120-160`
```typescript
export async function getCampaignImpactHistory(
  campaignId: string,
  options: QueryImpactHistoryOptions = {},
  dataSource = getCampaignDataSource()
): Promise<CampaignImpactHistoryResult | null> {
  // ... retrieves campaign ...
  
  // Trees planted / verified by target date
  let treeCount = 0;
  if (campaign.verificationEvidence && campaign.verificationEvidence.length > 0) {
    const evidenceTrees = campaign.verificationEvidence
      .filter((ev) => (ev.timestamp || campaign.createdAt) <= targetMs)
      .reduce((sum, ev) => sum + (ev.treesCount || 0), 0);
    
    if (evidenceTrees > 0) {
      treeCount = Math.min(evidenceTrees, campaign.treeCount);  // ← VERIFIED
    } else {
      // ⚠️ FALLS BACK TO ASSUMPTION, NOT LABELED
      treeCount = Math.round(campaign.treeCount * fundingRatio);  // ← ESTIMATED
    }
  } else {
    // ⚠️ ASSUMPTION: Apply funding ratio to total trees
    treeCount = Math.round(campaign.treeCount * fundingRatio);  // ← ASSUMED
  }
  
  // Calculate CO2 sequestration
  let co2Tonnes = 0;
  if (campaign.co2Sequestration && !isNaN(parseFloat(campaign.co2Sequestration))) {
    const totalDeclaredTonnes = parseFloat(campaign.co2Sequestration);
    // ⚠️ ASSUMPTION: Apply funding ratio (not verified by species)
    co2Tonnes = Math.round(totalDeclaredTonnes * fundingRatio * 100) / 100;
  } else {
    // ⚠️ STANDARD ASSUMPTION: 20 kg/tree/year
    co2Tonnes = Math.round((treeCount * CO2_KG_PER_TREE_PER_YEAR / 1000) * 100) / 100;
  }
  
  return {
    // ... returns data point ...
    timeline: filteredTimeline,  // ← CHART SHOWS THESE, BUT USER DOESN'T KNOW:
    // "Is Year 1 verified or estimated?"
    // "Did the funding ratio change between Year 1 and Year 2?"
  };
}
```

**Problem:**
- Function has 3 code paths (verified → assumed → calculated) **but no tracking**
- `CampaignImpactDataPoint` has no `source` field
- User sees smooth historical chart **without knowing** which years are:
  - Verified (actual photos, GPS)
  - Declared (campaign creator estimate)
  - Assumed (calculated from funding ratio)
- **Result:** Historical chart appears authoritative when it's mostly assumptions

---

## Issue 3: Target Changes — No Tracking

### Problem #3a: Target Is Single Immutable Value

**Location:** `apps/web/src/types/campaign.ts:59-61`
```typescript
export interface CampaignData {
  id: string;
  title: string;
  description: string;
  creator: string;
  token: string;
  targetAmount: string;  // ← ONLY CURRENT VALUE
  minTarget: string;
  totalRaised: string;
  status: CampaignStatus;
  // ... NO TARGET HISTORY, NO CHANGE LOG
}
```

**Problem:**
- If campaign target changes from $10,000 to $20,000, old value is **lost forever**
- No way to know: "When did this change? Why? Who changed it?"
- No audit trail for compliance

---

### Problem #3b: Milestones Calculate Against Current Target

**Location:** `contracts/campaign-funding/src/lib.rs:200-250` (Rust)
```rust
/// Milestones are tracked against the campaign's hard cap (`target_amount`)
pub fn check_milestone_reached(env: Env, campaign_id: u64) -> Option<u32> {
  let campaign = get_campaign(&env, campaign_id)?;
  let raised = campaign.total_raised;
  let target = campaign.target_amount;  // ← ALWAYS USES CURRENT
  
  if raised >= (target * 75 / 100) { return Some(75); }
  if raised >= (target * 50 / 100) { return Some(50); }
  if raised >= (target * 25 / 100) { return Some(25); }
  None
}
```

**Problem:**
- Campaign reaches 50% of original $10k target = **$5,000**
- Milestone email sent
- Campaign owner updates target to $20,000
- Now same campaign shows as "25% complete" instead of "50%"
- **Email contradicts in-app display**

---

### Problem #3c: Milestone Email Uses Current Target

**Location:** `apps/web/src/services/campaign-milestone-email.service.ts:97-120`
```typescript
// Build the impact metrics payload shared across all milestone emails for
// consistency. Used for all milestone types.
const impactMetrics: MilestoneEmailImpactMetrics = {
  treeCount: updated.treeCount,
  co2OffsetKg: updated.treeCount * CO2_KG_PER_TREE_PER_YEAR,
  sponsorCount: updated.sponsorCount,
  fundingPercent: Math.round(
    (BigInt(updated.raisedAmount) * 100n) / BigInt(updated.targetAmount)  // ← USES CURRENT TARGET
  ),
};
```

**Problem:**
- Email says "Congratulations! You're 50% funded" ✉️
- But if target changed after milestone, percentage is now **wrong**
- No indication of which target level was active when email was sent

---

## Issue 4: Localization & Material Terms — Incomplete

### Problem #4a: Only 6 Fields Translatable

**Location:** `apps/web/src/lib/translation.ts:30-37`
```typescript
export interface CampaignLocalizedContent {
  /** Campaign name/title. `title` is accepted as an API alias for `name`. */
  name?: string;
  title?: string;
  description?: string;
  location?: string;
  treeSpecies?: string;
  region?: string;
  // ← NO MATERIAL TERMS (CO2, sequestration, sponsor, verification, etc.)
}
```

**Problem:**
- Only 6 fields translatable
- **Missing:**
  - "CO2 offset" (needs locale context: compensation vs. reduction)
  - "Verification evidence" (audit-specific term)
  - "Sponsor" vs. "Contributor" vs. "Backer" (varies by region)
  - "Tree species" names (Oak → chêne, Eiche, quercus)
  - Measurement units (kg vs. lbs, km vs. miles, tonnes vs. short tons)

---

### Problem #4b: No Locale-Specific Formatting Registry

**Location:** Searched throughout `/apps/web/src/lib/formatters.ts` (referenced but not centralized)

**Problem:**
- Hardcoded units everywhere:
  ```typescript
  return `${value} kg CO₂e`;  // ← Always kg, never tonnes
  return `${value} km`;       // ← Always km, never miles
  return `$${value}`;         // ← Always $, never €, £, ₹
  return `${value} trees`;    // ← English only
  ```
- No central locale configuration
- **Result:** Users in France see "250 kg CO₂e" (correct) but "50 miles" (wrong — should be km)

---

### Problem #4c: RTL Support Incomplete

**Location:** `apps/web/src/lib/translation.ts:85-100`
```typescript
const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "fa"]);

export function localizeCampaign<T extends CampaignRecord>(campaign: T, requestedLanguage: string) {
  // ... retrieves localized content ...
  
  return {
    ...campaign,
    localization: {
      direction: RTL_LOCALES.has(language) ? "rtl" as const : "ltr" as const,  // ← FLAG SET
      // ← BUT NOT USED IN MOST COMPONENTS
    },
  };
}
```

**Problem:**
- Direction flag exists but isn't applied everywhere
- Tables, cards, forms may not reflow correctly in RTL
- Numbers in Arabic: "٢٥٠" vs. "250" (formatting differs)
- Form inputs don't automatically mirror

---

### Problem #4d: No Material Terms Translation Guidance

**Example:** Campaign shows CO2 impact to users in 28 languages

- **English (US):** "Your 100 trees offset 2 tonnes of CO2 per year"
- **French:** ??? Should it be:
  - "Vos 100 arbres compensent 2 tonnes de CO₂ par an" (compensation = removal)
  - "Vos 100 arbres réduisent 2 tonnes de CO₂ par an" (reduction = avoided)
  - "Vos 100 arbres séquestrent 2 tonnes de CO₂ par an" (sequestration = technical)
- **German:** ??? "ausgleich" vs. "reduktion" vs. "speicherung"
- **Spanish:** ??? "compensación de carbono" vs. "reducción de emisiones"

**Missing:** Material terms glossary with context per language

---

## Summary: File Inventory

| Issue | Files | Lines | Gap |
|-------|-------|-------|-----|
| Impact Metrics | 6 services | 400+ | 20 kg constant in 6 places, no source |
| Scenarios | 3 files | 150+ | Assumptions implicit, not labeled |
| Targets | 4 files | 80+ | No change history, no audit trail |
| Localization | 2 files | 200+ | 6 fields translatable, 50+ terms missing |
| **Total** | **15+ files** | **830+** | **All 4 issues pervasive** |

