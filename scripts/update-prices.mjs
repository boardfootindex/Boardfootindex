import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || "";
const ENABLE_JS_RENDER_FALLBACK = process.env.ENABLE_JS_RENDER_FALLBACK === "true";

// Recurring site/promo/shipping decoys seen across retailer HTML/JSON-LD
const BLOCKED_DECOY_PRICES = new Set([5, 99, 299]);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const report = {
  updated: [],
  outliers: [],
  unparsed: [],
  urlAudits: [],
  failed: [],
};

function isGenericOrCategoryUrl(url = "") {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (!path || path === "/") return true;
    if (/^\/(b|c|s|browse|category|categories|search)\b/.test(path)) return true;
    return false;
  } catch {
    return true;
  }
}

function extractTitle(html = "") {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function extractJsonLdPrices(html = "") {
  const prices = [];
  const scriptMatches = [
    ...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ];

  for (const match of scriptMatches) {
    try {
      const data = JSON.parse(match[1].trim());
      const stack = [data];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || typeof current !== "object") continue;
        if (Array.isArray(current)) {
          stack.push(...current);
          continue;
        }
        if (current.offers) {
          stack.push(current.offers);
        }
        for (const key of ["price", "lowPrice", "highPrice"]) {
          if (current[key] !== undefined && current[key] !== null) {
            const num = Number.parseFloat(String(current[key]).replace(/[^0-9.]/g, ""));
            if (Number.isFinite(num) && num >= 1 && num <= 2000 && !BLOCKED_DECOY_PRICES.has(num)) {
              prices.push(num);
            }
          }
        }
        for (const val of Object.values(current)) {
          if (val && typeof val === "object") stack.push(val);
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }

  return prices;
}

function extractHtmlTextPrices(html = "") {
  const cleanedHtml = html
    .replace(/<(del|s|strike)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");

  const text = cleanedHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const badContextRegex =
    /\b(per\s*(sq\.?\s*ft|sqft|lf|linear\s*ft|ft|bf|board\s*ft)|\/\s*(ft|sqft|lf|bf)|sample|swatch|save\s*\$)\b/i;

  const matches = [...text.matchAll(/\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{1,2})?)/g)];
  const candidates = [];

  for (const match of matches) {
    const val = Number.parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(val) || val < 1 || val > 2000 || BLOCKED_DECOY_PRICES.has(val)) {
      continue;
    }

    const start = Math.max(0, (match.index ?? 0) - 40);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 40);
    const snippet = text.slice(start, end);

    if (!badContextRegex.test(snippet)) {
      candidates.push(val);
    }
  }

  return candidates;
}

function selectBestPrice(candidates, currentPrice) {
  if (!candidates || candidates.length === 0) {
    return { status: "unparsed", price: null };
  }

  const numericCurrent = Number(currentPrice);
  if (Number.isFinite(numericCurrent) && numericCurrent > 0) {
    const withinRange = candidates.filter(
      (p) => p >= numericCurrent * 0.65 && p <= numericCurrent * 1.5
    );
    if (withinRange.length > 0) {
      return { status: "ok", price: withinRange[0] };
    }
    return {
      status: "outlier",
      price: null,
      candidate: candidates[0],
    };
  }

  return { status: "ok", price: candidates[0] };
}

function extractPriceFromHtml(html, currentPrice) {
  const jsonLdCandidates = extractJsonLdPrices(html);
  if (jsonLdCandidates.length > 0) {
    const jsonPick = selectBestPrice(jsonLdCandidates, currentPrice);
    if (jsonPick.status === "ok" || jsonPick.status === "outlier") {
      return jsonPick;
    }
  }

  const textCandidates = extractHtmlTextPrices(html);
  return selectBestPrice(textCandidates, currentPrice);
}

