import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./evals/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: { baseURL: "http://127.0.0.1:3011", trace: "retain-on-failure" },
  webServer: {
    command: "node --import tsx evals/browser-server.ts",
    url: "http://127.0.0.1:3011/health",
    reuseExistingServer: false,
  },
});
