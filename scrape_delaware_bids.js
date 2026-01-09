/**
 * Delaware MMP Bids scraper (pagination + details + files)
 * URL: https://mmp.delaware.gov/Bids
 *
 * Output: de_bids.json (pretty printed)
 *
 * Notes:
 * - Tries to scrape the "directory" table by matching header names.
 * - Pagination clicks the "next arrow" via multiple strategies.
 * - Detail pages: pulls email via mailto + regex fallback; files via anchors in "Attachment/Amendment/Document" areas.
 * - OPTIONAL: agency_full is joined from the "Agency Info" page.
 */

const fs = require("fs");
const puppeteer = require("puppeteer");

const START_URL = "https://mmp.delaware.gov/Bids";
const OUT_FILE = "de_bids.json";

// Demo-friendly settings
const HEADLESS = false; // show during interview
const SLOWMO_MS = 0; // set 50 for visible pacing
const NAV_TIMEOUT_MS = 60000;

const MAX_PAGES = 300; // safety
const MAX_ITEMS = 5000; // safety
const DETAILS_CONCURRENCY = 4; // keep it polite / stable

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function clickExpandDirectory(page) {
  // Click the "Bid Solicitation Directory – Click Here to Expand for More Information"
  // The expand UI might be an accordion or toggler.
  const candidates = [
    `xpath=//*[contains(normalize-space(.), "Bid Solicitation Directory") and (self::button or self::a or self::h2 or self::h3 or self::div)]`,
    `xpath=//*[contains(normalize-space(.), "Click Here to Expand")]`,
  ];

  for (const sel of candidates) {
    try {
      if (sel.startsWith("xpath=")) {
        const xp = sel.replace("xpath=", "");
        const handles = await page.$x(xp);
        if (handles.length) {
          await handles[0].click();
          await sleep(600);
          return;
        }
      }
    } catch {}
  }
  // If it’s already expanded, no-op.
}

async function buildAgencyMap(browser) {
  // OPTIONAL: join agency_code -> agency_full using the "Agency Info" link on the page.
  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  // Find "Agency Info" link
  const agencyInfoHref = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("a")).find((x) =>
      (x.textContent || "").toLowerCase().includes("agency info")
    );
    return a ? a.href : null;
  });

  if (!agencyInfoHref) {
    await page.close();
    return new Map();
  }

  await page.goto(agencyInfoHref, { waitUntil: "domcontentloaded" });
  await page
    .waitForNetworkIdle({ idleTime: 1200, timeout: 5000 })
    .catch(() => {});
  // Scrape possible table: code + agency name
  const rows = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));

    const best =
      tables.find((t) => {
        const ths = Array.from(t.querySelectorAll("th")).map((th) =>
          (th.innerText || "").toLowerCase()
        );
        return (
          ths.some((h) => h.includes("code")) &&
          ths.some((h) => h.includes("agency"))
        );
      }) || tables[0];

    if (!best) return [];

    const trs = Array.from(best.querySelectorAll("tbody tr"));
    return trs
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td")).map((td) =>
          (td.innerText || "").trim()
        );
        return { code: tds[0] || "", name: tds[1] || "" };
      })
      .filter((r) => r.code && r.name);
  });

  await page.close();

  const map = new Map();
  for (const r of rows) map.set(normalize(r.code), normalize(r.name));
  return map;
}

async function waitForAnyRows(page) {
  // Try a few common row patterns. We don't assume a specific table lib.
  const selectors = [
    "table tbody tr",
    "[role='table'] [role='row']",
    ".rt-tbody .rt-tr", // ReactTable
    ".dataTable tbody tr",
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      return;
    } catch {}
  }

  // Last resort: just wait a bit for JS to render
  await sleep(1500);
}

async function waitForRenderedRows(page) {
  // jqGrid rows are tr.jqgrow
  await page.waitForSelector("#jqGridBids tr.jqgrow", { timeout: 45000 });

  // Wait until first row has meaningful text
  await page.waitForFunction(
    () => {
      const r = document.querySelector("#jqGridBids tr.jqgrow");
      return r && (r.innerText || "").replace(/\s+/g, " ").trim().length > 10;
    },
    { timeout: 45000 }
  );
}

