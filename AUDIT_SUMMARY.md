# Quick Reference: 4 Critical Audit Findings

## 1️⃣ Impact Metrics — Missing Evidence & Measurement Source Linkage

**Problem:** CO2 calculations (20 kg/tree/year) appear in **6 different services** without:
- Source attribution (IPCC reference, scientific basis)
- Confidence intervals  
- Provenance tracking (Is this measured or estimated?)
- Single source of truth

**Affected Files:**
```
❌ apps/web/src/services/campaign-impact-report.service.ts:32
❌ apps/web/src/services/campaign-milestone-email.service.ts:11
❌ apps/web/src/services/campaign-progress-cache.service.ts:117
❌ apps/web/src/services/campaign.service.ts:880
❌ apps/web/src/services/campaign-hall-of-fame.service.ts
❌ apps/web/src/services/impact.service.ts (missing CI95 bounds)
```

**Quick Fixes:**
1. Create `/apps/web/src/lib/carbon-accounting-constants.ts` (single source)
2. Add provenance fields to `SponsorImpact` interface (source, ci95Low, ci95High, methodologyRef)
3. Update types to include `dataSourceRef`, `calculatedAt`

---

## 2️⃣ Scenarios & Forecasts — Not Labeled as Assumptions

**Problem:** Forecast models (growth curves, climate scenarios, survival rates) are presented without:
- Explicit "⚠ This is a forecast, not measured data" label
- Assumption documentation (what changes dramatically affect results?)
- Interpretation guidance (Moderate = baseline, not neutral)
- Retroactive assumption marking on historical data

**Affected Files:**
```
❌ apps/web/src/components/modules/dashboard/CO2SequestrationProjection.tsx (3 scenarios, no labels)
❌ apps/web/src/services/campaignAnalytics.ts:100-130 (growth curves, undocumented)
❌ apps/web/src/lib/co2-impact.ts:55-100 (CI derivation, no explanation)
❌ apps/web/src/services/campaign-impact-history.service.ts:120-160 (retroactive assumptions unlabeled)
```

**Quick Fixes:**
1. Add disclaimer component to CO2SequestrationProjection UI
2. Document growth curves with source reference (IPCC AR6 + FAO FRA 2020)
3. Add `dataSource: "verified_evidence" | "estimated" | "forecast"` to `CampaignImpactDataPoint`
4. Create `/docs/forecast-assumptions.md` explaining each assumption's sensitivity

---

## 3️⃣ Target Changes — No Tracking or Audit Trail

**Problem:** Campaign funding targets can change, but:
- No history of prior targets
- No when/why tracking
- Milestones retroactively broken (calculated against current target, not historical)
- Sponsors not notified
- No audit trail

**Affected Files:**
```
❌ apps/web/src/types/campaign.ts (targetAmount only, no history)
❌ apps/web/src/services/campaign.service.ts (no change tracking logic)
❌ contracts/campaign-funding/src/lib.rs (check_milestone_reached uses current target)
❌ apps/web/src/services/campaign-milestone-email.service.ts (uses current target, not historical)
```

**Quick Fixes:**
1. Add `targetHistory: TargetChangeRecord[]` to `CampaignRecord`
2. Create `/apps/web/src/services/milestone-audit.service.ts` to snapshot targets at milestone time
3. Create notification service for sponsor alerts on target changes
4. Update milestone email to use `targetAmountAtMilestone` from audit record

---

## 4️⃣ Localization & Material Terms — Incomplete

**Problem:** Platform supports 28+ languages but:
- Technical terms (CO2, sequestration, verification, sponsors) **not translated**
- No locale-specific number/unit formatting (1,000.50 vs. 1.000,50; kg vs. lbs)
- RTL (Arabic, Farsi) support incomplete
- No translation coverage tracking

**Affected Files:**
```
❌ apps/web/src/lib/translation.ts (only 6 fields translatable, no material terms)
❌ apps/web/src/lib/formatters.ts (no locale-specific formatting registry)
❌ All components using hardcoded units ("kg", "km", "$")
❌ No centralized glossary (50+ terms need translation)
```

**Quick Fixes:**
1. Create `/apps/web/src/lib/material-terms-glossary.ts` (50+ domain terms with translations)
2. Create `/apps/web/src/lib/locale-formatters.ts` for `formatCo2`, `formatNumber`, `formatDate`
3. Update components to apply `dir={direction}` for RTL
4. Add CI/CD check for translation coverage (min 95%)

---

## Impact & Timeline

| Issue | Risk | Users Affected | Est. Fix Time |
|-------|------|----------------|---------------|
| Impact Metrics | Medium | Auditors, donors, regulators | 3–5 days |
| Scenarios | High | Campaign creators, donors | 2–3 days |
| Target Changes | High | Campaign creators, sponsors | 3–4 days |
| Localization | Low | Non-English users (28+ locales) | 4–6 days |

**Total effort: ~2–3 weeks** to address all four issues with full testing.

---

## Next Steps

1. **Read full report:** `/workspaces/stellar_client_os/COMPREHENSIVE_AUDIT_FINDINGS.md` (200+ lines of details)
2. **Prioritize:** Start with Issue #2 (Scenarios) — highest impact, medium effort
3. **Create issues:** File GitHub issues for each of the 4 areas
4. **Implement:** Follow "Fixes Required" section in full report for each issue

