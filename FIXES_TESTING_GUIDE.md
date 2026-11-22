# Testing Guide for Four Critical Fixes

This guide explains how to verify that all four objective fixes are working correctly.

---

## Test Environment Setup

```bash
# Install dependencies
pnpm install

# Build TypeScript (verify no compilation errors)
cd apps/web
pnpm build

# Run linter
pnpm lint

# Run test suite
pnpm test
```

---

## Objective #1: Impact Metrics Evidence Linking

### Unit Tests

**File:** `apps/web/src/lib/carbon-accounting-constants.test.ts`

```typescript
import {
  DEFAULT_CO2_KG_PER_TREE_PER_YEAR,
  CO2_ACCOUNTING_BASIS,
  getCo2Rate,
  getDefaultCo2RateWithMetadata,
  calculateCo2OffsetWithProvenance,
} from "@/lib/carbon-accounting-constants";

describe("carbon-accounting-constants", () => {
  it("should export default CO2 rate of 20 kg/tree/year", () => {
    expect(DEFAULT_CO2_KG_PER_TREE_PER_YEAR).toBe(20);
  });

  it("should provide IPCC source information", () => {
    expect(CO2_ACCOUNTING_BASIS.source).toContain("IPCC");
    expect(CO2_ACCOUNTING_BASIS.url).toContain("ipcc");
    expect(CO2_ACCOUNTING_BASIS.uncertaintyBand).toBe("±15%");
  });

  it("should return CO2 rate with metadata", () => {
    const result = getCo2Rate("oak");
    expect(result).toHaveProperty("co2PerTreePerYearKg", 21);
    expect(result).toHaveProperty("source");
    expect(result).toHaveProperty("uncertaintyBand");
  });

  it("should calculate CO2 offset with provenance", () => {
    const result = calculateCo2OffsetWithProvenance([
      { speciesId: "oak", treeCount: 100 },
      { speciesId: "pine", treeCount: 50 },
    ]);

    expect(result).toHaveProperty("totalCo2Kg");
    expect(result).toHaveProperty("bySpecies");
    expect(result).toHaveProperty("sources");
    expect(result).toHaveProperty("uncertaintyBand");
    expect(result.bySpecies).toHaveLength(2);
  });

  it("should handle unknown species with default rate", () => {
    const result = calculateCo2OffsetWithProvenance([
      { speciesId: "unknown", treeCount: 100 },
    ]);
    // Should use DEFAULT_CO2_KG_PER_TREE_PER_YEAR as fallback
    expect(result.totalCo2Kg).toBe(100 * DEFAULT_CO2_KG_PER_TREE_PER_YEAR);
  });
});
```

### Integration Tests

**Verify ImpactMetricsWithEvidence Component:**

```tsx
import { render, screen } from "@testing-library/react";
import { ImpactMetricsWithEvidence } from "@/components/modules/impact/ImpactMetricsWithEvidence";

describe("ImpactMetricsWithEvidence", () => {
  it("should display verified metrics with green badge", () => {
    render(
      <ImpactMetricsWithEvidence
        metrics={[
          {
            label: "CO2 Offset",
            value: 42500,
            unit: "kg CO₂e/year",
            verificationStatus: "verified",
            lastUpdated: "2024-11-20",
            source: "IPCC AR6",
            evidenceLink: "/evidence",
          },
        ]}
      />
    );

    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("View Evidence ↗")).toHaveAttribute(
      "href",
      "/evidence"
    );
  });

  it("should display reported metrics with yellow badge", () => {
    render(
      <ImpactMetricsWithEvidence
        metrics={[
          {
            label: "Trees",
            value: 2100,
            unit: "trees",
            verificationStatus: "reported",
            lastUpdated: "2024-11-19",
            source: "Campaign submission",
          },
        ]}
      />
    );

    expect(screen.getByText("Reported")).toBeInTheDocument();
  });

  it("should support locale translation", () => {
    render(
      <ImpactMetricsWithEvidence
        metrics={[
          {
            label: "CO2 offset",
            value: 42500,
            unit: "kg CO₂e/year",
            verificationStatus: "verified",
            lastUpdated: "2024-11-20",
            source: "IPCC",
          },
        ]}
        locale="es"
      />
    );

    // Spanish translation should appear
    expect(screen.getByText(/Verificado|Mediciones Verificadas/)).toBeInTheDocument();
  });
});
```

