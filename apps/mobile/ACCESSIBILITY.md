# Mobile Accessibility & Dynamic Type Guide

Issue: [Amiricloud1/stellar_client_os#92](https://github.com/Amiricloud1/stellar_client_os/issues/92)

This document details the accessibility architecture, automated verification rules, and manual device testing procedures for Fundable Protocol mobile clients.

---

## 1. Automated Verification Rules (`src/a11y/`)

Due to native toolchain requirements in continuous integration, the verifiable mathematical and logical core of accessibility is implemented as deterministic TypeScript functions under `src/a11y/accessibility.ts`.

### WCAG 2.1 Color Contrast
Contrast calculations adhere to WCAG 2.1 relative luminance formulas:
- Normal text requires a contrast ratio of at least **4.5:1** (AA standard).
- Large text (>=18pt regular or >=14pt bold) and non-text UI components require at least **3.0:1**.

The `CORE_SCREEN_CONTRAST_AUDIT` suite continuously validates all color pairs used in `CampaignDetailScreen`:

| Element Description          | Foreground | Background | Minimum Ratio | Status   |
| ---------------------------- | ---------- | ---------- | ------------- | -------- |
| Header title on purple       | `#ffffff`  | `#4f2d99`  | 4.5:1         | Meets AA |
| Header tag on purple         | `#ffffff`  | `#4f2d99`  | 3.0:1 (large) | Meets AA |
| Tree count label on green    | `#ffffff`  | `#1a7248`  | 4.5:1         | Meets AA |
| Stat label on white card     | `#6b6b80`  | `#ffffff`  | 4.5:1         | Meets AA |
| Stat value on white card     | `#1a1a28`  | `#ffffff`  | 4.5:1         | Meets AA |
| Accent stat on white card    | `#4f2d99`  | `#ffffff`  | 4.5:1         | Meets AA |
| Body description text        | `#3a3a50`  | `#f9f9fb`  | 4.5:1         | Meets AA |
| Location text on body        | `#6b6b80`  | `#f9f9fb`  | 4.5:1         | Meets AA |
| Sponsor amount on white row  | `#1a7248`  | `#ffffff`  | 4.5:1         | Meets AA |
| Error text on body           | `#c0392b`  | `#f9f9fb`  | 4.5:1         | Meets AA |
| Progress percent label       | `#4f2d99`  | `#f9f9fb`  | 4.5:1         | Meets AA |
| Sustainability score badge   | `#1a7248`  | `#ffffff`  | 3.0:1 (large) | Meets AA |

### Dynamic Type & Font Scaling
Font sizes must scale proportionally with user OS accessibility preferences without breaking layouts:
- `scaledFont(baseSize, fontScale, bounds)` calculates scaled font dimensions bounded by `min` (default 11pt) and `max` (default 96pt).
- `auditFontScaling` verifies that core screen styles scale cleanly at extremes (0.5x down to the readability floor, and 2x without failing to grow).

Core typography scales audited:
- `headerTitle`: 22pt base
- `treeCount`: 56pt base (display)
- `treeLabel`: 13pt base
- `statValue`: 16pt base
- `description`: 14pt base
- `sectionTitle`: 16pt base
- `sponsorAddress`: 13pt base

### Screen-Reader Labels
Every interactive and quantitative element provides descriptive, human-readable labels:
- `wishlistButtonLabel(inWishlist)`: Produces `"Add to wishlist"` or `"Remove from wishlist"`.
- `connectionBadgeLabel(connected)`: Produces `"Live updates connected"` or `"Offline — showing last saved data"`.
- `campaignDetailLabels(campaign)`: Generates structured spoken descriptions for tree counts, funding progress, sponsor participation, and verification percentages.
- `fundingPercent(campaign)`: Converts bigint/string values into normalized percentage values (0-100%).

### Focus Traversal & Actionable Elements
- `auditFocusOrder(elements, expectedOrder)` checks screen-reader traversal sequences.
- Ensures all interactive elements (`buttons`, `toggles`, `links`) contain non-empty accessibility labels.

---

## 2. On-Device Testing Checklist

Run these manual verification steps on physical iOS and Android test devices or simulators before releasing updates.

### A. Screen Reader Navigation
- **iOS (VoiceOver)**:
  1. Enable VoiceOver under **Settings > Accessibility > VoiceOver**.
  2. Swipe right to step through elements linearly from top to bottom.
  3. Verify that the header, status badge, and wishlist toggle announce their state accurately (e.g. "Add to wishlist, button").
  4. Double-tap to activate the wishlist toggle; confirm the announcement changes to "Remove from wishlist".
  5. Swipe through the stats card and tree counter; verify quantitative numbers include units (e.g., "42 trees planted", "1,250 raised").
- **Android (TalkBack)**:
  1. Enable TalkBack under **Settings > Accessibility > TalkBack**.
  2. Drag finger across screen (Explore by Touch) and swipe horizontally.
  3. Verify each card has distinct focus rectangles and appropriate roles announced.

### B. Dynamic Type & Text Scaling
- **iOS**:
  1. Navigate to **Settings > Accessibility > Display & Text Size > Larger Text**.
  2. Enable **Larger Accessibility Sizes** and drag the slider to the maximum setting.
  3. Open `CampaignDetailScreen`.
  4. Ensure text wraps rather than truncating with ellipses `...`.
  5. Check that stat cards wrap or scroll gracefully without visual overlap.
  6. Return slider to minimum setting; ensure text remains legible and does not drop below 11pt.
- **Android**:
  1. Navigate to **Settings > Display > Font size and display size**.
  2. Adjust Font size to "Largest" and Display size to "Largest".
  3. Verify cards retain margins and padding.

### C. Contrast & Appearance Modes
- **Dark Mode / Inverted Colors**:
  1. Toggle system dark mode / Classic Invert under Accessibility.
  2. Verify all text maintains legible contrast against its container background.
- **Increase Contrast**:
  1. Enable "Increase Contrast" in iOS / Android accessibility settings.
  2. Verify borders around cards (`#e4e0f0`) remain visible against the screen background.

---

## 3. Running Automated Tests

```bash
# Run unit tests and a11y audits
pnpm test:mobile

# Run TypeScript typechecks
pnpm typecheck:mobile
```
