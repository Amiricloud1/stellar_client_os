/**
 * Expo app configuration (app.config.ts).
 *
 * Uses the "dynamic config" format so environment variables and CI/CD values
 * can be injected at build time without modifying tracked files.
 *
 * Reference: https://docs.expo.dev/workflow/configuration/
 */

import type { ExpoConfig, ConfigContext } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,

  // ── Identity ───────────────────────────────────────────────────────────────
  name: "Fundable",
  slug: "fundable-stellar",
  version: process.env.APP_VERSION ?? "0.1.0",

  // ── Runtime ───────────────────────────────────────────────────────────────
  runtimeVersion: {
    // "appVersion" keeps OTA update compatibility tied to the native build.
    policy: "appVersion",
  },
  sdkVersion: "52.0.0",

  // ── Orientation / appearance ───────────────────────────────────────────────
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",

  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#0f172a",
  },

  // ── Update channel ─────────────────────────────────────────────────────────
  updates: {
    fallbackToCacheTimeout: 0,
    url: "https://u.expo.dev/fundable-stellar",
  },

  // ── Asset bundling ─────────────────────────────────────────────────────────
  assetBundlePatterns: ["**/*"],

  // ── iOS ────────────────────────────────────────────────────────────────────
  ios: {
    supportsTablet: true,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? "network.fundable.stellar",
    buildNumber: process.env.BUILD_NUMBER ?? "1",
    infoPlist: {
      NSFaceIDUsageDescription:
        "Fundable uses Face ID to protect your wallet credentials.",
    },
  },

  // ── Android ────────────────────────────────────────────────────────────────
  android: {
    package: process.env.ANDROID_PACKAGE ?? "network.fundable.stellar",
    versionCode: Number(process.env.BUILD_NUMBER ?? "1"),
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0f172a",
    },
    permissions: [
      "android.permission.INTERNET",
      "android.permission.ACCESS_NETWORK_STATE",
    ],
  },

  // ── Web ────────────────────────────────────────────────────────────────────
  web: {
    favicon: "./assets/favicon.png",
    bundler: "metro",
  },

  // ── Plugins ────────────────────────────────────────────────────────────────
  plugins: [
    // expo-secure-store is used by the encrypted offline storage layer (#87).
    "expo-secure-store",
    // expo-notifications powers campaign milestone push notifications.
    [
      "expo-notifications",
      {
        icon: "./assets/notification-icon.png",
        color: "#ffffff",
      },
    ],
  ],

  // ── Extra (available via Constants.expoConfig.extra) ──────────────────────
  extra: {
    // Stellar network configuration injected from environment variables.
    stellarNetwork: process.env.STELLAR_NETWORK ?? "testnet",
    rpcUrl:
      process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    horizonUrl:
      process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    // EAS project ID (required for OTA updates and EAS Build).
    eas: {
      projectId: process.env.EAS_PROJECT_ID ?? "",
    },
  },
});