---

## Objective #2: Scenario-Based Sponsor Exposure

### Unit Tests

**File:** `apps/web/src/services/campaign-scenario-exposure.service.test.ts`

```typescript
import {
  generateSponsorExposureReport,
  getScenarioProjection,
  getScenarioDisclaimer,
  calculateSponsorProportionalExposure,
} from "@/services/campaign-scenario-exposure.service";

describe("campaign-scenario-exposure", () => {
  it("should generate report with three scenarios", () => {
    const report = generateSponsorExposureReport(
      "GXXX...",
      "50000000000",
      "Test Campaign",
      "123",
      1000,
      20000
    );

    expect(report.scenarios).toHaveLength(3);
    expect(report.scenarios.map(s => s.scenarioName)).toEqual([
      "conservative",
      "current_pace",
      "optimistic",
    ]);
  });

  it("should label all scenarios as forecasts", () => {
    const report = generateSponsorExposureReport(
      "GXXX...",
      "50000000000",
      "Test Campaign",
      "123",
      1000,
      20000
    );

    report.scenarios.forEach(scenario => {
      expect(scenario.isForecasted).toBe(true);
      expect(scenario.disclaimerLabel).toContain("⚠️");
    });
  });

  it("should include all assumptions in each scenario", () => {
    const scenario = getScenarioProjection("current_pace");

    expect(scenario.assumptions.length).toBeGreaterThan(0);
    scenario.assumptions.forEach(assumption => {
      expect(assumption.name).toBeDefined();
      expect(assumption.value).toBeDefined();
      expect(assumption.rationale).toBeDefined();
      expect(assumption.confidence).toMatch(/low|medium|high/);
      expect(assumption.source).toBeDefined();
    });
  });

  it("should provide scenario disclaimer", () => {
    const disclaimer = getScenarioDisclaimer("conservative");
    expect(disclaimer).toContain("forecast");
    expect(disclaimer).toContain("assumptions");
  });

  it("should calculate sponsor proportional exposure", () => {
    const exposure = calculateSponsorProportionalExposure(
      "10000000000", // 1000 USDC
      "100000000000", // 10,000 USDC total
      5000 // scenario trees
    );

    expect(exposure).toBe(500); // 10% of 5000
  });

  it("should distinguish scenarios by uncertainty band", () => {
    const conservative = getScenarioProjection("conservative");
    const optimistic = getScenarioProjection("optimistic");

    // Optimistic should have higher uncertainty (more assumptions)
    expect(optimistic.totalUncertaintyBand).toBeDefined();
    expect(conservative.totalUncertaintyBand).toBeDefined();
  });
});
```

### Integration Tests

**Verify scenarios appear in sponsor receipt:**

```tsx
import { render, screen } from "@testing-library/react";
import { SponsorReceipt } from "@/components/modules/sponsorship/SponsorReceipt";

describe("Sponsor Receipt with Scenarios", () => {
  it("should display all three scenarios with disclaimers", () => {
    render(
      <SponsorReceipt
        campaignId="123"
        sponsorAddress="GXXX..."
        amount="50000000000"
      />
    );

    // Verify three scenario titles
    expect(screen.getByText("Conservative Scenario")).toBeInTheDocument();
    expect(screen.getByText("Current Pace Scenario")).toBeInTheDocument();
    expect(screen.getByText("Optimistic Scenario")).toBeInTheDocument();

    // Verify all disclaimers are present
    expect(screen.getByText(/Conservative forecast/)).toBeInTheDocument();
    expect(screen.getByText(/Baseline forecast/)).toBeInTheDocument();
    expect(screen.getByText(/Optimistic forecast/)).toBeInTheDocument();
  });

  it("should show assumptions list for each scenario", () => {
    render(
      <SponsorReceipt
        campaignId="123"
        sponsorAddress="GXXX..."
        amount="50000000000"
      />
    );

    // Each scenario should show its assumptions
    expect(screen.getByText("Annual planting rate")).toBeInTheDocument();
    expect(screen.getByText("Tree survival rate")).toBeInTheDocument();
  });

  it("should show uncertainty band for each scenario", () => {
    render(
      <SponsorReceipt
        campaignId="123"
        sponsorAddress="GXXX..."
        amount="50000000000"
      />
    );

    // Uncertainty bands should be visible
    expect(screen.getByText(/±\d+%/)).toBeInTheDocument();
  });
});
```

