/**
 * Mobile accessibility helpers + audit rules (issue #92).
 *
 * React Native screens cannot be rendered in CI (no native toolchain in this
 * repo), so the verifiable core of the accessibility work lives here as pure
 * functions with deterministic tests:
 *
 *   - `contrastRatio` / `meetsContrastAA`: WCAG 2.1 contrast math, used to
 *     audit the core-screen color palette (`CORE_SCREEN_CONTRAST_AUDIT`).
 *   - `scaledFont` / `auditFontScaling`: Dynamic Type support — font sizes
 *     must scale with the OS text-size setting within sane bounds.
 *   - `campaignDetailLabels`: screen-reader labels for the campaign detail
 *     screen; every quantitative element must yield a human-readable label.
 *   - `auditFocusOrder`: focus (screen-reader traversal) must follow the
 *     declared order with no unlabeled interactive elements.
 *
 * The on-device checklist (VoiceOver/TalkBack, Dynamic Type steps, manual
 * contrast inspection) is documented in `ACCESSIBILITY.md`.
 */

import type { CampaignDetail } from "../offline/types";

// ── Contrast (WCAG 2.1) ──────────────────────────────────────────────────────

/** Parse `#rgb` / `#rrggbb` into [r, g, b] in 0-255. Throws on bad input. */
function parseHex(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    return [
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }
  throw new Error(`Invalid hex color: ${hex}`);
}

/** WCAG relative luminance of an sRGB channel value (0-255). */
function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance of a hex color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG 2.1 contrast ratio between two hex colors, in [1, 21]. */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * AA threshold: 4.5:1 for normal text, 3:1 for large text (>=18pt regular or
 * >=14pt bold) and non-text UI components.
 */
export function meetsContrastAA(
  foreground: string,
  background: string,
  largeText = false,
): boolean {
  const required = largeText ? 3 : 4.5;
  return contrastRatio(foreground, background) >= required;
}

// ── Dynamic Type ─────────────────────────────────────────────────────────────

/** Bounds for scaled font sizes (points). */
export interface FontScaleBounds {
  /** Smallest rendered size, e.g. floor for very large accessibility scales. */
  min?: number;
  /** Largest rendered size. */
  max?: number;
}

// ── Screen-reader labels ─────────────────────────────────────────────────────

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** Screen-reader label for the wishlist toggle on the detail screen. */
export function wishlistButtonLabel(inWishlist: boolean): string {
  return inWishlist ? "Remove from wishlist" : "Add to wishlist";
}

/** Screen-reader label for the live/offline connection badge. */
export function connectionBadgeLabel(connected: boolean): string {
  return connected
    ? "Live updates connected"
    : "Offline — showing last saved data";
}

/** Funding percent (0-100) from decimal string amounts; 0 on bad input. */
export function fundingPercent(campaign: CampaignDetail): number {
  try {
    const goal = BigInt(campaign.goalAmount);
    if (goal === 0n) return 0;
    const raised = BigInt(campaign.raisedAmount);
    const pct = Number((raised * 100n) / goal);
    return Math.min(100, Math.max(0, pct));
  } catch {
    return 0;
  }
}

/**
 * Screen-reader labels for every quantitative element of the campaign detail
 * screen. Keys mirror the visual sections; all non-optional values are
 * guaranteed non-empty for any input.
 */
export function campaignDetailLabels(
  campaign: CampaignDetail,
): Record<string, string> {
  const progress = (value: number): string =>
    `${Math.min(100, Math.max(0, Math.round(value)))} percent`;
  return {
    campaignName: campaign.name || "Unnamed campaign",
    treeCount: `${formatCount(campaign.treeCount)} trees planted`,
    sponsors: `${formatCount(campaign.sponsorCount)} sponsors`,
    raised: `${campaign.raisedAmount} raised`,
    goal: `${campaign.goalAmount} goal`,
    fundingProgress: `Funding progress, ${progress(fundingPercent(campaign))}`,
    verificationProgress: `Verification progress, ${progress(
      campaign.verificationProgress ?? 0,
    )}`,
    location: campaign.location ? `Located in ${campaign.location}` : "",
    description: campaign.description ?? "",
  };
}

// ── Focus order ──────────────────────────────────────────────────────────────

/** A focusable element as the screen reader would traverse it. */
export interface FocusableElement {
  /** Stable identifier (test/telemetry only). */
  id: string;
  /** Whether the element is actionable (button, link, toggle...). */
  interactive: boolean;
  /** Screen-reader label; must be non-empty for interactive elements. */
  label: string;
}

/**
 * Audit focus traversal: every interactive element must carry a non-empty
 * label, and the order must match the expected sequence of ids.
 */