async function scrapePageRows(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const lower = (s) => norm(s).toLowerCase();

    // jqGrid header row (th)
    const ths = Array.from(
      document.querySelectorAll("#gbox_jqGridBids .ui-jqgrid-htable th")
    ).map((th) => lower(th.innerText));

    // Map required fields by header text
    const findCol = (aliases) =>
      ths.findIndex((h) => aliases.some((a) => h.includes(a)));

    const colIdx = {
      contract_number: findCol([
        "contract",
        "solicitation",
        "bid",
        "#",
        "number",
      ]),
      contract_title: findCol(["title", "description"]),
      open_date: findCol(["open", "posted", "issue", "start"]),
      deadline_date: findCol(["deadline", "close", "closing", "due"]),
      agency_code: findCol(["agency", "dept", "department"]),
      unspc: findCol(["unspsc", "unspc", "commodity", "category"]),
    };

    // jqGrid data rows
    const rows = Array.from(document.querySelectorAll("#jqGridBids tr.jqgrow"));

    return rows
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td")).map((td) =>
          norm(td.innerText)
        );

        const get = (k) => (colIdx[k] >= 0 ? tds[colIdx[k]] || "" : "");

        const id = tr.getAttribute("id") || "";

        // jqGrid often opens details in a modal, so no row anchors.
        // We'll fill bookmarkable_link_url later from the modal (if available).
        return {
          id,
          contract_number: get("contract_number"),
          contract_title: get("contract_title"),
          open_date: get("open_date"),
          deadline_date: get("deadline_date"),
          agency_code: get("agency_code"),
          unspc: get("unspc"),
          contact_email: "",
          files: [],
          bookmarkable_link_url: id ? `/Bids/GetBidDetail?id=${id}` : "",
          agency_full: "",
        };
      })
      .filter((r) => r.contract_number || r.contract_title);
  });
}

async function findAndClickNext(page) {
  const nextSel = "td#next_jqg1";
  // jqGrid pager “next” is usually #next_<pagerId>
  // Many jqGrid setups create a pager with id like jqGridBidsPager or pager.
  const nextSelectors = [
    "#next_jqGridBidsPager",
    "#next_pager",
    "td#next_jqGridBidsPager",
    "td#next_pager",
    ".ui-pg-button#next_jqGridBidsPager",
    ".ui-pg-button#next_pager",
  ];

  // capture first row text to detect page change

  const disabled = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return !el || el.classList.contains("disabled");
  }, nextSel);

  if (disabled) return false;

  await page.click(nextSel);

  const before = await page.evaluate(() => {
    const r = document.querySelector("#jqGridBids tr.jqgrow");
    return r ? (r.innerText || "").trim() : "";
  });

  await page.waitForFunction(
    (prev) => {
      const r = document.querySelector("#jqGridBids tr.jqgrow");
      const nowId = r ? r.getAttribute("id") || "" : "";
      const nowText = r ? (r.innerText || "").trim() : "";
      const pgInput =
        document.querySelector("input.ui-pg-input") ||
        document.querySelector("input[id^='pg_']");
      const nowPage = pgInput ? (pgInput.value || "").trim() : "";
      return (
        (nowId && nowId !== prev.firstRowId) ||
        (nowText && nowText !== prev.firstRowText) ||
        (nowPage && nowPage !== prev.pageNum)
      );
    },
    { timeout: 30000 },
    before
  );

  return true;
}