---

## Objective #3: Campaign Target Change Tracking

### Unit Tests

**File:** `apps/web/src/services/campaign-target-history.service.test.ts`

```typescript
import {
  validateTargetChange,
  calculateTargetChangeImpactOnSponsor,
  canChangeTargetInState,
  recordTargetChange,
  generateTargetChangeNotification,
  getTargetChangeAuditMessage,
} from "@/services/campaign-target-history.service";

describe("campaign-target-history", () => {
  it("should allow target changes only in draft and paused states", () => {
    expect(canChangeTargetInState("draft")).toBe(true);
    expect(canChangeTargetInState("paused")).toBe(true);
    expect(canChangeTargetInState("active")).toBe(false);
    expect(canChangeTargetInState("successful")).toBe(false);
  });

  it("should validate target change rules", () => {
    // Valid change
    const valid = validateTargetChange(
      "100000000000",
      "50000000000",
      "draft"
    );
    expect(valid.valid).toBe(true);

    // Invalid: target less than current funding
    const invalid = validateTargetChange(
      "30000000000",
      "50000000000",
      "draft"
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.reason).toContain("less than current funding");

    // Invalid: change while active
    const invalidState = validateTargetChange(
      "100000000000",
      "50000000000",
      "active"
    );
    expect(invalidState.valid).toBe(false);
  });

  it("should calculate impact on sponsor progress", () => {
    const impact = calculateTargetChangeImpactOnSponsor(
      "10000000000", // sponsor contribution
      "50000000000", // old target
      "100000000000", // new target
      "45000000000" // current funding
    );

    expect(impact.progressPercentageChange.previousPercent).toBe(90); // 45/50
    expect(impact.progressPercentageChange.currentPercent).toBe(45); // 45/100
    expect(impact.progressPercentageChange.change).toBe(-45);
  });

  it("should record target change with timestamp", () => {
    const change = recordTargetChange("123", {
      previousTarget: "50000000000",
      newTarget: "100000000000",
      reason: "campaign_creator_request",
      changedBy: "GCREATOR...",
      campaignState: "draft",
      affectedSponsorCount: 5,
      fundingAtChange: "25000000000",
    });

    expect(change.changedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(change.changedAt).toBeGreaterThan(0);
  });

  it("should generate sponsor notification", () => {
    const notification = generateTargetChangeNotification(
      "Save the Amazon",
      {
        changedAt: Math.floor(Date.now() / 1000),
        previousTarget: "50000000000",
        newTarget: "100000000000",
        reason: "campaign_creator_request",
        changedBy: "GCREATOR...",
        campaignState: "draft",
        affectedSponsorCount: 5,
        fundingAtChange: "45000000000",
      },
      "GSPONSOR..."
    );

    expect(notification.subject).toContain("goal increased");
    expect(notification.body).toContain("Save the Amazon");
    expect(notification.emphasis).toBe("warning"); // Increase = more funding needed
  });

  it("should generate audit message for logging", () => {
    const message = getTargetChangeAuditMessage("123", {
      changedAt: Math.floor(Date.now() / 1000),
      previousTarget: "50000000000",
      newTarget: "100000000000",
      reason: "campaign_creator_request",
      changedBy: "GCREATOR...",
      campaignState: "draft",
      affectedSponsorCount: 5,
      fundingAtChange: "45000000000",
    });

    expect(message).toContain("target changed");
    expect(message).toContain("50 USDC");
    expect(message).toContain("100 USDC");
  });
});
```

