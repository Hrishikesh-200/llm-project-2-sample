import { chromium } from 'playwright';

async function run() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node playfetch.js "<url>"');
    process.exit(2);
  }
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(()=>{});
    await page.waitForTimeout(500);
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    console.log('---BEGIN PAGE BODY---');
    console.log(bodyText);
    console.log('---END PAGE BODY---');
  } catch (err) {
    console.error('Error fetching page:', err.message || err);
  } finally {
    await browser.close();
  }
}

run();