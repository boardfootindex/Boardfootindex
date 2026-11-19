import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Default representative zip codes per region for localized requests
const REGION_ZIPS = {
  US: '30301', // National baseline (Atlanta hub)
  NE: '10001', // Northeast (NY)
  SE: '30301', // Southeast (GA)
  MW: '60601', // Midwest (IL)
  SC: '75201', // South Central (TX)
  MT: '80202', // Mountain (CO)
  PC: '97201'  // Pacific (OR)
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractPriceFromHtml(html) {
  // 1. Try JSON-LD structured product schema first (cleanest & most reliable)
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const offers = item?.offers;
        if (Array.isArray(offers) && offers[0]?.price) {
          const price = parseFloat(offers[0].price);
          if (price > 0) return price;
        } else if (offers?.price) {
          const price = parseFloat(offers.price);
          if (price > 0) return price;
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }

  // 2. Fallback: look for common retailer embedded price JSON patterns
  const patterns = [
    /"price"\s*:\s*"?(\d+\.\d{2})"?/i,
    /"sellingPrice"\s*:\s*"?(\d+\.\d{2})"?/i,
    /"currentPrice"\s*:\s*"?(\d+\.\d{2})"?/i
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m && parseFloat(m[1]) > 0) {
      return parseFloat(m[1]);
    }
  }

  return null;
}

async function fetchProductHtml(url, regionCode) {
  const zip = REGION_ZIPS[regionCode] || REGION_ZIPS.US;

  // If SCRAPER_API_KEY is configured, route through proxy with geotargeting
  if (SCRAPER_API_KEY) {
    const proxyUrl = `https://api.scraperapi.com?api_key=${encodeURIComponent(SCRAPER_API_KEY)}&url=${encodeURIComponent(url)}&country_code=us`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
    return await res.text();
  }

  // Direct fetch with realistic browser headers + regional store zip hint
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': `THD_PERSIST=C4%3D${zip}; sn=${zip}`
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

async function run() {
  console.log('Fetching lumber catalog from Supabase...');
  const { data: rows, error } = await supabase
    .from('lumber_prices')
    .select('*')
    .not('source_url', 'is', null);

  if (error) {
    console.error('Supabase fetch error:', error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} rows with source URLs.`);
  let updatedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const url = (row.source_url || '').trim();
    // Skip generic homepage links (like https://www.homedepot.com without a specific product path)
    if (!url || new URL(url).pathname === '/') {
      console.log(`↷ Skipping generic URL for "${row.material_name}" (${row.state})`);
      skippedCount++;
      continue;
    }

    try {
      const html = await fetchProductHtml(url, row.state);
      const newPrice = extractPriceFromHtml(html);

      if (!newPrice) {
        console.warn(`⚠ Could not parse price for "${row.material_name}" (${row.state}) — keeping $${row.unit_price}`);
        await supabase
          .from('lumber_prices')
          .update({ last_checked_at: new Date().toISOString(), last_status: 'parse_skipped' })
          .eq('id', row.id);
        skippedCount++;
      } else {
        const bfPerUnit = Number(row.board_feet_per_unit || 0);
        const newBfPrice = bfPerUnit > 0 ? Number((newPrice / bfPerUnit).toFixed(2)) : row.price_per_board_foot;

        const { error: updateErr } = await supabase
          .from('lumber_prices')
          .update({
            unit_price: newPrice,
            price_per_board_foot: newBfPrice,
            last_checked_at: new Date().toISOString(),
            last_status: 'ok'
          })
          .eq('id', row.id);

        if (updateErr) throw updateErr;
        console.log(`✓ Updated "${row.material_name}" (${row.state}): $${row.unit_price} -> $${newPrice}`);
        updatedCount++;
      }
    } catch (err) {
      console.warn(`✕ Blocked/Failed for "${row.material_name}" (${row.state}): ${err.message}`);
      await supabase
        .from('lumber_prices')
        .update({ last_checked_at: new Date().toISOString(), last_status: `error: ${err.message}` })
        .eq('id', row.id);
      skippedCount++;
    }

    // Polite delay between requests
    await sleep(1500);
  }

  console.log(`\nDone. Updated: ${updatedCount}, Skipped/Blocked: ${skippedCount}`);
}

run();