async function scrapeDetailsViaApi(page, baseRecord) {
  if (!baseRecord.id) return baseRecord;

  try {
    const detail = await page.evaluate(async (id) => {
      const abs = (href) => {
        try {
          return new URL(href, location.href).toString();
        } catch {
          return href || "";
        }
      };

      const getText = async (url) => {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
        return await res.text();
      };

      // 1) Modal HTML
      const detailHtml = await getText(
        `/Bids/GetBidDetail?id=${encodeURIComponent(id)}`
      );

      const parseHtml = (html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");

        // email (mailto first, then regex)
        let email = "";
        const mail = doc.querySelector("a[href^='mailto:']");
        if (mail) {
          email = (mail.getAttribute("href") || "")
            .replace(/^mailto:/i, "")
            .split("?")[0]
            .trim();
        } else {
          const text = (doc.body ? doc.body.innerText : "") || "";
          const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
          email = m ? m[0] : "";
        }

        // file links present directly in the modal HTML
        const links = Array.from(doc.querySelectorAll("a[href]"))
          .map((a) => ({
            title:
              (a.textContent || "").trim() ||
              (a.getAttribute("aria-label") || "").trim() ||
              "File",
            url: abs(a.getAttribute("href") || ""),
          }))
          .filter(
            (x) =>
              x.url &&
              (/\.(pdf|doc|docx|xls|xlsx|zip|csv|txt)$/i.test(x.url) ||
                x.url.toLowerCase().includes("download") ||
                x.url.toLowerCase().includes("document") ||
                x.url.toLowerCase().includes("attachment") ||
                x.url.toLowerCase().includes("amend"))
          );

        // bidIdHidden may exist in modal; use it for doc list
        const bidIdHidden = doc.querySelector("#bidIdHidden");
        const bidId = bidIdHidden ? (bidIdHidden.value || "").trim() : id;

        return { email, links, bidId };
      };

      const parsed = parseHtml(detailHtml);

      // 2) Document list HTML (often where attachments actually are)
      const docsHtml = await getText(
        `/Bids/GetBidDocumentList?id=${encodeURIComponent(
          parsed.bidId
        )}&currentCount=0`
      );
      const docsParsed = parseHtml(docsHtml);

      // merge + dedupe
      const seen = new Set();
      const files = [];
      for (const item of [...parsed.links, ...docsParsed.links]) {
        const key = `${item.title}@@${item.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ title: item.title, Url: item.url });
      }

      return { contact_email: parsed.email || "", files };
    }, baseRecord.id);

    return { ...baseRecord, ...detail };
  } catch (e) {
    return { ...baseRecord, _detail_error: String(e?.message || e) };
  }
}

async function run() {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    slowMo: SLOWMO_MS,
    defaultViewport: { width: 1400, height: 900 },
  });

  const agencyMap = await buildAgencyMap(browser); // OPTIONAL join

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  //   await clickExpandDirectory(page);
  await waitForRenderedRows(page);
  await waitForAnyRows(page);

  let all = [];
  const seenLinks = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    await waitForAnyRows(page);

    await waitForRenderedRows(page);
    let rows = await scrapePageRows(page);

    // Normalize & dedupe within page
    rows = rows.map((r) => ({
      ...r,
      contract_number: normalize(r.contract_number),
      contract_title: normalize(r.contract_title),
      open_date: normalize(r.open_date),
      deadline_date: normalize(r.deadline_date),
      agency_code: normalize(r.agency_code),
      unspc: normalize(r.unspc),
      bookmarkable_link_url: normalize(r.bookmarkable_link_url),
    }));

    // Add only new rows by link (or contract_number if no link)
    for (const r of rows) {
      const key =
        r.bookmarkable_link_url || r.contract_number || JSON.stringify(r);
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);

      // Join agency_full if possible
      const agency_full = agencyMap.get(r.agency_code) || "";
      all.push({ ...r, agency_full });
    }

    if (all.length >= MAX_ITEMS) break;

    const clicked = await findAndClickNext(page);

    if (!clicked) break;
  }

  // Final dedupe by bookmarkable link, then contract_number
  all = uniqBy(all, (r) => r.bookmarkable_link_url || r.contract_number);

  // Scrape details with limited concurrency
  const out = [];
  let idx = 0;

  async function worker() {
    while (idx < all.length) {
      const i = idx++;
      const base = all[i];
      const detailed = await scrapeDetailsViaApi(page, base);
      out[i] = detailed;
    }
  }

  const workers = Array.from({ length: DETAILS_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 4), "utf-8");
  console.log(`Saved ${out.length} records to ${OUT_FILE}`);

  await browser.close();
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
