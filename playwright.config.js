const { defineConfig } = require("@playwright/test");

const baseURL = process.env.FOUNDRY_BASE_URL || "http://127.0.0.1:30000";
const headless = (process.env.PLAYWRIGHT_HEADLESS || "false").toLowerCase() === "true";

module.exports = defineConfig({
    testDir: "./tests",
    fullyParallel: false,
    retries: 0,
    workers: 1,
    timeout: 120000,
    expect: {
        timeout: 10000
    },
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL,
        headless,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "retain-on-failure"
    }
});