async function fetchPageHtml(targetUrl, renderJs = false) {
  const fetchUrl = SCRAPER_API_KEY
    ? `https://api.scraperapi.com?api_key=${encodeURIComponent(SCRAPER_API_KEY)}&url=${encodeURIComponent(targetUrl)}${renderJs ? "&render=true" : ""}`
    : targetUrl;

  const response = await fetch(fetchUrl, {
    headers: SCRAPER_API_KEY
      ? {}
      : {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

function auditPageTitle(row, title) {
  if (!title) return;
  const lowerTitle = title.toLowerCase();
  if (
    lowerTitle.includes("page not found") ||
    lowerTitle.includes("404") ||
    lowerTitle.includes("access denied") ||
    lowerTitle.includes("robot")
  ) {
    report.urlAudits.push({
      id: row.id,
      state: row.state,
      material: row.material_name,
      reason: `Suspicious page title: "${title}"`,
    });
  }
}

async function processRow(row) {
  const label = `"${row.material_name}" (${row.state || "US"})`;

  if (!row.source_url) {
    report.urlAudits.push({
      id: row.id,
      state: row.state,
      material: row.material_name,
      reason: "Missing source_url",
    });
    console.log(`~ Skipping missing URL for ${label}`);
    return;
  }

  if (isGenericOrCategoryUrl(row.source_url)) {
    report.urlAudits.push({
      id: row.id,
      state: row.state,
      material: row.material_name,
      reason: `Generic/category URL: ${row.source_url}`,
    });
    console.log(`~ Skipping generic/category URL for ${label}`);
    return;
  }

  try {
    let html = await fetchPageHtml(row.source_url, false);
    let parsed = extractPriceFromHtml(html, row.unit_price);

    if (parsed.status === "unparsed" && SCRAPER_API_KEY && ENABLE_JS_RENDER_FALLBACK) {
      html = await fetchPageHtml(row.source_url, true);
      parsed = extractPriceFromHtml(html, row.unit_price);
    }

    const title = extractTitle(html);
    auditPageTitle(row, title);

    if (parsed.status === "ok" && typeof parsed.price === "number") {
      const oldPrice = row.unit_price;
      const newPrice = Number(parsed.price.toFixed(2));

      const { error: updateError } = await supabase
        .from("lumber_prices")
        .update({ unit_price: newPrice })
        .eq("id", row.id);

      if (updateError) {
        throw new Error(`Supabase update error: ${updateError.message}`);
      }

      report.updated.push({
        id: row.id,
        state: row.state,
        material: row.material_name,
        oldPrice,
        newPrice,
      });
      console.log(`✓ Updated ${label}: $${oldPrice ?? "N/A"} -> $${newPrice}`);
    } else if (parsed.status === "outlier") {
      report.outliers.push({
        id: row.id,
        state: row.state,
        material: row.material_name,
        currentPrice: row.unit_price,
        candidatePrice: parsed.candidate,
      });
      console.log(
        `⚠ Outlier rejected for ${label}: candidate $${parsed.candidate} vs current $${row.unit_price} (keeping $${row.unit_price})`
      );
    } else {
      report.unparsed.push({
        id: row.id,
        state: row.state,
        material: row.material_name,
        currentPrice: row.unit_price,
        title: title || "No title",
      });
      console.log(
        `⚠ Could not parse price for ${label} — keeping $${row.unit_price ?? "N/A"}`
      );
    }
  } catch (err) {
    report.failed.push({
      id: row.id,
      state: row.state,
      material: row.material_name,
      error: err.message,
    });
    console.log(`✕ Failed for ${label}: ${err.message}`);
  }
}

function writeStepSummary() {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const lines = [
    "## Boardfootindex Price Bot Report",
    "",
    `| Status | Count |`,
    `| --- | ---: |`,
    `| Updated | ${report.updated.length} |`,
    `| Outliers Rejected (Kept Current) | ${report.outliers.length} |`,
    `| Unparsed (Kept Current) | ${report.unparsed.length} |`,
    `| URL / Title Audits Needed | ${report.urlAudits.length} |`,
    `| Fetch / DB Errors | ${report.failed.length} |`,
    "",
  ];

  if (report.outliers.length > 0) {
    lines.push("### Outlier Prices Rejected", "");
    for (const item of report.outliers) {
      lines.push(
        `- **${item.material}** (${item.state || "US"}): kept **$${item.currentPrice}**, ignored candidate **$${item.candidatePrice}**`
      );
    }
    lines.push("");
  }

  if (report.urlAudits.length > 0) {
    lines.push("### URL & Page Audits", "");
    for (const item of report.urlAudits) {
      lines.push(`- **${item.material}** (${item.state || "US"}): ${item.reason} (\`${item.id}\`)`);
    }
    lines.push("");
  }

  if (report.unparsed.length > 0) {
    lines.push("### Unparsed Rows", "");
    for (const item of report.unparsed) {
      lines.push(
        `- **${item.material}** (${item.state || "US"}): kept **$${item.currentPrice ?? "N/A"}** — *${item.title}*`
      );
    }
    lines.push("");
  }

  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}

async function main() {
  console.log("Fetching lumber catalog from Supabase...");
  const { data: rows, error } = await supabase
    .from("lumber_prices")
    .select("id, state, material_name, dimensions, unit_price, source_url")
    .order("state", { ascending: true })
    .order("material_name", { ascending: true });

  if (error) {
    console.error("Failed to fetch lumber_prices:", error.message);
    process.exit(1);
  }

  const catalog = (rows || []).filter((r) => Boolean(r.source_url));
  console.log(`Found ${catalog.length} rows with source URLs.`);

  for (const row of catalog) {
    await processRow(row);
  }

  writeStepSummary();

  const skippedOrIssues =
    report.outliers.length +
    report.unparsed.length +
    report.urlAudits.length +
    report.failed.length;

  console.log(
    `Done. Updated: ${report.updated.length}, Outliers: ${report.outliers.length}, Unparsed: ${report.unparsed.length}, Audits: ${report.urlAudits.length}, Failed: ${report.failed.length} (Total non-updated: ${skippedOrIssues})`
  );
}

main();
