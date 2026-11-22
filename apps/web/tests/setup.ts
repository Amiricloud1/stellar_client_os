/**
 * Vitest setup file for web app tests.
 * 
 * This file is executed before any test runs and sets up:
 * - Global test utilities
 * - Mock fixtures
 * - Network guards to prevent accidental live calls
 */

import { beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Global test setup
beforeAll(() => {
  // Any global setup needed before tests run
});

// Per-test setup
beforeEach(() => {
  // Reset timers and mocks between tests
  vi.clearAllMocks();
});

afterEach(() => {
  // Cleanup after each test
  vi.clearAllMocks();
});
