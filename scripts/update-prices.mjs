import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const ENABLE_JS_RENDER_FALLBACK = process.env.ENABLE_JS_RENDER_FALLBACK === "true";
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_DELAY_MS = 1200;
const CONCURRENCY = 1;
const MAX_RETRIES = 2;

const BLOCKED_DECOY_PRICES = new Set([5, 45, 99, 299]);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const report = {
  updated: [],
  outOfStock: [],
  outliers: [],
  unparsed: [],
  urlAudits: [],
  failed: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGenericOrCategoryUrl(url = "") {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (!path || path === "/") return true;
    if (/^\/(b|c|s|pl|browse|category|categories|search)\b/.test(path)) return true;
    return false;
  } catch {
    return true;
  }
}

function extractTitle(html = "") {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function isValidPriceCandidate(num) {
  return Number.isFinite(num) && num >= 1 && num <= 2000 && !BLOCKED_DECOY_PRICES.has(num);
}

function detectOutOfStock(html = "") {
  if (
    /https?:\/\/schema\.org\/OutOfStock/i.test(html) ||
    /"availability"\s*:\s*"[^"]*OutOfStock/i.test(html) ||
    /"inventoryStatus"\s*:\s*"OUT_OF_STOCK"/i.test(html)
  ) {
    return "Out of Stock (structured data)";
  }

  const visibleText = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const oosPatterns = [
    /\bout of stock\b/i,
    /\bthis item is currently unavailable\b/i,
    /\bcurrently unavailable\b/i,
    /\btemporarily unavailable\b/i,
    /\bunavailable nearby\b/i,
    /\bsold out\b/i,
    /\bnot available in (your )?store\b/i,
  ];

  for (const pattern of oosPatterns) {
    if (pattern.test(visibleText)) {
      return "Out of Stock — item currently unavailable";
    }
  }

  return null;
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
            if (isValidPriceCandidate(num)) {
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

function extractEmbeddedScriptPrices(html = "") {
  const prices = [];
  const scriptMatches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

  const priceKeyRegex =
    /"(?:price|salePrice|sellingPrice|unitPrice|finalPrice|regularPrice|offerPrice|value)"\s*:\s*"?\$?\s*(\d{1,4}(?:\.\d{1,2})?)"?/gi;

  for (const scriptMatch of scriptMatches) {
    const content = scriptMatch[1];
    if (!content || content.length < 20) continue;

    for (const match of content.matchAll(priceKeyRegex)) {
      const num = Number.parseFloat(match[1]);
      if (isValidPriceCandidate(num)) {
        prices.push(num);
      }
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
    if (!isValidPriceCandidate(val)) {
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
    if (jsonPick.status === "ok") return jsonPick;
  }

  const scriptCandidates = extractEmbeddedScriptPrices(html);
  if (scriptCandidates.length > 0) {
    const scriptPick = selectBestPrice(scriptCandidates, currentPrice);
    if (scriptPick.status === "ok") return scriptPick;
  }

  const textCandidates = extractHtmlTextPrices(html);
  const textPick = selectBestPrice(textCandidates, currentPrice);
  if (textPick.status === "ok") return textPick;

  const firstOutlier =
    jsonLdCandidates[0] ?? scriptCandidates[0] ?? textCandidates[0] ?? null;

  if (firstOutlier !== null) {
    return {
      status: "outlier",
      price: null,
      candidate: firstOutlier,
    };
  }

  return { status: "unparsed", price: null };
}

function isRetryableError(err) {
  const msg = String(err?.message || "");
  return (
    err?.name === "TimeoutError" ||
    msg.includes("HTTP 429") ||
    msg.includes("HTTP 500") ||
    msg.includes("HTTP 502") ||
    msg.includes("HTTP 503") ||
    msg.includes("HTTP 504")
  );
}

async function fetchPageHtml(targetUrl, renderJs = false) {
  const fetchUrl = SCRAPER_API_KEY
    ? `https://api.scraperapi.com?api_key=${encodeURIComponent(SCRAPER_API_KEY)}&url=${encodeURIComponent(targetUrl)}${renderJs ? "&render=true" : ""}`
    : targetUrl;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const backoffMs = 2000 * (attempt + 1);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
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

async function evaluateUrlCandidate(url, currentPrice, label, role, row) {
  if (!url) {
    return { status: "missing", reason: "Missing URL" };
  }

  if (isGenericOrCategoryUrl(url)) {
    report.urlAudits.push({
      id: row.id,
      state: row.state,
      material: `${row.material_name} (${role})`,
      reason: `Generic/category URL: ${url}`,
    });
    return { status: "invalid", reason: "Generic/category URL" };
  }

  let html = await fetchPageHtml(url, false);
  let oosReason = detectOutOfStock(html);
  let parsed = oosReason ? { status: "out_of_stock", price: null } : extractPriceFromHtml(html, currentPrice);

  if (!oosReason && parsed.status === "unparsed" && SCRAPER_API_KEY && ENABLE_JS_RENDER_FALLBACK) {
    html = await fetchPageHtml(url, true);
    oosReason = detectOutOfStock(html);
    parsed = oosReason ? { status: "out_of_stock", price: null } : extractPriceFromHtml(html, currentPrice);
  }

  const title = extractTitle(html);
  auditPageTitle(row, title);

  if (oosReason) {
    console.log(`📦 Out of stock on ${role} URL for ${label}: ${oosReason}`);
    return { status: "out_of_stock", reason: oosReason, title };
  }

  if (parsed.status === "ok" && typeof parsed.price === "number") {
    return { status: "ok", price: parsed.price, title };
  }

  if (parsed.status === "outlier") {
    return { status: "outlier", candidate: parsed.candidate, title };
  }

  return { status: "unparsed", title };
}

async function processRow(row) {
  const label = `"${row.material_name}" (${row.state || "US"})`;

  try {
    const primary = await evaluateUrlCandidate(row.source_url, row.unit_price, label, "primary", row);

    let chosenPrice = null;
    let usedBackup = false;
    let stockStatus = "in_stock";
    let stockNote = null;

    if (primary.status === "ok") {
      chosenPrice = primary.price;
      stockStatus = "in_stock";
      stockNote = null;
    } else {
      if (primary.status === "out_of_stock") {
        stockStatus = "out_of_stock";
        stockNote = row.backup_url
          ? "Primary store out of stock — showing backup option"
          : "Primary store out of stock";

        report.outOfStock.push({
          id: row.id,
          state: row.state,
          material: row.material_name,
          urlType: "primary",
          reason: primary.reason,
          usedBackup: false,
        });
      }

      if (row.backup_url) {
        await sleep(REQUEST_DELAY_MS);
        const backup = await evaluateUrlCandidate(row.backup_url, row.unit_price, label, "backup", row);

        if (backup.status === "ok") {
          chosenPrice = backup.price;
          usedBackup = true;
          if (primary.status === "out_of_stock") {
            stockStatus = "out_of_stock";
            stockNote = "Primary store out of stock — priced from backup store";
            const existingOos = report.outOfStock.find(
              (x) => x.id === row.id && x.urlType === "primary"
            );
            if (existingOos) existingOos.usedBackup = true;
          }
        } else if (backup.status === "out_of_stock") {
          if (primary.status === "out_of_stock") {
            stockStatus = "out_of_stock";
            stockNote = "Out of stock at both primary and backup stores";
          }
          report.outOfStock.push({
            id: row.id,
            state: row.state,
            material: row.material_name,
            urlType: "backup",
            reason: backup.reason,
            usedBackup: false,
          });
        }
      }
    }

    if (typeof chosenPrice === "number") {
      const oldPrice = row.unit_price;
      const newPrice = Number(chosenPrice.toFixed(2));

      const { error: updateError } = await supabase
        .from("lumber_prices")
        .update({
          unit_price: newPrice,
          stock_status: stockStatus,
          stock_note: stockNote,
        })
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
        usedBackup,
      });
      console.log(
        `✓ Updated ${label} [${usedBackup ? "backup" : "primary"}]: $${oldPrice ?? "N/A"} -> $${newPrice}`
      );
    } else {
      if (primary.status === "out_of_stock") {
        await supabase
          .from("lumber_prices")
          .update({
            stock_status: stockStatus,
            stock_note: stockNote,
          })
          .eq("id", row.id);
      }

      if (primary.status === "outlier") {
        report.outliers.push({
          id: row.id,
          state: row.state,
          material: row.material_name,
          currentPrice: row.unit_price,
          candidatePrice: primary.candidate,
        });
        console.log(
          `⚠ Outlier rejected for ${label}: candidate $${primary.candidate} vs current $${row.unit_price} (keeping $${row.unit_price})`
        );
      } else if (primary.status !== "out_of_stock") {
        report.unparsed.push({
          id: row.id,
          state: row.state,
          material: row.material_name,
          currentPrice: row.unit_price,
          title: primary.title || "No title",
        });
        console.log(
          `⚠ Could not parse price for ${label} — keeping $${row.unit_price ?? "N/A"}`
        );
      }
    }
  } catch (err) {
    const msg =
      err.name === "TimeoutError" ? `Timeout after ${REQUEST_TIMEOUT_MS / 1000}s` : err.message;
    report.failed.push({
      id: row.id,
      state: row.state,
      material: row.material_name,
      error: msg,
    });
    console.log(`✕ Failed for ${label}: ${msg}`);
  } finally {
    if (REQUEST_DELAY_MS > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) break;
      await worker(items[currentIndex]);
    }
  });
  await Promise.all(workers);
}

async function sendOutOfStockNotification() {
  if (!WEBHOOK_URL || report.outOfStock.length === 0) return;

  const summaryText = report.outOfStock
    .map(
      (item) =>
        `• ${item.material} (${item.state || "US"}) [${item.urlType}]: ${item.reason}${
          item.usedBackup ? " (used backup URL)" : ""
        }`
    )
    .join("\n");

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Boardfootindex Out-of-Stock Alerts (${report.outOfStock.length}):\n${summaryText}`,
        content: `Boardfootindex Out-of-Stock Alerts (${report.outOfStock.length}):\n${summaryText}`,
      }),
    });
  } catch (err) {
    console.log(`⚠ Failed to send webhook notification: ${err.message}`);
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
    `| Out of Stock Alerts | ${report.outOfStock.length} |`,
    `| Outliers Rejected (Kept Current) | ${report.outliers.length} |`,
    `| Unparsed (Kept Current) | ${report.unparsed.length} |`,
    `| URL / Title Audits Needed | ${report.urlAudits.length} |`,
    `| Fetch / DB Errors | ${report.failed.length} |`,
    "",
  ];

  if (report.outOfStock.length > 0) {
    lines.push("### Out of Stock Alerts", "");
    for (const item of report.outOfStock) {
      const fallbackNote =
        item.urlType === "primary"
          ? item.usedBackup
            ? " — covered via backup URL"
            : " — no in-stock backup price used"
          : "";
      lines.push(
        `- **${item.material}** (${item.state || "US"}) [${item.urlType}]: ${item.reason}${fallbackNote}`
      );
    }
    lines.push("");
  }

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
    .select("id, state, material_name, dimensions, unit_price, source_url, backup_url")
    .order("state", { ascending: true })
    .order("material_name", { ascending: true });

  if (error) {
    console.error("Failed to fetch lumber_prices:", error.message);
    process.exit(1);
  }

  const catalog = (rows || []).filter((r) => Boolean(r.source_url) || Boolean(r.backup_url));
  console.log(`Found ${catalog.length} rows with source or backup URLs.`);

  await runWithConcurrency(catalog, CONCURRENCY, processRow);

  writeStepSummary();
  await sendOutOfStockNotification();

  const skippedOrIssues =
    report.outliers.length +
    report.unparsed.length +
    report.urlAudits.length +
    report.failed.length;

  console.log(
    `Done. Updated: ${report.updated.length}, OutOfStock: ${report.outOfStock.length}, Outliers: ${report.outliers.length}, Unparsed: ${report.unparsed.length}, Audits: ${report.urlAudits.length}, Failed: ${report.failed.length} (Total non-updated: ${skippedOrIssues})`
  );
}

main();
