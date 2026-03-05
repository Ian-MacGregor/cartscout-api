import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const SCRAPE_RADIUS_MILES = 20;

// Known grocery chains and their tiers
const CHAIN_TIERS = {
  "walmart": "budget",
  "aldi": "budget",
  "lidl": "budget",
  "food lion": "budget",
  "piggly wiggly": "budget",
  "costco": "budget",
  "save-a-lot": "budget",
  "dollar general": "budget",
  "kroger": "mid",
  "publix": "mid",
  "h-e-b": "mid",
  "safeway": "mid",
  "stop & shop": "mid",
  "giant": "mid",
  "meijer": "mid",
  "target": "mid",
  "harris teeter": "mid",
  "shoprite": "mid",
  "wegmans": "mid",
  "hannaford": "mid",
  "market basket": "mid",
  "shaw's": "mid",
  "trader joe's": "specialty",
  "sprouts": "specialty",
  "whole foods": "premium",
  "fresh market": "premium",
};

function classifyChain(name) {
  const lower = name.toLowerCase();
  for (const [chain, tier] of Object.entries(CHAIN_TIERS)) {
    if (lower.includes(chain)) return { chain_name: chain, tier };
  }
  return { chain_name: lower, tier: "mid" };
}

// ─── Clustering: merge user locations that overlap ───
// Two users within SCRAPE_RADIUS_MILES of each other would produce
// overlapping search areas, so we cluster them and scrape once per cluster.

function distanceMiles(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * 69;
  const dLng = (lng2 - lng1) * 69 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function clusterLocations(locations, radiusMiles) {
  // Simple greedy clustering:
  // For each location, check if it falls within an existing cluster.
  // If yes, skip it (the existing cluster's scrape covers it).
  // If no, create a new cluster centered on this location.
  const clusters = [];

  for (const loc of locations) {
    const alreadyCovered = clusters.some(
      (c) => distanceMiles(c.lat, c.lng, loc.lat, loc.lng) <= radiusMiles
    );

    if (!alreadyCovered) {
      clusters.push({ lat: loc.lat, lng: loc.lng });
    }
  }

  return clusters;
}

// ─── Overpass API ───

function buildBoundingBox(lat, lng, radiusMiles) {
  const latDelta = radiusMiles / 69;
  const lngDelta = radiusMiles / (69 * Math.cos(lat * Math.PI / 180));
  return {
    south: lat - latDelta,
    west: lng - lngDelta,
    north: lat + latDelta,
    east: lng + lngDelta,
  };
}

async function fetchStoresInArea(south, west, north, east) {
  
  const query = `
    [out:json][timeout:120];
    (
      nwr["shop"="supermarket"](${south},${west},${north},${east});
    );
    out center tags;
`;
// --- This is too costly and times out:
//  const query = `
//    [out:json][timeout:60];
//    (
//      node["shop"="supermarket"](${south},${west},${north},${east});
//      way["shop"="supermarket"](${south},${west},${north},${east});
//      node["shop"="grocery"](${south},${west},${north},${east});
//      way["shop"="grocery"](${south},${west},${north},${east});
//    );
//    out center tags;
//  `;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!response.ok) {
    throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.elements;
}

function parseStore(element) {
  const tags = element.tags || {};
  const name = tags.name || tags.brand || "Unknown Store";
  const lat = element.lat || element.center?.lat;
  const lng = element.lon || element.center?.lon;

  if (!lat || !lng || !name || name === "Unknown Store") return null;

  const { chain_name, tier } = classifyChain(name);

  const addressParts = [
    tags["addr:housenumber"],
    tags["addr:street"],
  ].filter(Boolean);

  const cityParts = [
    tags["addr:city"],
    tags["addr:state"],
    tags["addr:postcode"],
  ].filter(Boolean);

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

async function upsertStores(stores) {
  if (stores.length === 0) return 0;

  const chunkSize = 100;
  let totalUpserted = 0;

  for (let i = 0; i < stores.length; i += chunkSize) {
    const chunk = stores.slice(i, i + chunkSize);
    const { error } = await supabase
      .from("stores")
      .upsert(chunk, { onConflict: "osm_id" });

    if (error) {
      console.error(`  Error upserting chunk at index ${i}:`, error.message);
    } else {
      totalUpserted += chunk.length;
    }
  }

  return totalUpserted;
}

// ─── Main ───

async function runScraper() {
  console.log(`[store_scraper] Starting at ${new Date().toISOString()}`);
  console.log(`[store_scraper] Scrape radius: ${SCRAPE_RADIUS_MILES} miles`);

  // 1. Fetch all active user locations
  const { data: userLocations, error } = await supabase
    .from("user_locations")
    .select("lat, lng");

  if (error) {
    console.error("[store_scraper] Failed to fetch user locations:", error.message);
    process.exit(1);
  }

  if (!userLocations || userLocations.length === 0) {
    console.log("[store_scraper] No user locations found. Nothing to scrape.");
    return;
  }

  console.log(`[store_scraper] Found ${userLocations.length} user location(s)`);

  // 2. Cluster overlapping locations
  const clusters = clusterLocations(
    userLocations.map((l) => ({ lat: parseFloat(l.lat), lng: parseFloat(l.lng) })),
    SCRAPE_RADIUS_MILES
  );

  console.log(`[store_scraper] Clustered into ${clusters.length} unique scrape zone(s)`);

  // 3. Scrape each cluster
  let totalStores = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const bbox = buildBoundingBox(cluster.lat, cluster.lng, SCRAPE_RADIUS_MILES);

    console.log(
      `\\n[store_scraper] Zone ${i + 1}/${clusters.length}: ` +
      `center (${cluster.lat.toFixed(4)}, ${cluster.lng.toFixed(4)})`
    );

    try {
      const elements = await fetchStoresInArea(bbox.south, bbox.west, bbox.north, bbox.east);
      console.log(`  Found ${elements.length} raw results from Overpass`);

      const stores = elements.map(parseStore).filter(Boolean);
      console.log(`  Parsed ${stores.length} valid stores`);

      const upserted = await upsertStores(stores);
      console.log(`  Upserted ${upserted} stores`);
      totalStores += upserted;

      // Be respectful to the free Overpass API
      if (i < clusters.length - 1) {
        console.log("  Waiting 3s before next zone...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (err) {
      console.error(`  Error scraping zone ${i + 1}:`, err.message);
    }
  }

  console.log(`\\n[store_scraper] Complete. Total stores upserted: ${totalStores}`);
}

runScraper().catch((err) => {
  console.error("[store_scraper] Fatal error:", err);
  process.exit(1);
});