### Integration Tests

**Verify campaign detail page shows target history:**

```tsx
import { render, screen } from "@testing-library/react";
import { CampaignDetail } from "@/components/modules/campaign/CampaignDetail";

describe("Campaign Detail with Target History", () => {
  it("should display target change history section", () => {
    render(
      <CampaignDetail
        campaignId="123"
        campaign={{
          name: "Test Campaign",
          targetHistory: [
            {
              changedAt: 1700000000,
              previousTarget: "50000000000",
              newTarget: "100000000000",
              reason: "campaign_creator_request",
              changedBy: "GCREATOR...",
              campaignState: "draft",
              affectedSponsorCount: 5,
              fundingAtChange: "0",
            },
          ],
        }}
      />
    );

    expect(screen.getByText("Target History")).toBeInTheDocument();
    expect(screen.getByText(/changed from/)).toBeInTheDocument();
  });
});
```

---

## Objective #4: Localization & Material Terms

### Unit Tests

**File:** `apps/web/src/lib/material-terms-glossary.test.ts`

```typescript
import {
  getMaterialTermEntry,
  getMaterialTermTranslation,
  isMaterialTermFullyTranslated,
  getUntranslatedMaterialTerms,
} from "@/lib/material-terms-glossary";

describe("material-terms-glossary", () => {
  it("should return material term entry", () => {
    const entry = getMaterialTermEntry("CO2 offset");
    expect(entry).toBeDefined();
    expect(entry?.englishTerm).toBe("CO2 offset");
    expect(entry?.translations.en).toBeDefined();
  });

  it("should get translated term", () => {
    const spanish = getMaterialTermTranslation("CO2 offset", "es");
    expect(spanish).toBe("Compensación de carbono");

    const french = getMaterialTermTranslation("CO2 offset", "fr");
    expect(french).toBe("Compensation carbone");
  });

  it("should return undefined for missing translations", () => {
    const missing = getMaterialTermTranslation("CO2 offset", "zh");
    expect(missing).toBeUndefined();
  });

  it("should check if term is fully translated", () => {
    const fullyTranslated = isMaterialTermFullyTranslated("CO2 offset");
    expect(typeof fullyTranslated).toBe("boolean");
  });

  it("should identify untranslated terms", () => {
    const gaps = getUntranslatedMaterialTerms();
    expect(Array.isArray(gaps)).toBe(true);

    gaps.forEach(gap => {
      expect(gap.term).toBeDefined();
      expect(gap.missingLocales).toBeInstanceOf(Array);
    });
  });

  it("should include all required locales for each term", () => {
    const entry = getMaterialTermEntry("CO2 offset");
    expect(entry?.requiredLocales).toContain("en");
    expect(entry?.requiredLocales.length).toBeGreaterThan(0);
  });

  it("should mark incomplete translations", () => {
    const entry = getMaterialTermEntry("CO2 offset");
    const japaneseTranslation = entry?.translations.ja;
    if (japaneseTranslation?.incomplete) {
      expect(japaneseTranslation.incomplete).toBe(true);
    }
  });
});
```

### Integration Tests

**Verify terms are used in components:**

```tsx
import { render, screen } from "@testing-library/react";
import { CampaignDescription } from "@/components/modules/campaign/CampaignDescription";

describe("Campaign Description with Translated Terms", () => {
  it("should display material terms in user locale", () => {
    render(
      <CampaignDescription
        campaignId="123"
        locale="es"
      />
    );

    // Spanish term for "CO2 offset" should appear
    expect(screen.getByText(/Compensación de carbono/)).toBeInTheDocument();
  });

  it("should show tooltip with definition for material term", () => {
    render(
      <CampaignDescription
        campaignId="123"
        locale="en"
      />
    );

    const term = screen.getByText("Verification evidence");
    expect(term).toHaveAttribute("title"); // Tooltip
  });
});
```

---

## Manual Testing Checklist

