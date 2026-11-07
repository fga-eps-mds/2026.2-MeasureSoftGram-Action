/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/configuration
 */

export default {
  bail: false,
  clearMocks: true,
  coverageProvider: "v8",
  preset: 'ts-jest',
  setupFilesAfterEnv: ['./__tests__/jest.setup.ts'],
  testEnvironment: "node",
  testMatch: [
    "**/__tests__/**/*.test.ts?(x)",
  ],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coverageDirectory: 'coverage',
  reporters: [
    'default',
    [
      'jest-sonar',
      {
        outputDirectory: '.',
        outputName: 'coverage.xml'
      }
    ]
  ]
};
