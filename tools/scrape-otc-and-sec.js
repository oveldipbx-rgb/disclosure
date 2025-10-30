// tools/scrape-otc-and-sec.js
import { chromium } from '@playwright/test';
import fs from 'fs/promises';
import fetch from 'node-fetch';

const SYMBOL = 'TUTH';
const OTC_URL = `https://www.otcmarkets.com/stock/${SYMBOL}/disclosure`;

// If you know the CIK, set it here to skip lookup; otherwise we resolve via SEC.
let CIK = null; // e.g., "0000123456" (10 digits, no leading 'CIK')

async function getSecCompanySubmissionsJson(cik) {
  const ua = process.env.SEC_USER_AGENT || 'SDL Disclosures (contact: info@sdl.care)';
  const url = `https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`SEC submissions HTTP ${res.status}`);
  return res.json();
}

async function resolveCikFromTicker(ticker) {
  const ua = process.env.SEC_USER_AGENT || 'SDL Disclosures (contact: info@sdl.care)';
  const res = await fetch('https://data.sec.gov/api/xbrl/companyfacts/companies.json', {
    headers: { 'User-Agent': ua, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`SEC company list HTTP ${res.status}`);
  const data = await res.json();
  // Find by ticker symbol (case-insensitive)
  const hit = data.companies?.find(c =>
    Array.isArray(c.tickers) && c.tickers.some(t => String(t).toUpperCase() === ticker.toUpperCase())
  );
  return hit?.cik_str ? String(hit.cik_str).padStart(10, '0') : null;
}

async function scrapeOtcDisclosures() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(OTC_URL, { waitUntil: 'domcontentloaded' });

  // Wait for the disclosures list/table to render; selector varies, so we look for link rows.
  // We grab anchors inside the main disclosure content area.
  await page.waitForTimeout(2000); // small settle time for SPA

  const items = await page.evaluate(() => {
    // Try a few likely containers; adaptively gather anchors with dates nearby.
    const container = document.querySelector('[data-test="disclosure"], main, #root, body');
    const anchors = container ? Array.from(container.querySelectorAll('a')) : [];

    const rows = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const text = a.textContent?.trim() || '';
      // Heuristic: OTC disclosure links often include '/file/' or '/news/' or '/filing/'
      if (!href || (!href.includes('/file/') && !href.includes('/news/') && !href.includes('/filing/'))) continue;

      // Find a nearby date string (same row/card)
      const parent = a.closest('tr, article, li, div');
      let dateText = '';
      if (parent) {
        const timeEl = parent.querySelector('time');
        if (timeEl?.dateTime) dateText = timeEl.dateTime;
        else if (timeEl?.textContent) dateText = timeEl.textContent.trim();

        // fallback: simple date regex in the parent text
        if (!dateText) {
          const m = parent.textContent.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i);
          if (m) dateText = m[0];
        }
      }

      rows.push({
        source: 'OTC',
        title: text,
        link: new URL(href, location.origin).toString(),
        date: dateText || null
      });
    }
    return rows;
  });

  await browser.close();

  // Normalize date strings → ISO YYYY-MM-DD if possible
  const parsed = items
    .map(i => {
      let d = i.date ? new Date(i.date) : null;
      if (d && isNaN(d)) d = null;
      return { ...i, date: d ? d.toISOString().slice(0, 10) : null };
    })
    .filter(i => i.title && i.link);

  return parsed;
}

function filterMapSecFilings(submissions) {
  // Pull recent filings list
  const recent = submissions?.filings?.recent;
  if (!recent) return [];

  const n = Math.min(recent.accessionNumber.length, 200);
  const out = [];
  for (let i = 0; i < n; i++) {
    const form = recent.form[i];
    // Keep common disclosure forms
    if (!['8-K', '10-Q', '10-K', '6-K', 'S-1', 'S-3', 'SC 13D', 'SC 13G', 'DEF 14A'].includes(form)) continue;

    const acc = recent.accessionNumber[i];
    const primaryDoc = recent.primaryDocument[i];
    const filed = recent.filingDate[i];
    const cik = String(submissions.cik).padStart(10, '0');
    const link = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g,'')}/${primaryDoc}`;

    out.push({
      source: 'SEC',
      title: `${form} filed`,
      link,
      date: filed
    });
  }
  return out;
}

function mergeAndSort(items) {
  // de-dupe by title+link+date
  const key = x => `${x.title}|${x.link}|${x.date}`;
  const map = new Map();
  for (const i of items) {
    if (!i.title || !i.link || !i.date) continue;
    map.set(key(i), i);
  }
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
}

(async () => {
  // 1) OTC scrape
  const otc = await scrapeOtcDisclosures();

  // 2) SEC filings
  if (!CIK) {
    CIK = await resolveCikFromTicker(SYMBOL);
  }
  let sec = [];
  if (CIK) {
    const subs = await getSecCompanySubmissionsJson(CIK);
    sec = filterMapSecFilings(subs);
  }

  // 3) Merge + write
  const merged = mergeAndSort([...otc, ...sec]).map(i => ({
    title: i.title,
    date: i.date,
    description: i.source === 'SEC' ? 'SEC EDGAR filing' : 'OTC Disclosure & News Service',
    link: i.link
  }));

  await fs.writeFile('disclosures.json', JSON.stringify(merged, null, 2), 'utf8');
  console.log(`Wrote ${merged.length} items to disclosures.json`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
