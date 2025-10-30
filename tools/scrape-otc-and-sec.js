// tools/scrape-otc-and-sec.js
import { chromium } from '@playwright/test';
import fs from 'fs/promises';
import fetch from 'node-fetch';

const SYMBOL = 'TUTH';
const OTC_URL = `https://www.otcmarkets.com/stock/${SYMBOL}/disclosure`;
const WRITE_PATH = process.env.WRITE_PATH || 'disclosures.json';

function toISO(d) {
  const dt = d ? new Date(d) : null;
  return dt && !isNaN(dt) ? dt.toISOString().slice(0, 10) : null;
}

async function getJson(url, extraHeaders = {}) {
  const ua = process.env.SEC_USER_AGENT || 'SDL Disclosures (contact: info@sdl.care)';
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, 'Accept': 'application/json', ...extraHeaders }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function resolveCikFromTicker(ticker) {
  // Smaller mapping file vs. giant dataset; contains {0:{cik_str, ticker, title}, 1:{...}, ...}
  const map = await getJson('https://www.sec.gov/files/company_tickers.json');
  const hit = Object.values(map).find(
    v => String(v.ticker).toUpperCase() === String(ticker).toUpperCase()
  );
  return hit?.cik_str ? String(hit.cik_str).padStart(10, '0') : null;
}

async function getSecRecentFilings(cik10) {
  const json = await getJson(`https://data.sec.gov/submissions/CIK${cik10}.json`);
  const recent = json?.filings?.recent;
  if (!recent) return [];

  const keepForms = new Set(['8-K', '10-Q', '10-K', '6-K', 'S-1', 'S-3', 'SC 13D', 'SC 13G', 'DEF 14A']);
  const n = Math.min(recent.form.length, 200);
  const out = [];
  for (let i = 0; i < n; i++) {
    const form = recent.form[i];
    if (!keepForms.has(form)) continue;

    const filed = recent.filingDate[i];
    const acc = recent.accessionNumber[i];
    const primary = recent.primaryDocument[i];
    const link = `https://www.sec.gov/Archives/edgar/data/${Number(cik10)}/${acc.replace(/-/g,'')}/${primary}`;

    out.push({
      source: 'SEC',
      title: `${form} filed`,
      date: filed,
      description: 'SEC EDGAR filing',
      link
    });
  }
  return out;
}

async function scrapeOtcDisclosures() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(OTC_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Give the SPA a moment to render
  await page.waitForTimeout(2500);

  const items = await page.evaluate(() => {
    const container = document.querySelector('main, #root, body');
    const anchors = container ? Array.from(container.querySelectorAll('a')) : [];
    const rows = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const text = a.textContent?.trim() || '';
      if (!href || (!href.includes('/file/') && !href.includes('/news/') && !href.includes('/filing/'))) continue;

      const parent = a.closest('tr, article, li, div') || a.parentElement;
      let dateText = '';
      if (parent) {
        const t = parent.querySelector('time');
        if (t?.dateTime) dateText = t.dateTime;
        else if (t?.textContent) dateText = t.textContent.trim();
        if (!dateText) {
          const m = parent.textContent.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i);
          if (m) dateText = m[0];
        }
      }

      rows.push({
        source: 'OTC',
        title: text,
        link: new URL(href, location.origin).toString(),
        date: dateText || null,
        description: 'OTC Disclosure & News Service'
      });
    }
    return rows;
  });

  await browser.close();

  return items
    .map(i => ({ ...i, date: toISO(i.date) }))
    .filter(i => i.title && i.link && i.date);
}

function mergeAndSort(items) {
  const key = x => `${x.title}|${x.link}|${x.date}`;
  const map = new Map();
  for (const i of items) map.set(key(i), i);
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
}

(async () => {
  // 1) SEC
  const cik = await resolveCikFromTicker(SYMBOL);
  const secItems = cik ? await getSecRecentFilings(cik) : [];

  // 2) OTC (don’t fail the whole job if OTC blocks headless)
  let otcItems = [];
  try {
    otcItems = await scrapeOtcDisclosures();
  } catch (e) {
    console.warn('OTC scrape failed, continuing with SEC only:', e.message);
  }

  const merged = mergeAndSort([...secItems, ...otcItems]);

  await fs.writeFile(WRITE_PATH, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`Wrote ${merged.length} items to ${WRITE_PATH}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
