/* Minimal, safe widget logic (no frameworks) */
const PAGE_SIZE = 8;
let raw = [];
let filtered = [];
let page = 1;

const $ = (id) => document.getElementById(id);
const list = $("list");
const statusEl = $("status");
const q = $("q");
const sort = $("sort");
const prevBtn = $("prev");
const nextBtn = $("next");
const pageinfo = $("pageinfo");
$("year").textContent = new Date().getFullYear();

function normalize(item) {
  // Defensive parsing; never trust upstream
  const title = String(item.title ?? "").trim();
  const description = String(item.description ?? "").trim();
  const link = String(item.link ?? "").trim();
  // Accept ISO (YYYY-MM-DD) or full timestamps
  const d = new Date(item.date || item.datetime || 0);
  const okDate = !Number.isNaN(d.getTime()) ? d : new Date(0);
  return { title, description, link, date: okDate };
}

function renderPage() {
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);

  const start = (page - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);

  list.innerHTML = "";
  for (const it of slice) {
    const card = document.createElement("article");
    card.className = "card";
    const dateStr = it.date.getTime() ? it.date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }) : "—";
    card.innerHTML = `
      <h3>${escapeHtml(it.title || "Untitled disclosure")}</h3>
      <div class="meta">${dateStr}</div>
      <p>${escapeHtml(it.description || "")}</p>
      ${it.link ? `<a href="${encodeURI(it.link)}" target="_blank" rel="noopener noreferrer">View document</a>` : ""}
    `;
    list.appendChild(card);
  }

  pageinfo.textContent = `${total ? (start + 1) : 0}–${Math.min(start + PAGE_SIZE, total)} of ${total}`;
  prevBtn.disabled = page <= 1;
  nextBtn.disabled = page >= pages;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}

function applyFilters() {
  const query = q.value.trim().toLowerCase();
  const mode = sort.value;

  filtered = raw.filter((it) => {
    if (!query) return true;
    return (it.title?.toLowerCase().includes(query) || it.description?.toLowerCase().includes(query));
  });

  filtered.sort((a, b) => {
    if (mode === "date_desc") return b.date - a.date;
    if (mode === "date_asc") return a.date - b.date;
    if (mode === "title_asc") return (a.title || "").localeCompare(b.title || "");
    if (mode === "title_desc") return (b.title || "").localeCompare(a.title || "");
    return 0;
  });

  page = 1;
  renderPage();
}

function setStatus(msg) { statusEl.textContent = msg || ""; }

// Debounce input to avoid reflows
function debounce(fn, ms = 120) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function init() {
  setStatus("Loading…");
  try {
    // If you host disclosures.json elsewhere, change this URL.
    const res = await fetch("disclosures.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Accept either {items:[...]} or [...]
    const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
    raw = items.slice(0, 2000).map(normalize); // safety cap
    setStatus(raw.length ? "" : "No disclosures yet.");
    applyFilters();
  } catch (err) {
    console.error(err);
    setStatus("Could not load disclosures. Showing placeholder.");
    raw = [{
      title: "Placeholder until first run",
      description: "This file will be replaced automatically by your publishing workflow.",
      date: new Date("2025-01-01"),
      link: "#"
    }];
    applyFilters();
  }
}

q.addEventListener("input", debounce(applyFilters, 150));
sort.addEventListener("change", applyFilters);
prevBtn.addEventListener("click", () => { page--; renderPage(); });
nextBtn.addEventListener("click", () => { page++; renderPage(); });

init();
