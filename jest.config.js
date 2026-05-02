/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  // Remap .js extension imports to TypeScript source files so ts-jest can
  // resolve imports like "../../lib/controller-manager.js" to .ts
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  globals: {
    "ts-jest": {
      // Override module/moduleResolution for tests: Jest runs in CommonJS mode
      tsconfig: {
        module: "commonjs",
        moduleResolution: "node",
        esModuleInterop: true,
      },
      // Type-checking is already enforced by `npm run build` (tsc --strict).
      // Disabling here avoids false positives from the node16 → commonjs
      // module resolution downgrade (e.g. @project-chip/matter.js/device sub-paths).
      diagnostics: false,
    },
  },
  // Give async tests plenty of room for Promise chains
  testTimeout: 10000,
};