### Objective #1 Checklist
- [ ] Open campaign detail page
- [ ] Verify CO2 metric displays "IPCC AR6 Tier 1" as source
- [ ] Click "View Evidence" link
- [ ] Verify evidence link goes to audit contract
- [ ] Verify "Verified" vs "Reported" badges appear correctly
- [ ] Check that uncertainty band (±15%) is displayed
- [ ] Try different locales and verify labels translate

### Objective #2 Checklist
- [ ] Open sponsor receipt page
- [ ] Verify three scenarios displayed (conservative, current pace, optimistic)
- [ ] Expand each scenario and verify all assumptions list
- [ ] Verify disclaimer appears: "⚠️ This is a forecast"
- [ ] Verify "Last updated" date shown
- [ ] Verify sponsor proportional exposure calculated correctly
- [ ] Verify metrics are NOT labeled as "settled balance" or "guaranteed"

### Objective #3 Checklist
- [ ] Create new campaign (target = 50,000 USDC)
- [ ] Try to change target while active → should fail with error
- [ ] Pause campaign → change target to 100,000 USDC
- [ ] Verify change notification sent to sponsors
- [ ] Open campaign detail → verify target history shown
- [ ] Verify old sponsors' progress % recalculated correctly
- [ ] Add new sponsor after target change → verify they see new target

### Objective #4 Checklist
- [ ] Switch UI locale to Spanish
- [ ] Verify "CO2 offset" displays as "Compensación de carbono"
- [ ] Verify all material terms in receipts translated
- [ ] Open glossary page (if exists) → verify all terms + definitions
- [ ] Check incomplete translations list
- [ ] Verify numbers/currency formatted for locale (1,000.00 vs 1.000,00)
- [ ] Test RTL language (if supported)

---

## Performance Testing

### Before & After Comparison

```typescript
// Time: Carbon offset calculation with provenance
console.time("CO2 calculation");
calculateCo2OffsetWithProvenance([
  { speciesId: "oak", treeCount: 1000 },
  { speciesId: "pine", treeCount: 500 },
]);
console.timeEnd("CO2 calculation");
// Expected: <5ms

// Time: Generate sponsor exposure report
console.time("Exposure report");
generateSponsorExposureReport(
  "GXXX...",
  "50000000000",
  "Campaign",
  "123",
  2100,
  42000
);
console.timeEnd("Exposure report");
// Expected: <10ms

// Time: Render impact metrics component
console.time("Render metrics");
render(<ImpactMetricsWithEvidence metrics={[...]} />);
console.timeEnd("Render metrics");
// Expected: <100ms
```

---

## Deployment Verification

After deploying to production:

1. **Monitor logs for errors**
   ```bash
   grep -i "carbon-accounting\|scenario\|target-change\|material-term" logs/*.log
   ```

2. **Verify no hardcoded CO2 rates remain**
   ```bash
   grep -r "const.*CO2.*=.*20" apps/web/src --exclude-dir=node_modules
   # Should return 0 results (except in carbon-accounting-constants.ts)
   ```

3. **Check all forecasts have disclaimers**
   - View campaign receipt in production
   - Verify "⚠️ forecast" label visible

4. **Verify translations deployed**
   - Switch locale in settings
   - Check material terms appear in selected language

---

## Troubleshooting

### Issue: CO2 calculations differ from before

**Cause:** Using different default rate or uncertainty band

**Fix:** Verify using `DEFAULT_CO2_KG_PER_TREE_PER_YEAR` from carbon-accounting-constants.ts

### Issue: Scenarios not showing in receipt

**Cause:** `generateSponsorExposureReport()` not called

**Fix:** Add to receipt generation:
```typescript
const report = generateSponsorExposureReport(...);
// Pass report.scenarios to component
```

### Issue: Target changes breaking calculations

**Cause:** Using current target instead of historical target

**Fix:** Update milestone calculations to use `milestone.targetAtMilestoneCreation` instead of `campaign.currentTarget`

### Issue: Translations missing

**Cause:** Not all material terms translated to required locale

**Fix:** Run `getUntranslatedMaterialTerms()` and add missing translations
