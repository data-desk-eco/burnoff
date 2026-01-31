import { chromium } from 'playwright';

const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome'
});
const page = await browser.newPage();

page.on('console', msg => {
    if (msg.type() === 'error') console.error('BROWSER:', msg.text());
});

page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

console.log('Loading test page...');
await page.goto('http://localhost:8001/test/p2p-test.html', { waitUntil: 'domcontentloaded' });

// Wait for tests to complete (window.__testResults is set)
const results = await page.waitForFunction(() => window.__testResults, { timeout: 30000 });
const data = await results.jsonValue();

// Print the test log
const logText = await page.$eval('#log', el => el.textContent);
console.log(logText);

await browser.close();

if (data.passed < data.total) {
    console.error(`\nFAILED: ${data.passed}/${data.total} tests passed`);
    process.exit(1);
} else {
    console.log(`\nAll ${data.total} tests passed.`);
    process.exit(0);
}
