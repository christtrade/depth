import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

const PORT = 4317;

// webkit (safari). playwright builds it for ubundu/debian, mac and windows only. elsewhere
// (arch (the goat), etc) it cant start so its left out and npm run e2e:docker runs it in playwrights image
function webkitRunsHere(): boolean {
    if (process.platform !== 'linux') return true;
    try {
        return /^ID(_LIKE)?=.*\b(ubuntu|debian)\b/m.test(readFileSync('/etc/os-release', 'utf8'));
    } catch {
        return false;
    }
}

export default defineConfig({
    testDir: 'e2e',
    timeout: 120_000,
    fullyParallel: true,
    // one runner flake a run, a different test each time. a retry shows them as flaky, a real break fails both
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['github'], ['list']] : [['list']],
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
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        ...(webkitRunsHere() ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
    ],
});
