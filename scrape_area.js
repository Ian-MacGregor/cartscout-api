import { createClient } from "@supabase/supabase-js";

const CHAIN_TIERS = {
  "walmart": "budget", "aldi": "budget", "lidl": "budget",
  "food lion": "budget", "costco": "budget", "save-a-lot": "budget",
  "dollar general": "budget", "kroger": "mid", "publix": "mid",
  "h-e-b": "mid", "safeway": "mid", "stop & shop": "mid",
  "giant": "mid", "meijer": "mid", "target": "mid",
  "harris teeter": "mid", "shoprite": "mid", "wegmans": "mid",
  "hannaford": "mid", "market basket": "mid", "shaw's": "mid",
  "trader joe's": "specialty", "sprouts": "specialty",
  "whole foods": "premium", "fresh market": "premium",
};

function classifyChain(name) {
  const lower = name.toLowerCase();
  for (const [chain, tier] of Object.entries(CHAIN_TIERS)) {
    if (lower.includes(chain)) return { chain_name: chain, tier };
  }
  return { chain_name: lower, tier: "mid" };
}

function parseStore(element) {
  const tags = element.tags || {};
  const name = tags.name || tags.brand || null;
  const lat = element.lat || element.center?.lat;
  const lng = element.lon || element.center?.lon;
  if (!name || !lat || !lng) return null;

  const { chain_name, tier } = classifyChain(name);
  const addressParts = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean);
  const cityParts = [tags["addr:city"], tags["addr:state"], tags["addr:postcode"]].filter(Boolean);
  let address = "";
  if (addressParts.length > 0) {
    address = addressParts.join(" ");
    if (cityParts.length > 0) address += ", " + cityParts.join(" ");
  }

  return {
    osm_id: element.id,
    store_name: name,
    chain_name,
    address: address || null,
    lat,
    lng,
    tier,
    last_verified: new Date().toISOString(),
  };
}

async function fetchFromOverpass(south, west, north, east) {
  const query = `
    [out:json][timeout:120];
    (
      nwr["shop"="supermarket"](${south},${west},${north},${east});
    );
    out center tags;
  `;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 130000);

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Overpass error: ${res.status}`);
    return (await res.json()).elements || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function scrapeArea(supabaseUrl, supabaseKey, lat, lng, radiusMiles = 20) {
  const supabase = createClient(supabaseUrl, supabaseKey);

  const latDelta = radiusMiles / 69;
  const lngDelta = radiusMiles / (69 * Math.cos(lat * Math.PI / 180));

  // Check if area already has stores
  const { data: existing } = await supabase
    .from("stores")
    .select("id")
    .gte("lat", lat - latDelta)
    .lte("lat", lat + latDelta)
    .gte("lng", lng - lngDelta)
    .lte("lng", lng + lngDelta)
    .limit(1);

  if (existing && existing.length > 0) {
    return { status: "already_populated", count: 0, scraped: false };
  }

  // Scrape from Overpass
  const south = lat - latDelta;
  const north = lat + latDelta;
  const west = lng - lngDelta;
  const east = lng + lngDelta;

  const elements = await fetchFromOverpass(south, west, north, east);
  const stores = elements.map(parseStore).filter(Boolean);

  // Upsert into database
  if (stores.length > 0) {
    const chunkSize = 100;
    for (let i = 0; i < stores.length; i += chunkSize) {
      const { error } = await supabase
        .from("stores")
        .upsert(stores.slice(i, i + chunkSize), { onConflict: "osm_id" });

      if (error) console.error(`Error upserting chunk:`, error.message);
    }
  }

  return { status: "scraped", count: stores.length, scraped: true };
}

// Also export the building blocks so scraper.js can use them directly
export { fetchFromOverpass, parseStore, classifyChain, CHAIN_TIERS };