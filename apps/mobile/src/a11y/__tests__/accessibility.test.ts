import { describe, expect, it } from "vitest";
import {
  auditContrast,
  auditFontScaling,
  auditFocusOrder,
  campaignDetailLabels,
  connectionBadgeLabel,
  contrastRatio,
  CORE_SCREEN_CONTRAST_AUDIT,
  fundingPercent,
  meetsContrastAA,
  relativeLuminance,
  scaledFont,
  wishlistButtonLabel,
} from "../accessibility";
import type { CampaignDetail } from "../../offline/types";

const sampleCampaign: CampaignDetail = {
  id: "c1",
  name: "Reforestation",
  status: "active",
  goalAmount: "5000",
  raisedAmount: "1250",
  treeCount: 42,
  sponsorCount: 7,
  sponsors: [],
  verificationProgress: 60,
};

describe("contrast", () => {
  it("computes relative luminance for black and white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 4);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 4);
  });

  it("computes contrast ratio in [1, 21]", () => {
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 4);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 4);
    expect(contrastRatio("#4f2d99", "#ffffff")).toBeGreaterThan(1);
  });

  it("applies AA thresholds (4.5 normal, 3 large)", () => {
    expect(meetsContrastAA("#000000", "#ffffff", false)).toBe(true);
    expect(meetsContrastAA("#888888", "#ffffff", false)).toBe(false);
    expect(meetsContrastAA("#888888", "#ffffff", true)).toBe(true);
    expect(meetsContrastAA("#cccccc", "#ffffff", true)).toBe(false);
  });

  it("parses 3-digit hex too", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 4);
  });

  it("throws on invalid hex", () => {
    expect(() => relativeLuminance("#ggg")).toThrow();
  });
});

describe("core-screen contrast audit", () => {
  it("every core-screen pair meets WCAG AA", () => {
    const failures = auditContrast(CORE_SCREEN_CONTRAST_AUDIT);
    expect(failures).toEqual([]);
  });

  it("flags a deliberately-broken pair", () => {
    const failures = auditContrast([
      { where: "low contrast", foreground: "#cccccc", background: "#ffffff" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].where).toBe("low contrast");
  });
});

describe("dynamic type", () => {
  it("scales font sizes up and clamps at the max", () => {
    expect(scaledFont(16, 1)).toBe(16);
    expect(scaledFont(16, 2, { max: 24 })).toBe(24);
    expect(scaledFont(16, 0.5, { min: 14 })).toBe(14);
  });

  it("falls back to scale 1 for invalid fontScale", () => {
    expect(scaledFont(16, NaN)).toBe(16);
    expect(scaledFont(16, 0)).toBe(16);
    expect(scaledFont(16, -2)).toBe(16);
  });

  it("auditFontScaling passes at 1x and scales cleanly at extremes", () => {
    expect(auditFontScaling(1)).toEqual([]);
    expect(auditFontScaling(2)).toEqual([]);
    expect(auditFontScaling(0.5)).toEqual([]);
  });

  it("auditFontScaling flags a base size that can't grow", () => {
    const failures = auditFontScaling(
      2,
      [{ where: "giant", baseSize: 100 }],
      { min: 11, max: 96 },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].where).toBe("giant");
  });
});

describe("screen-reader labels", () => {
  const campaign: CampaignDetail = sampleCampaign;

  it("wishlist button label tracks state", () => {
    expect(wishlistButtonLabel(false)).toBe("Add to wishlist");
    expect(wishlistButtonLabel(true)).toBe("Remove from wishlist");
  });

  it("connection badge label tracks state", () => {
    expect(connectionBadgeLabel(true)).toBe("Live updates connected");
    expect(connectionBadgeLabel(false)).toBe("Offline — showing last saved data");
  });

  it("campaign detail labels are non-empty for quantitative fields", () => {
    const labels = campaignDetailLabels(campaign);

    expect(labels.campaignName).toBe("Reforestation");
    expect(labels.treeCount).toBe("42 trees planted");
    expect(labels.sponsors).toBe("7 sponsors");
    expect(labels.raised).toBe("1250 raised");
    expect(labels.goal).toBe("5000 goal");
    expect(labels.fundingProgress).toContain("Funding progress");
    expect(labels.verificationProgress).toContain("Verification progress");
    expect(labels.description).toBe("");
    expect(labels.location).toBe("");
  });

  it("handles missing optional fields gracefully", () => {
    const bare: CampaignDetail = {
      ...campaign,
      location: undefined,
      description: undefined,
      verificationProgress: undefined,
    };
    const labels = campaignDetailLabels(bare);
    expect(labels.location).toBe("");
    expect(labels.description).toBe("");
    expect(labels.verificationProgress).toBe("Verification progress, 0 percent");
  });
});

describe("funding percent", () => {
  it("computes percent from decimal string amounts", () => {
    expect(fundingPercent({ ...sampleCampaign, goalAmount: "1000", raisedAmount: "250" })).toBe(25);
    expect(fundingPercent({ ...sampleCampaign, goalAmount: "0", raisedAmount: "100" })).toBe(0);
    expect(fundingPercent({ ...sampleCampaign, goalAmount: "abc", raisedAmount: "10" })).toBe(0);
  });
});

describe("focus order", () => {
  const interactive = (id: string, label: string) => ({ id, interactive: true, label });
  const nonInteractive = (id: string) => ({ id, interactive: false, label: "" });

  it("passes when all interactive elements are labeled and order matches", () => {
    const actual = [
      interactive("header", "Campaign detail"),
      interactive("wishlist", "Add to wishlist"),
      nonInteractive("divider"),
    ];
    const result = auditFocusOrder(actual, ["header", "wishlist", "divider"]);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("flags unlabeled interactive elements", () => {
    const actual = [interactive("button", ""), interactive("toggle", "Notify")];
    const result = auditFocusOrder(actual, ["button", "toggle"]);

    expect(result.ok).toBe(false);
    expect(result.problems).toContain('interactive element "button" has no label');
  });

  it("flags focus-order mismatches", () => {
    const actual = [interactive("a", "A"), interactive("b", "B")];
    const result = auditFocusOrder(actual, ["b", "a"]);

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("focus order mismatch"))).toBe(true);
  });

  it("flags length mismatches", () => {
    const actual = [interactive("a", "A")];
    const result = auditFocusOrder(actual, ["a", "b"]);

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("length mismatch"))).toBe(true);
  });
});
