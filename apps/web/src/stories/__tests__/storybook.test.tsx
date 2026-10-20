// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as ButtonStories from "../components/Button.stories";
import * as FormFieldStories from "../components/FormField.stories";
import * as ModalStories from "../components/Modal.stories";
import * as ProductCardStories from "../components/ProductCard.stories";
import {
  buildStorybook,
  REQUIRED_STORY_STATES,
  verifyStorybookBuild,
} from "../../../scripts/build-storybook.mjs";

function renderStoryModuleExport(storyExport: unknown): ReturnType<typeof render> {
  if (typeof storyExport === "function") {
    const Component = storyExport as React.ComponentType;
    return render(<Component />);
  }
  const obj = storyExport as {
    render?: (args: Record<string, unknown>) => React.ReactElement;
    args?: Record<string, unknown>;
  };
  if (obj && typeof obj.render === "function") {
    return render(obj.render(obj.args ?? {}));
  }
  throw new Error("Unsupported story export format");
}

describe("Storybook core component states & static build verification (#85)", () => {
  afterEach(() => {
    cleanup();
  });

  describe("1. Core component stories export all required states", () => {
    const storyModules = [
      { name: "Button", mod: ButtonStories },
      { name: "FormField", mod: FormFieldStories },
      { name: "Modal", mod: ModalStories },
      { name: "ProductCard", mod: ProductCardStories },
    ];

    for (const { name, mod } of storyModules) {
      it(`${name}.stories.tsx exports Default, Loading, Empty, Error, Disabled, and Success stories`, () => {
        for (const state of REQUIRED_STORY_STATES) {
          expect(
            (mod as Record<string, unknown>)[state],
            `${name}.stories.tsx is missing export '${state}'`
          ).toBeDefined();
        }
      });
    }
  });

  describe("2. Runtime behavior of Button stories", () => {
    it("renders Default, Loading, Empty, Error, Disabled, and Success Button states with appropriate ARIA/disabled attributes", () => {
      renderStoryModuleExport(ButtonStories.Default);
      expect(screen.getByRole("button", { name: "Click me" })).toBeTruthy();
      cleanup();

      renderStoryModuleExport(ButtonStories.Loading);
      const loadingBtn = screen.getByTestId("button-story-loading") as HTMLButtonElement;
      expect(loadingBtn.disabled).toBe(true);
      expect(loadingBtn.getAttribute("aria-busy")).toBe("true");
      cleanup();

      renderStoryModuleExport(ButtonStories.Empty);
      expect(screen.getByTestId("button-story-empty").textContent).toContain(
        "No action available"
      );
      cleanup();

      renderStoryModuleExport(ButtonStories.Error);
      expect(screen.getByTestId("button-story-error").getAttribute("data-variant")).toBe(
        "destructive"
      );
      cleanup();

      renderStoryModuleExport(ButtonStories.Disabled);
      expect((screen.getByTestId("button-story-disabled") as HTMLButtonElement).disabled).toBe(
        true
      );
      cleanup();

      renderStoryModuleExport(ButtonStories.Success);
      expect(screen.getByTestId("button-story-success").textContent).toContain(
        "Contribution confirmed"
      );
    });
  });

  describe("3. Runtime behavior of FormField stories", () => {
    it("renders Default, Loading, Empty, Error, Disabled, and Success FormField states", () => {
      renderStoryModuleExport(FormFieldStories.Default);
      expect(screen.getByTestId("formfield-story-default")).toBeTruthy();
      cleanup();

      renderStoryModuleExport(FormFieldStories.Loading);
      const loadingContainer = screen.getByTestId("formfield-story-loading");
      expect(loadingContainer.getAttribute("aria-busy")).toBe("true");
      cleanup();

      renderStoryModuleExport(FormFieldStories.Empty);
      expect(screen.getByTestId("formfield-story-empty").textContent).toContain(
        "No profile details entered yet."
      );
      cleanup();

      renderStoryModuleExport(FormFieldStories.Error);
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Amount must be a positive whole number");
      cleanup();

      renderStoryModuleExport(FormFieldStories.Disabled);
      const disabledBtn = screen.getByRole("button", { name: "Update locked" }) as HTMLButtonElement;
      expect(disabledBtn.disabled).toBe(true);
      cleanup();

      renderStoryModuleExport(FormFieldStories.Success);
      expect(screen.getByRole("status").textContent).toContain(
        "Domain and nonprofit verification complete."
      );
    });
  });

  describe("4. Runtime behavior of Modal stories", () => {
    it("opens Default modal on click and renders Loading, Empty, Error, Disabled, and Success states", () => {
      renderStoryModuleExport(ModalStories.Default);
      fireEvent.click(screen.getByRole("button", { name: "Open Modal" }));
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByText("Example Modal")).toBeTruthy();
      cleanup();

      renderStoryModuleExport(ModalStories.Loading);
      expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
      expect(screen.getByRole("status").textContent).toContain("Broadcasting signed transaction");
      cleanup();

      renderStoryModuleExport(ModalStories.Empty);
      expect(screen.getByText("No evidence items queued")).toBeTruthy();
      cleanup();

      renderStoryModuleExport(ModalStories.Error);
      expect(screen.getByRole("alert").textContent).toContain("Insufficient token allowance");
      cleanup();

      renderStoryModuleExport(ModalStories.Disabled);
      const disabledTrigger = screen.getByRole("button", {
        name: /open modal \(wallet required\)/i,
      }) as HTMLButtonElement;
      expect(disabledTrigger.disabled).toBe(true);
      cleanup();

      renderStoryModuleExport(ModalStories.Success);
      expect(screen.getByRole("status").textContent).toContain("Verified on Stellar ledger");
    });
  });

  describe("5. Runtime behavior of ProductCard (FeatureCard) stories", () => {
    it("renders Default, Loading, Empty, Error, Disabled, and Success ProductCard states", () => {
      renderStoryModuleExport(ProductCardStories.Default);
      expect(screen.getByText("Awesome Product")).toBeTruthy();
      cleanup();

      renderStoryModuleExport(ProductCardStories.Loading);
      const loadingCard = screen.getByTestId("feature-card-loading");
      expect(loadingCard.getAttribute("aria-busy")).toBe("true");
      cleanup();

      renderStoryModuleExport(ProductCardStories.Empty);
      expect(screen.getByTestId("feature-card-empty").textContent).toContain(
        "No Active Campaigns"
      );
      cleanup();

      renderStoryModuleExport(ProductCardStories.Error);
      expect(screen.getByRole("alert").textContent).toContain(
        "Soroban RPC node timed out"
      );
      cleanup();

      renderStoryModuleExport(ProductCardStories.Disabled);
      expect(screen.getByTestId("feature-card-disabled").getAttribute("aria-disabled")).toBe(
        "true"
      );
      cleanup();

      renderStoryModuleExport(ProductCardStories.Success);
      expect(screen.getByRole("status").textContent).toContain("Goal Reached");
    });
  });

  describe("6. Static Storybook build & asset verification", () => {
    it("builds static Storybook bundle, copies public assets, and verifies all stories and runtime preview", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fundable-storybook-test-"));
      try {
        const result = buildStorybook({ outputDir: tempDir });
        expect(result.storyCount).toBeGreaterThanOrEqual(24);
        expect(result.verification.valid).toBe(true);

        // Verify static asset copied from public/
        expect(fs.existsSync(path.join(tempDir, "fundable_logo.svg"))).toBe(true);

        // Verify index.json has all 4 core components and their states
        const indexJson = JSON.parse(
          fs.readFileSync(path.join(tempDir, "index.json"), "utf8")
        );
        expect(indexJson.entries["components-button--loading"]).toBeDefined();
        expect(indexJson.entries["components-form-field--error"]).toBeDefined();
        expect(indexJson.entries["components-modal--empty"]).toBeDefined();
        expect(indexJson.entries["components-product-card--success"]).toBeDefined();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails verification when a required artifact or component state is missing", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fundable-storybook-fail-"));
      try {
        buildStorybook({ outputDir: tempDir });

        // Remove styles.css and assert verification throws
        fs.unlinkSync(path.join(tempDir, "styles.css"));
        expect(() => verifyStorybookBuild(tempDir)).toThrow(/missing styles\.css/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
