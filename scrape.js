// scrape.js
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const URL =
  "https://metrocouncil.org/About-Us/What-We-Do/DoingBusiness/Contracting-Opportunities.aspx";

async function main() {
  const browser = await puppeteer.launch({
    headless: "new",
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36"
  );

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });

  // Wait for content area. This site usually renders tables server-side.
  await page.waitForSelector("body", { timeout: 30000 });

  const results = await page.evaluate(() => {
    const absUrl = (href) => {
      try {
        return new URL(href, location.href).toString();
      } catch {
        return href || null;
      }
    };

    const normalizeSpace = (s) => (s ?? "").replace(/\s+/g, " ").trim();

    // Find a heading by exact text (case-insensitive), then find the first table after it.
    function findFirstTableAfterHeading(headingText) {
      const headings = Array.from(
        document.querySelectorAll("h1,h2,h3,h4,strong")
      );
      const h = headings.find(
        (el) =>
          normalizeSpace(el.textContent).toLowerCase() ===
          headingText.toLowerCase()
      );
      if (!h) return null;

      // Walk forward in DOM order to find a table
      let n = h;
      for (let i = 0; i < 50; i++) {
        n = n.nextElementSibling || n.parentElement?.nextElementSibling;
        if (!n) break;
        const table = n.matches?.("table") ? n : n.querySelector?.("table");
        if (table) return table;
      }
      return null;
    }

    // Extract rows from a listings table with header: Division, Number, Title/General Description, Issue Date, Due Date, Type
    function parseListingsTable(table) {
      if (!table) return [];

      const rows = Array.from(table.querySelectorAll("tbody tr"));
      if (!rows.length) return []; // empty table is valid

      return rows
        .map((tr) => {
          const tds = Array.from(tr.querySelectorAll("td"));
          if (tds.length < 3) return null;

          const division = normalizeSpace(tds[0]?.textContent);

          const numberLink = tds[1]?.querySelector("a");
          const number = normalizeSpace(
            numberLink?.textContent || tds[1]?.textContent
          );
          const file_url = numberLink?.getAttribute("href")
            ? absUrl(numberLink.getAttribute("href"))
            : null;

          const title = normalizeSpace(tds[2]?.textContent);

          // Some rows may have missing due date (seen on this page sometimes)
          const issue_date = normalizeSpace(tds[3]?.textContent);
          const due_date = normalizeSpace(tds[4]?.textContent);
          const type = normalizeSpace(tds[5]?.textContent);

          // If number cell contains extra "NEW" text, it will be normalized out by whitespace;
          // but we also guard against empty number rows.
          if (!division && !number && !title) return null;

          return {
            division: division || null,
            number: number || null,
            file_url: file_url || null,
            title: title || null,
            issue_date: issue_date || null,
            due_date: due_date || null,
            type: type || null,
            division_full: null, // filled later (optional)
            type_full: null, // filled later (optional)
          };
        })
        .filter(Boolean);
    }

    // Parse abbreviations key into maps.
    // Page shows items like: "ES - Environmental Services", "RFP - Request for Proposal", etc.
    function parseAbbreviationMaps() {
      const mapDiv = {};
      const mapType = {};

      // Find the "Abbreviations key" header
      const headers = Array.from(document.querySelectorAll("h1,h2,h3,h4"));
      const abbrHeader = headers.find(
        (h) =>
          normalizeSpace(h.textContent).toLowerCase() === "abbreviations key"
      );
      if (!abbrHeader) return { mapDiv, mapType };

      // Collect text near that section (a chunk of nearby elements)
      // We keep it simple: take text from the closest container that includes the abbreviations.
      let container = abbrHeader.parentElement;
      if (!container) container = document.body;

      const text = container.textContent || "";

      // We only want the lines that look like "CODE - Description"
      const re =
        /(^|\n)\s*([A-Za-z]+(?:\/[A-Za-z]+)?)\s*-\s*([^\n]+?)\s*(?=\n|$)/g;
      const pairs = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        const code = normalizeSpace(m[2]);
        const desc = normalizeSpace(m[3]);
        if (code && desc) pairs.push([code, desc]);
      }

      // Split into division vs type based on known headings if present;
      // fallback: classify by known type codes.
      const knownTypeCodes = new Set([
        "IFB",
        "RFP",
        "RFQ",
        "RFI",
        "PSD",
        "D/B",
      ]);
      for (const [code, desc] of pairs) {
        if (knownTypeCodes.has(code)) mapType[code] = desc;
        else mapDiv[code] = desc;
      }

      return { mapDiv, mapType };
    }

    // The three sections on the page
    const tableMain = findFirstTableAfterHeading(
      "Requests For Proposals (RFP) and Invitations For Bids (IFB)"
    );
    const tableMcub = findFirstTableAfterHeading(
      "MCUB Select small business opportunities"
    );
    const tableSmall = findFirstTableAfterHeading(
      "Small contract opportunities (under $175,000)"
    );

    const mainRows = parseListingsTable(tableMain);
    const mcubRows = parseListingsTable(tableMcub);
    const smallRows = parseListingsTable(tableSmall);

    const allRows = [...mainRows, ...mcubRows, ...smallRows];

    const { mapDiv, mapType } = parseAbbreviationMaps();

    // Fill OPTIONAL fields
    for (const r of allRows) {
      if (r.division && mapDiv[r.division])
        r.division_full = mapDiv[r.division];
      if (r.type && mapType[r.type]) r.type_full = mapType[r.type];
    }

    return {
      allRows,
      meta: {
        counts: {
          main: mainRows.length,
          mcub: mcubRows.length,
          small: smallRows.length,
          total: allRows.length,
        },
      },
    };
  });

  const outPath = path.join(process.cwd(), "../metrocouncil_rfps.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(results.allRows, undefined, 4),
    "utf-8"
  );

  console.log("Saved:", outPath);
  console.log("Counts:", results.meta.counts);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
