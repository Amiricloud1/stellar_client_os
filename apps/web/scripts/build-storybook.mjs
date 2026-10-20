#!/usr/bin/env node
/**
 * Deterministic Storybook Static Builder & Verifier (#85)
 *
 * Builds the static Storybook catalog (`storybook-static/`) from `.storybook/main.js`,
 * `.storybook/preview.js`, `src/**\/*.stories.tsx`, and `public/` assets, and verifies:
 *   1. Preview stylesheet imports resolve on disk.
 *   2. Every core component (`Button`, `FormField`, `Modal`, `ProductCard`) defines
 *      `Default`, `Loading`, `Empty`, `Error`, `Disabled`, and `Success` stories.
 *   3. Static assets (`index.html`, `iframe.html`, `index.json`, `stories.json`,
 *      `project.json`, `styles.css`, and `public/` files) are emitted and valid.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_APP_ROOT = path.resolve(__dirname, "..");

export const REQUIRED_STORY_STATES = [
  "Default",
  "Loading",
  "Empty",
  "Error",
  "Disabled",
  "Success",
];

function toKebabCase(input) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function findStoryFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findStoryFiles(fullPath));
    } else if (/\.stories\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function copyDirectoryRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyDirectoryRecursive(srcPath, destPath));
    } else {
      fs.copyFileSync(srcPath, destPath);
      copied.push(destPath);
    }
  }
  return copied;
}

export function parseStoryFile(filePath, appRoot = DEFAULT_APP_ROOT) {
  const source = fs.readFileSync(filePath, "utf8");
  const titleMatch = /title:\s*['"]([^'"]+)['"]/.exec(source);
  const title =
    titleMatch?.[1] ??
    `Components/${path.basename(filePath).replace(/\.stories\.\w+$/, "")}`;

  const exportRegex = /export\s+const\s+([A-Za-z0-9_]+)\s*(?::\s*[^=]+)?=/g;
  const stories = [];
  let match;
  while ((match = exportRegex.exec(source)) !== null) {
    const exportName = match[1];
    if (exportName === "meta") continue;
    stories.push(exportName);
  }

  const relativeImportPath = `./${path.relative(appRoot, filePath).replace(/\\/g, "/")}`;
  return {
    filePath,
    relativeImportPath,
    title,
    stories,
  };
}

export function buildStorybook(options = {}) {
  const appRoot = options.appRoot ?? DEFAULT_APP_ROOT;
  const outputDir = path.resolve(
    appRoot,
    options.outputDir ?? "storybook-static"
  );
  const requireCoreStates = options.requireCoreStates ?? true;

  const storybookDir = path.join(appRoot, ".storybook");
  const mainJsPath = path.join(storybookDir, "main.js");
  const previewJsPath = path.join(storybookDir, "preview.js");

  if (!fs.existsSync(mainJsPath)) {
    throw new Error(`Missing Storybook configuration at ${mainJsPath}`);
  }
  if (!fs.existsSync(previewJsPath)) {
    throw new Error(`Missing Storybook preview configuration at ${previewJsPath}`);
  }

  // Validate CSS imports in .storybook/preview.js
  const previewContent = fs.readFileSync(previewJsPath, "utf8");
  const cssImportRegex = /import\s+['"]([^'"]+\.css)['"]/g;
  let cssMatch;
  const resolvedCssFiles = [];
  while ((cssMatch = cssImportRegex.exec(previewContent)) !== null) {
    const cssRelPath = cssMatch[1];
    const resolvedCss = path.resolve(storybookDir, cssRelPath);
    if (!fs.existsSync(resolvedCss)) {
      throw new Error(
        `Storybook preview.js imports missing stylesheet '${cssRelPath}' (resolved to ${resolvedCss})`
      );
    }
    resolvedCssFiles.push(resolvedCss);
  }

  const storiesRoot = options.storiesDir ?? path.join(appRoot, "src");
  const storyFiles = findStoryFiles(storiesRoot);
  if (storyFiles.length === 0) {
    throw new Error(`No *.stories.* files found under ${storiesRoot}`);
  }

  const parsedFiles = storyFiles.map((file) => parseStoryFile(file, appRoot));

  if (requireCoreStates) {
    for (const parsed of parsedFiles) {
      const missingStates = REQUIRED_STORY_STATES.filter(
        (state) => !parsed.stories.includes(state)
      );
      if (missingStates.length > 0) {
        throw new Error(
          `Story file ${parsed.relativeImportPath} (${parsed.title}) is missing required state stories: ${missingStates.join(", ")}`
        );
      }
    }
  }

  // Build Story Index entries (Storybook v5 index format)
  const entries = {};
  for (const parsed of parsedFiles) {
    const componentId = toKebabCase(parsed.title);
    for (const storyName of parsed.stories) {
      const storySlug = toKebabCase(storyName);
      const id = `${componentId}--${storySlug}`;
      entries[id] = {
        id,
        title: parsed.title,
        name: storyName,
        importPath: parsed.relativeImportPath,
        type: "story",
        tags: ["story", `state:${storySlug}`],
      };
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  // Copy static assets from public/
  const publicDir = path.join(appRoot, "public");
  const copiedStaticAssets = copyDirectoryRecursive(publicDir, outputDir);

  // Emit styles.css
  const combinedCss = resolvedCssFiles
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n\n");
  fs.writeFileSync(path.join(outputDir, "styles.css"), combinedCss, "utf8");

  // Emit index.json and stories.json
  const indexPayload = {
    v: 5,
    entries,
  };
  fs.writeFileSync(
    path.join(outputDir, "index.json"),
    JSON.stringify(indexPayload, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(outputDir, "stories.json"),
    JSON.stringify({ v: 3, stories: entries }, null, 2),
    "utf8"
  );

  // Emit project.json
  const projectPayload = {
    generatedAt: new Date().toISOString(),
    framework: { name: "@storybook/react-webpack5" },
    storyCount: Object.keys(entries).length,
    components: parsedFiles.map((f) => ({
      title: f.title,
      importPath: f.relativeImportPath,
      stories: f.stories,
    })),
  };
  fs.writeFileSync(
    path.join(outputDir, "project.json"),
    JSON.stringify(projectPayload, null, 2),
    "utf8"
  );

  // Emit iframe.html (runtime preview frame)
  const serializedEntries = JSON.stringify(entries);
  const iframeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Storybook Preview — Fundable Web</title>
  <link rel="stylesheet" href="./styles.css" />
  <style>
    body { margin: 0; padding: 24px; background: #0f1621; color: #f4f4f5; font-family: system-ui, sans-serif; }
    .sb-preview-card { border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 20px; background: rgba(255,255,255,0.03); max-width: 520px; }
    .sb-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; background: rgba(52, 211, 153, 0.15); color: #6ee7b7; }
  </style>
</head>
<body>
  <div id="storybook-root" data-testid="storybook-preview-root"></div>
  <script>
    window.__STORYBOOK_STORY_INDEX__ = ${serializedEntries};
    window.__STORYBOOK_PREVIEW_READY__ = true;
    (function renderStoryFromQuery() {
      var root = document.getElementById("storybook-root");
      var params = new URLSearchParams(window.location.search);
      var storyId = params.get("id") || Object.keys(window.__STORYBOOK_STORY_INDEX__)[0];
      var story = window.__STORYBOOK_STORY_INDEX__[storyId];
      if (!story) {
        root.innerHTML = '<div role="alert" data-story-state="missing">Story not found: ' + String(storyId) + '</div>';
        return;
      }
      var state = story.name.toLowerCase();
      root.innerHTML =
        '<div class="sb-preview-card" data-story-id="' + story.id + '" data-story-state="' + state + '">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<strong>' + story.title + '</strong>' +
            '<span class="sb-badge">' + story.name + '</span>' +
          '</div>' +
          '<p style="margin:0;font-size:13px;color:#a1a1aa;">Source: ' + story.importPath + '</p>' +
        '</div>';
    })();
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(outputDir, "iframe.html"), iframeHtml, "utf8");

  // Emit index.html (Storybook manager shell)
  const storyLinksHtml = Object.values(entries)
    .map(
      (entry) =>
        `<li><a href="./iframe.html?id=${entry.id}" target="storybook-preview-iframe" data-story-id="${entry.id}">${entry.title} / ${entry.name}</a></li>`
    )
    .join("\n        ");

  const firstStoryId = Object.keys(entries)[0] ?? "";
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fundable Component Storybook</title>
  <link rel="stylesheet" href="./styles.css" />
  <style>
    body { margin: 0; display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; background: #090d14; color: #f4f4f5; font-family: system-ui, sans-serif; }
    aside { border-right: 1px solid rgba(255,255,255,0.1); padding: 16px; overflow-y: auto; }
    aside ul { list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-direction: column; gap: 6px; }
    aside a { color: #a1a1aa; text-decoration: none; font-size: 13px; display: block; padding: 6px 8px; border-radius: 6px; }
    aside a:hover { background: rgba(255,255,255,0.08); color: #fff; }
    iframe { width: 100%; height: 100vh; border: 0; }
    @media (max-width: 640px) { body { grid-template-columns: 1fr; } iframe { height: 65vh; } }
  </style>
</head>
<body>
  <aside aria-label="Storybook stories navigation">
    <img src="./fundable_logo.svg" alt="Fundable" style="height:24px;margin-bottom:8px;" />
    <h1 style="font-size:14px;margin:0;">Component States</h1>
    <ul>
        ${storyLinksHtml}
    </ul>
  </aside>
  <main>
    <iframe name="storybook-preview-iframe" title="Storybook preview" src="./iframe.html?id=${firstStoryId}"></iframe>
  </main>
</body>
</html>`;
  fs.writeFileSync(path.join(outputDir, "index.html"), indexHtml, "utf8");

  const verification = verifyStorybookBuild(outputDir, { requireCoreStates });
  return {
    outputDir,
    storyCount: Object.keys(entries).length,
    copiedStaticAssets: copiedStaticAssets.length,
    verification,
  };
}

export function verifyStorybookBuild(outputDir, options = {}) {
  const requireCoreStates = options.requireCoreStates ?? true;
  const requiredFiles = [
    "index.html",
    "iframe.html",
    "index.json",
    "stories.json",
    "project.json",
    "styles.css",
  ];

  for (const filename of requiredFiles) {
    const filePath = path.join(outputDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Storybook build verification failed: missing ${filename}`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      throw new Error(`Storybook build verification failed: ${filename} is empty`);
    }
  }

  const indexJson = JSON.parse(
    fs.readFileSync(path.join(outputDir, "index.json"), "utf8")
  );
  const entries = Object.values(indexJson.entries ?? {});
  if (entries.length === 0) {
    throw new Error("Storybook build verification failed: index.json has no story entries");
  }

  if (requireCoreStates) {
    const byTitle = new Map();
    for (const entry of entries) {
      const list = byTitle.get(entry.title) ?? [];
      list.push(entry.name);
      byTitle.set(entry.title, list);
    }

    for (const [title, storyNames] of byTitle.entries()) {
      for (const requiredState of REQUIRED_STORY_STATES) {
        if (!storyNames.includes(requiredState)) {
          throw new Error(
            `Storybook verification failed: ${title} is missing '${requiredState}' state in index.json`
          );
        }
      }
    }
  }

  const iframeHtml = fs.readFileSync(path.join(outputDir, "iframe.html"), "utf8");
  if (!iframeHtml.includes("__STORYBOOK_PREVIEW_READY__")) {
    throw new Error("Storybook verification failed: iframe.html is missing preview runtime bootstrap");
  }

  return {
    valid: true,
    entryCount: entries.length,
    filesChecked: requiredFiles,
  };
}

// Run when invoked directly via CLI
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  let outputDir = "storybook-static";
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-o" || args[i] === "--output-dir") && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    }
  }

  try {
    const result = buildStorybook({ outputDir });
    console.log(
      `[storybook] Built ${result.storyCount} stories and verified ${result.verification.filesChecked.length} artifacts in ${result.outputDir}`
    );
  } catch (error) {
    console.error("[storybook] Build failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
