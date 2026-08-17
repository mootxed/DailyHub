import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["main.js", "node_modules/**", "coverage/**", "dist/**", "build/**"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 30,
        statements: 30,
        functions: 80,
        branches: 80,
        "src/dashboard.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 85
        },
        "src/progress.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 80
        },
        "src/activity-cache.ts": {
          lines: 85,
          statements: 85,
          functions: 90,
          branches: 85
        },
        "src/weekly-progress.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100
        },
        "src/range-progress.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100
        },
        "src/analytics.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 85
        },
        "src/schedule.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 90
        },
        "src/range-loader.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 80
        },
        "src/long-term-state.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 85
        },
        "src/{activity-watch-buckets,data,date,matcher,models}.ts": {
          lines: 75,
          statements: 75,
          functions: 70,
          branches: 65
        }
      }
    }
  }
});
