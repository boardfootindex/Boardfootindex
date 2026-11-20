function detectOutOfStock(html = "") {
  if (
    /https?:\/\/schema\.org\/OutOfStock/i.test(html) ||
    /"availability"\s*:\s*"[^"]*OutOfStock/i.test(html)
  ) {
    return "JSON-LD availability is OutOfStock";
  }

  const visibleText = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const oosPatterns = [
    /\bout of stock\b/i,
    /\bcurrently unavailable\b/i,
    /\btemporarily unavailable\b/i,
    /\bsold out\b/i,
    /\bnot available in (your )?store\b/i,
  ];

  for (const pattern of oosPatterns) {
    if (pattern.test(visibleText)) {
      return `Matched "${pattern.source}"`;
    }
  }

  return null;
}

async function evaluateUrlCandidate(url, currentPrice, label, role) {
  if (!url || isGenericOrCategoryUrl(url)) {
    return { status: "missing", reason: "Missing or generic URL" };
  }

  const html = await fetchPageHtml(url, false);
  const title = extractTitle(html);
  auditPageTitle({ id: label, state: "", material_name: `${label} (${role})` }, title);

  const oosReason = detectOutOfStock(html);
  if (oosReason) {
    console.log(`📦 Out of stock on ${role} URL for ${label}: ${oosReason}`);
    return { status: "out_of_stock", reason: oosReason, title };
  }

  const parsed = extractPriceFromHtml(html, currentPrice);
  if (parsed.status === "ok" && typeof parsed.price === "number") {
    return { status: "ok", price: parsed.price, title };
  }

  if (parsed.status === "outlier") {
    return { status: "outlier", candidate: parsed.candidate, title };
  }

  return { status: "unparsed", title };
}
