// Jest setup file
// This file runs before all tests

// Mock timers globally for tests that need them
beforeEach(() => {
  jest.clearAllMocks();
});

// Global test timeout
jest.setTimeout(10000);