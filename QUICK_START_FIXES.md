# Quick Start: Implementing the Four Fixes

**TL;DR:** Copy-paste code snippets to implement all four fixes in your app.

---

## Fix #1: Display Impact with Evidence Links

**Step 1:** Import the component

```tsx
import { ImpactMetricsWithEvidence } from "@/components/modules/impact/ImpactMetricsWithEvidence";
```

**Step 2:** Use in your campaign page

```tsx
<ImpactMetricsWithEvidence
  metrics={[
    {
      label: "CO2 Offset",
      value: campaign.co2Kg,
      unit: "kg CO₂e/year",
      verificationStatus: campaign.isVerified ? "verified" : "reported",
      evidenceLink: `/api/campaigns/${campaign.id}/verification-audit`,
      lastUpdated: campaign.lastUpdated,
      uncertaintyBand: "±15%",
      source: "IPCC AR6 Tier 1",
      methodologyLink: "/docs/carbon-accounting-methodology",
    },
  ]}
  campaignName={campaign.name}
  locale={userLocale}
/>
```

---

## Fix #2: Show Scenarios with Assumptions

**Step 1:** Import the service

```typescript
import { generateSponsorExposureReport } from "@/services/campaign-scenario-exposure.service";
```

**Step 2:** Generate report

```typescript
const report = generateSponsorExposureReport(
  sponsorAddress,
  sponsorAmountStroops,
  campaign.name,
  campaign.id,
  campaign.verifiedTrees,
  campaign.verifiedCo2
);
```

**Step 3:** Display scenarios

```tsx
{report.scenarios.map(scenario => (
  <div key={scenario.scenarioName} className="border rounded p-4">
    <h3>{scenario.title}</h3>
    <p className="text-red-600 font-bold">{scenario.disclaimerLabel}</p>
    
    <h4 className="mt-4 font-semibold">Assumptions:</h4>
    <ul className="text-sm space-y-1">
      {scenario.assumptions.map(a => (
        <li key={a.name}>
          {a.name}: {a.value}
          <span className="text-gray-500"> ({a.confidence} confidence)</span>
        </li>
      ))}
    </ul>
    
    <h4 className="mt-4 font-semibold">Projections:</h4>
    <p>1 year: {scenario.oneYearProjection.projectedTrees.toLocaleString()} trees</p>
    <p>5 years: {scenario.fiveYearProjection.projectedTrees.toLocaleString()} trees</p>
    <p>Uncertainty: {scenario.totalUncertaintyBand}</p>
  </div>
))}
```

---

## Fix #3: Track Target Changes

**Step 1:** Import service

```typescript
import {
  validateTargetChange,
  recordTargetChange,
  generateTargetChangeNotification,
} from "@/services/campaign-target-history.service";
```

**Step 2:** When campaign creator changes target

```typescript
// Validate
const validation = validateTargetChange(
  newTarget,
  campaign.currentFunding,
  campaign.state
);

if (!validation.valid) {
  throw new Error(validation.reason);
}

// Record
const change = recordTargetChange(campaign.id, {
  previousTarget: campaign.target,
  newTarget,
  reason: "campaign_creator_request",
  changedBy: userId,
  campaignState: campaign.state,
  affectedSponsorCount: campaign.sponsors.length,
  fundingAtChange: campaign.currentFunding,
});

// Save to database
await db.campaigns.update(campaign.id, {
  target: newTarget,
  targetHistory: [...campaign.targetHistory, change],
});

// Notify sponsors
for (const sponsor of campaign.sponsors) {
  const notification = generateTargetChangeNotification(
    campaign.name,
    change,
    sponsor.address
  );
  
  await emailService.send({
    to: sponsor.email,
    subject: notification.subject,
    body: notification.body,
  });
}
```

**Step 3:** Display target history on campaign page

```tsx
<div>
  <h3>Target History</h3>
  {campaign.targetHistory && campaign.targetHistory.map(change => (
    <div key={change.changedAt} className="text-sm border-l-4 pl-3 mb-3">
      <p>
        <strong>{new Date(change.changedAt * 1000).toLocaleDateString()}</strong>:
        Target changed from {change.previousTarget} to {change.newTarget}
      </p>
      <p className="text-gray-600">Reason: {change.reason}</p>
      <p className="text-gray-600">Sponsors affected: {change.affectedSponsorCount}</p>
    </div>
  ))}
</div>
```

---

## Fix #4: Translate Material Terms

**Step 1:** Import helper

```typescript
import { getMaterialTermTranslation } from "@/lib/material-terms-glossary";
```

**Step 2:** Use everywhere you display financial/technical terms

```tsx
// Before ❌
<p>CO2 offset: {metric.co2}</p>

// After ✅
<p>
  {getMaterialTermTranslation("CO2 offset", userLocale) || "CO2 offset"}:
  {metric.co2}
</p>
```

**Step 3:** (Optional) Add glossary page

```tsx
import { MATERIAL_TERMS, getUntranslatedMaterialTerms } from "@/lib/material-terms-glossary";

export function GlossaryPage() {
  const untranslated = getUntranslatedMaterialTerms();
  
  return (
    <div>
      <h1>Financial & Technical Terms Glossary</h1>
      
      {untranslated.length > 0 && (
        <div className="bg-yellow-100 p-3 rounded mb-4">
          ⚠️ {untranslated.length} terms not yet translated to all languages:
          <ul>
            {untranslated.map(item => (
              <li key={item.term}>
                {item.term}: missing {item.missingLocales.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {MATERIAL_TERMS.map(term => (
          <div key={term.englishTerm} className="border rounded p-4">
            <h3 className="font-bold">{term.englishTerm}</h3>
            <p className="text-sm text-gray-600">{term.definition}</p>
            <p className="text-xs mt-2">Context: {term.context}</p>
            <p className="text-xs text-gray-500">
              Source: {term.source}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Fix All 4 Issues in One Page Component

```tsx
"use client";

