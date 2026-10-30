import { defineConfig, devices } from '@playwright/test';

const PORT = 4317;

export default defineConfig({
    testDir: 'e2e',
    timeout: 120_000,
    fullyParallel: true,
    reporter: [['list']],
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: { width: 1280, height: 800 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'node e2e/serve.mjs',
        port: PORT,
        reuseExistingServer: true,
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
