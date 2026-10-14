// Playwright: kenar çubuğu kabuğu + gerçek PanelEditor (edge senaryosu) — ayrı pencerede etkileşim (rozet tıklama, giriş) çalışıyor mu?
import { chromium } from 'playwright';
import fs from 'node:fs';
const outDir = process.argv[2] || '/tmp/sidebar-shots';
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
page.on('pageerror', e => log('[pageerror]', String(e).slice(0, 300)));
await page.goto('http://localhost:5173/harness-browser/index.html?scen=edge&ui=sidebar');
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 180000 });
const err = await page.evaluate(() => window.__error);
if (err) { log('ERROR', err); await browser.close(); process.exit(1); }
await page.waitForTimeout(800);
const shot = async (name, p = page) => { await p.screenshot({ path: `${outDir}/${name}.png` }); log('shot', name); };

await page.getByRole('button', { name: 'Open sidebar' }).click();
await page.waitForTimeout(600);
await shot('c1-docked');
await page.locator('button[title^="Undock"]').click();
await page.waitForTimeout(400);
await shot('c2-floating');

// ayrı pencere + içerikle etkileşim
const [popup] = await Promise.all([ctx.waitForEvent('page'), page.locator('button[title^="Open the panel in a separate"]').click()]);
popup.on('pageerror', e => log('[popup pageerror]', String(e).slice(0, 300)));
await page.waitForTimeout(1000);
await popup.setViewportSize({ width: 560, height: 900 });
await popup.waitForTimeout(400);
await shot('c3-popup', popup);
// Dikme bandındaki Groove rozetine tıkla → store'da kenar ilişkisi nail olmalı
const relBefore = await page.evaluate(() => { const y = window.__yago; const g = y.st().backGroups[0]; return JSON.stringify(g.edgeRel ?? {}); });
const chip = popup.locator('g.yago-band.pnl.on', { has: popup.locator('title', { hasText: /GROOVED edge/ }) }).first();
log('popup rel chips:', await popup.locator('g.yago-band.pnl.on', { has: popup.locator('title', { hasText: /edge —/ }) }).count());
await chip.click();
await popup.waitForTimeout(2000);
const relAfter = await page.evaluate(() => { const y = window.__yago; const g = y.st().backGroups[0]; return JSON.stringify(g.edgeRel ?? {}); });
log('edgeRel before', relBefore, 'after', relAfter, relBefore !== relAfter ? 'CLICK OK' : 'CLICK FAIL');
// Thick girişine yaz → kalınlık değişmeli
const thick = popup.locator('input.yago-field[inputmode=decimal]').first(); // ilk sayısal alan: Thick
log('thick inputs:', await thick.count());
if (await thick.count()) {
  await thick.click(); await popup.keyboard.press('Control+A'); await popup.keyboard.type('12'); await popup.keyboard.press('Enter');
  await popup.waitForTimeout(1500);
  log('thickness now', await page.evaluate(() => window.__yago.st().backGroups[0].thickness));
}
await shot('c4-popup-after', popup);
// Ana pencerede 3B içerik yok (harness) — ana sayfada yalnız tutamak kalmalı
log('main handle:', await page.locator('button[title^="Panel is open in a separate window"]').count());
await popup.locator('button[title^="Return the panel"]').click();
await page.waitForTimeout(800);
log('popup closed?', popup.isClosed(), 'docked pin?', await page.locator('button[title="Unpin panel"]').count());
await shot('c5-back-docked');
await browser.close();
