import { chromium as playwrightChromium } from 'playwright-core';
import type { BrowserContext, Page, Route } from 'playwright-core';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.chrome-profile');
const IDLE_MS = 5 * 60_000;

const chromium = addExtra(playwrightChromium as any);
const stealth = StealthPlugin();
// These two evasions are written against puppeteer's CDP surface and throw under playwright.
stealth.enabledEvasions.delete('user-agent-override');
stealth.enabledEvasions.delete('navigator.plugins');
chromium.use(stealth);

let context: BrowserContext | null = null;
let page: Page | null = null;
let idleTimer: NodeJS.Timeout | null = null;

// ponytail: single page behind a promise chain. A pool only pays off if we ever
// need concurrent queries, and one page is politer to the site.
let chain: Promise<unknown> = Promise.resolve();

async function open(): Promise<Page> {
  if (page && !page.isClosed()) return page;

  // Cloudflare 403s headless Chrome on this site — measured, and neither the stealth
  // plugin nor patchright got past it. Headful does pass, so we run a real window and
  // park it off-screen. Set TRENDYOL_MCP_VISIBLE=1 to watch it while debugging.
  const offscreen = process.env.TRENDYOL_MCP_VISIBLE === '1' ? [] : ['--window-position=-32000,-32000'];

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', ...offscreen],
  });
  const pg: Page = ctx.pages()[0] ?? (await ctx.newPage());

  // Images and fonts are pure weight here — we only ever read JSON out of the page.
  await pg.route('**/*', (route: Route) => {
    const t = route.request().resourceType();
    return t === 'image' || t === 'font' || t === 'media' ? route.abort() : route.continue();
  });

  context = ctx;
  page = pg;
  return pg;
}

async function close(): Promise<void> {
  const c = context;
  context = null;
  page = null;
  if (c) await c.close().catch(() => {});
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void close(), IDLE_MS);
  idleTimer.unref?.();
}

/** Runs `fn` against the shared page, serialized against every other caller. */
export function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const p = await open();
    try {
      return await fn(p);
    } finally {
      resetIdleTimer();
    }
  });
  // Keep the chain alive even when a call rejects, so one failure can't wedge the queue.
  chain = run.catch(() => {});
  return run;
}

export async function shutdown(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  await close();
}
