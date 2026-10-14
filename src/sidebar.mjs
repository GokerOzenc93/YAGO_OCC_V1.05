// Playwright: gerçek uygulamada kenar çubuğu kipleri — docked → floating (sürükle/boyutlandır) → ayrı pencere → geri.
import { chromium } from 'playwright';
import fs from 'node:fs';
const outDir = process.argv[2] || '/tmp/sidebar-shots';
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
page.on('pageerror', e => log('[pageerror]', String(e).slice(0, 300)));
page.on('console', m => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning') log('[page]', t.slice(0, 200)); });
await page.goto(process.env.APP_URL || 'http://localhost:5173/');
await page.waitForSelector('text=Loading OpenCascade...', { state: 'detached', timeout: 240000 });
await page.waitForTimeout(800);
const shot = async (name, p = page) => { await p.screenshot({ path: `${outDir}/${name}.png` }); log('shot', name); };

const frameBox = async () => page.evaluate(() => {
  const el = document.querySelector('[title="Drag to move the panel"]')?.parentElement?.parentElement;
  if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
});

// 1) kapalı şerit → tutamakla aç (docked, pinned)
await page.getByRole('button', { name: 'Open sidebar' }).click();
await page.waitForTimeout(500);
await shot('1-docked');

// 2) yüzen kip
await page.locator('button[title^="Undock"]').click();
await page.waitForTimeout(300);
let fb = await frameBox(); log('floating rect', fb);
await shot('2-floating');

// 3) başlıktan sürükle
const hdr = page.locator('[title="Drag to move the panel"]');
const hb = await hdr.boundingBox();
const gx = hb.x + hb.width * 0.5, gy = hb.y + hb.height / 2; // orta grip bölgesi (düğme yok)
await page.mouse.move(gx, gy); await page.mouse.down();
await page.mouse.move(gx + 120, gy + 60, { steps: 8 }); await page.mouse.move(gx + 320, gy + 60, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const fb2 = await frameBox(); log('after drag', fb2, 'dx', fb2.x - fb.x, 'dy', fb2.y - fb.y);
if (Math.round(fb2.x - fb.x) !== 320 || Math.round(fb2.y - fb.y) !== 60) { log('DRAG FAIL'); }
await shot('3-dragged');

// 4) köşeden boyutlandır
const cx = fb2.x + fb2.w - 6, cy = fb2.y + fb2.h - 6;
await page.mouse.move(cx, cy); await page.mouse.down();
await page.mouse.move(cx - 100, cy - 120, { steps: 10 }); await page.mouse.up();
await page.waitForTimeout(200);
const fb3 = await frameBox(); log('after resize', fb3, 'dw', fb3.w - fb2.w, 'dh', fb3.h - fb2.h);
if (Math.round(fb3.w - fb2.w) !== -100 || Math.round(fb3.h - fb2.h) !== -120) { log('RESIZE FAIL'); }
await shot('4-resized');

// kalıcılık: localStorage
log('layout', await page.evaluate(() => localStorage.getItem('yago.sidebar.layout')));

// 5) ayrı pencere
const [popup] = await Promise.all([ctx.waitForEvent('page'), page.locator('button[title^="Open the panel in a separate"]').click()]);
await popup.waitForLoadState('domcontentloaded').catch(() => {});
await page.waitForTimeout(800);
popup.on('pageerror', e => log('[popup pageerror]', String(e).slice(0, 300)));
log('popup tabs:', await popup.locator('text=Panel Editor').count(), 'size', await popup.evaluate(() => [innerWidth, innerHeight]));
log('popup styles:', await popup.evaluate(() => ({ links: document.head.querySelectorAll('link[rel=stylesheet]').length, styles: document.head.querySelectorAll('style').length, font: getComputedStyle(document.querySelector('button')).fontFamily.slice(0, 20) })));
log('main frame present?', await page.locator('[title="Drag to move the panel"]').count(), 'handle:', await page.locator('button[title^="Panel is open in a separate window"]').count());
await popup.setViewportSize({ width: 560, height: 760 });
await shot('5-popup', popup);
await shot('5-main-while-popup');
// sekme değişimi ayrı pencerede
await popup.locator('button', { hasText: 'Parameters' }).click(); await popup.waitForTimeout(200);
await shot('6-popup-parameters', popup);
// 6) ayrı pencereden ana pencereye dön
await popup.locator('button[title^="Return the panel"]').click();
await page.waitForTimeout(600);
log('popup closed?', popup.isClosed(), 'docked frame?', await page.locator('[title="Drag to move the panel"]').count() === 0 && await page.locator('button[title="Unpin panel"]').count() === 1);
await shot('7-docked-again');

// 7) kullanıcı pencereyi kapatınca da geri dönmeli
const [popup2] = await Promise.all([ctx.waitForEvent('page'), page.locator('button[title^="Open the panel in a separate"]').click()]);
await page.waitForTimeout(600);
await popup2.close();
await page.waitForTimeout(900);
log('after user close → pin button?', await page.locator('button[title="Unpin panel"]').count());

// 8) yüzen kipe geç, yenile → kip ve konum korunur
await page.locator('button[title^="Undock"]').click(); await page.waitForTimeout(300);
await page.reload();
await page.waitForSelector('text=Loading OpenCascade...', { state: 'detached', timeout: 240000 });
await page.waitForTimeout(600);
log('after reload floating?', await page.locator('[title="Drag to move the panel"]').count(), await frameBox());
await shot('8-reload-floating');
await browser.close();