import { useState } from "react";
import { ImpactMetricsWithEvidence } from "@/components/modules/impact/ImpactMetricsWithEvidence";
import {
  generateSponsorExposureReport,
  getScenarioDisclaimer,
} from "@/services/campaign-scenario-exposure.service";
import {
  validateTargetChange,
  recordTargetChange,
  generateTargetChangeNotification,
} from "@/services/campaign-target-history.service";
import { getMaterialTermTranslation } from "@/lib/material-terms-glossary";

export function CampaignDetailComplete() {
  const [campaign, setCampaign] = useState(/* ... */);
  const [userLocale, setUserLocale] = useState("en");

  // Fix #1: Display impact metrics
  const impactMetrics = [
    {
      label: "CO2 Offset",
      value: campaign.co2,
      unit: "kg CO₂e/year",
      verificationStatus: "verified",
      lastUpdated: campaign.lastUpdated,
      uncertaintyBand: "±15%",
      source: "IPCC AR6",
      evidenceLink: `/api/campaigns/${campaign.id}/verification-audit`,
    },
  ];

  // Fix #2: Generate scenarios
  const sponsorReport = generateSponsorExposureReport(
    sponsorAddress,
    amountStroops,
    campaign.name,
    campaign.id,
    campaign.verifiedTrees,
    campaign.verifiedCo2
  );

  // Fix #3: Handle target change
  const handleTargetChange = async (newTarget: string) => {
    const validation = validateTargetChange(
      newTarget,
      campaign.currentFunding,
      campaign.state
    );

    if (!validation.valid) {
      alert(validation.reason);
      return;
    }

    const change = recordTargetChange(campaign.id, {
      previousTarget: campaign.target,
      newTarget,
      reason: "campaign_creator_request",
      changedBy: userId,
      campaignState: campaign.state,
      affectedSponsorCount: campaign.sponsors.length,
      fundingAtChange: campaign.currentFunding,
    });

    // ... save to DB and send notifications

    setCampaign({
      ...campaign,
      target: newTarget,
      targetHistory: [...(campaign.targetHistory || []), change],
    });
  };

  // Fix #4: Translate terms
  const co2OffsetLabel = getMaterialTermTranslation("CO2 offset", userLocale) || "CO2 offset";

  return (
    <div className="space-y-8">
      {/* Fix #1 */}
      <section>
        <h2 className="text-2xl font-bold">Impact</h2>
        <ImpactMetricsWithEvidence
          metrics={impactMetrics}
          campaignName={campaign.name}
          locale={userLocale}
        />
      </section>

      {/* Fix #2 */}
      <section>
        <h2 className="text-2xl font-bold">Sponsor Exposure Scenarios</h2>
        <div className="grid grid-cols-3 gap-4">
          {sponsorReport.scenarios.map(scenario => (
            <div key={scenario.scenarioName} className="border rounded p-4">
              <p className="text-red-600 font-bold mb-3">
                {scenario.disclaimerLabel}
              </p>
              <h3>{scenario.title}</h3>
              <ul className="text-sm mt-3 space-y-1">
                {scenario.assumptions.map(a => (
                  <li key={a.name}>
                    {a.name}: {a.value}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Fix #3 */}
      <section>
        <h2 className="text-2xl font-bold">Target History</h2>
        {campaign.targetHistory?.map(change => (
          <div key={change.changedAt} className="border-l-4 pl-3 mb-3">
            <p>
              {new Date(change.changedAt * 1000).toLocaleDateString()}:
              {change.previousTarget} → {change.newTarget}
            </p>
          </div>
        ))}
      </section>

      {/* Fix #4 */}
      <section>
        <h2 className="text-2xl font-bold">Campaign Details</h2>
        <p>
          {co2OffsetLabel}: {campaign.co2}
        </p>
      </section>
    </div>
  );
}
```

---

## Testing

```bash
# Run all tests
pnpm test

# Test carbon constants
pnpm test -- carbon-accounting-constants.test.ts

# Test components
pnpm test -- ImpactMetricsWithEvidence.test.tsx

# Build (verify no TypeScript errors)
pnpm build
```

---

## Common Issues & Solutions

**Q: Where should I call `generateSponsorExposureReport()`?**  
A: When generating a sponsor receipt or impact report. Usually in a server action or API route.

**Q: Do I need to update the contract?**  
A: Only if you want to store `targetHistory` on-chain. Otherwise store in off-chain database.

**Q: What if a locale isn't translated?**  
A: Falls back to English. Check `getUntranslatedMaterialTerms()` for gaps.

**Q: Do I need to use all three scenarios?**  
A: You can customize. The service provides three, but you can filter or add more.

---

## Next Steps

1. **Import modules** into your existing components
2. **Replace hardcoded values** with functions from these services
3. **Add to campaign page** the component examples above
4. **Run tests** to verify everything works
5. **Deploy** with confidence!

---

**Questions?** See IMPLEMENTATION_FIXES_SUMMARY.md for detailed documentation.
