import { chromium } from 'playwright-core';
import path from 'node:path';

const [baseUrl, outputDirectory] = process.argv.slice(2);
if (!baseUrl || !outputDirectory) {
  throw new Error('Usage: node scripts/capture-walkthrough.mjs <base-url> <output-directory>');
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-proxy-server', '--hide-scrollbars', '--disable-background-networking'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const captures = [
    { url: '/', target: '#top', stage: null },
    ...Array.from({ length: 6 }, (_, stage) => ({ url: `/?capture=${stage}`, target: '#demo', stage })),
    { url: '/?capture=5', target: '#walkthrough', stage: 5 },
  ];

  for (const [index, capture] of captures.entries()) {
    await page.goto(new URL(capture.url, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.locator('main#top').waitFor({ state: 'visible' });
    if (capture.stage !== null) {
      await page.waitForFunction((stage) => document.querySelector('main#top')?.getAttribute('data-capture-stage') === String(stage), capture.stage);
    }
    await page.evaluate(async (selector) => {
      await document.fonts.ready;
      document.querySelector(selector)?.scrollIntoView({ block: 'start' });
    }, capture.target);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(outputDirectory, `frame-${index}.png`) });
  }
} finally {
  await browser.close();
}