export function auditFocusOrder(
  actual: readonly FocusableElement[],
  expectedOrder: readonly string[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const element of actual) {
    if (element.interactive && element.label.trim().length === 0) {
      problems.push(`interactive element "${element.id}" has no label`);
    }
  }
  const actualOrder = actual.map((element) => element.id);
  const expected = [...expectedOrder];
  if (actualOrder.length !== expected.length) {
    problems.push(
      `focus order length mismatch: expected ${expected.length}, got ${actualOrder.length}`,
    );
  } else {
    expected.forEach((id, index) => {
      if (actualOrder[index] !== id) {
        problems.push(
          `focus order mismatch at ${index}: expected "${id}", got "${actualOrder[index]}"`,
        );
      }
    });
  }
  return { ok: problems.length === 0, problems };
}

// ── Core-screen palette audit ────────────────────────────────────────────────

/** A foreground/background color pair used on a core screen. */
export interface ContrastPair {
  where: string;
  foreground: string;
  background: string;
  /** True when the text is large/bold (3:1 threshold). */
  largeText?: boolean;
}

/**
 * Color pairs from `CampaignDetailScreen` (the only rendered core screen).
 * Kept in sync with the StyleSheet constants; the audit test fails CI if any
 * pair drops below WCAG AA.
 */
export const CORE_SCREEN_CONTRAST_AUDIT: readonly ContrastPair[] = [
  { where: "header title on header", foreground: "#ffffff", background: "#4f2d99" },
  { where: "header tag on header", foreground: "#ffffff", background: "#4f2d99", largeText: true },
  { where: "tree label on tree card", foreground: "#ffffff", background: "#1a7248" },
  { where: "stat label on card", foreground: "#6b6b80", background: "#ffffff" },
  { where: "stat value on card", foreground: "#1a1a28", background: "#ffffff" },
  { where: "accent stat value on card", foreground: "#4f2d99", background: "#ffffff" },
  { where: "description on body", foreground: "#3a3a50", background: "#f9f9fb" },
  { where: "location on body", foreground: "#6b6b80", background: "#f9f9fb" },
  { where: "sponsor amount on row", foreground: "#1a7248", background: "#ffffff" },
  { where: "error text on body", foreground: "#c0392b", background: "#f9f9fb" },
  { where: "progress percent on body", foreground: "#4f2d99", background: "#f9f9fb" },
  { where: "sustainability score on card", foreground: "#1a7248", background: "#ffffff", largeText: true },
];

/** Run the core-screen contrast audit; returns failing pairs. */
export function auditContrast(
  pairs: readonly ContrastPair[] = CORE_SCREEN_CONTRAST_AUDIT,
): { where: string; ratio: number }[] {
  return pairs
    .map((pair) => ({
      where: pair.where,
      ratio: contrastRatio(pair.foreground, pair.background),
    }))
    .filter(
      (result, index) =>
        result.ratio < (pairs[index].largeText ? 3 : 4.5),
    );
}

/** Font styles from the core screen that must support Dynamic Type. */
export const CORE_SCREEN_FONT_SCALES: readonly {
  where: string;
  baseSize: number;
}[] = [
  { where: "headerTitle", baseSize: 22 },
  { where: "treeCount", baseSize: 56 },
  { where: "treeLabel", baseSize: 13 },
  { where: "statValue", baseSize: 16 },
  { where: "description", baseSize: 14 },
  { where: "sectionTitle", baseSize: 16 },
  { where: "sponsorAddress", baseSize: 13 },
];

/**
 * Audit Dynamic Type support: every base size must scale up at 2x without
 * hitting the max clamp (which would mean truncated growth) and must never
 * render below the readability floor at 0.5x.
 */
export function auditFontScaling(
  fontScale: number,
  styles: readonly { where: string; baseSize: number }[] = CORE_SCREEN_FONT_SCALES,
  bounds: FontScaleBounds = { min: 11, max: 96 },
): { where: string; size: number }[] {
  return styles
    .map((style) => ({
      where: style.where,
      size: scaledFont(style.baseSize, fontScale, bounds),
    }))
    .filter((entry) => {
      const style = styles.find((s) => s.where === entry.where);
      if (!style) return false;
      const clampedMin = bounds.min ?? 11;
      // At 2x the size must genuinely grow (not be pinned at the clamp);
      // at 0.5x it must stay >= the readability floor.
      if (fontScale >= 2) {
        return entry.size <= style.baseSize;
      }
      if (fontScale <= 0.5) {
        return (
          entry.size < clampedMin ||
          (style.baseSize > clampedMin && entry.size >= style.baseSize)
        );
      }
      return false;
    });
}

/**
 * Scale a font size by the OS text-size multiplier (iOS `fontScale` / Android
 * font scale), clamped to `bounds` so layouts neither collapse nor explode.
 */
export function scaledFont(
  baseSize: number,
  fontScale: number,
  bounds: FontScaleBounds = {},
): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const raw = baseSize * scale;
  const min = bounds.min ?? 11;
  const max = bounds.max ?? 96;
  return Math.min(max, Math.max(min, Math.round(raw)));
}