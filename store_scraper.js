import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { fetchFromOverpass, parseStore } from "./scrape_area.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ─── Distance helper ───
function distanceMiles(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * 69;
  const dLng = (lng2 - lng1) * 69 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// ─── Clustering ───
// Groups nearby user locations so overlapping areas aren't scraped twice.
// Each cluster uses the largest radius among its members.
function clusterLocations(locations) {
  const clusters = [];

  for (const loc of locations) {
    const radius = loc.radius || 20;
    const alreadyCovered = clusters.some(
      (c) => distanceMiles(c.lat, c.lng, loc.lat, loc.lng) <= Math.max(c.radius, radius)
    );

    if (!alreadyCovered) {
      clusters.push({ lat: loc.lat, lng: loc.lng, radius });
    }
  }

  return clusters;
}

// ─── Bounding box from center + radius ───
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

// ─── Upsert stores into the database ───
async function upsertStores(stores) {
  if (stores.length === 0) return 0;

  const chunkSize = 100;
  let total = 0;

  for (let i = 0; i < stores.length; i += chunkSize) {
    const chunk = stores.slice(i, i + chunkSize);
    const { error } = await supabase
      .from("stores")
      .upsert(chunk, { onConflict: "osm_id" });

    if (error) {
      console.error(`  Error upserting chunk at index ${i}:`, error.message);
    } else {
      total += chunk.length;
    }
  }

  return total;
}

// ─── Main ───
async function runScraper() {
  console.log(`[store_scraper] Starting at ${new Date().toISOString()}`);

  // 1. Fetch all active user locations with their preferred radius
  const { data: userLocations, error } = await supabase
    .from("user_locations")
    .select("lat, lng, radius_miles");

  if (error) {
    console.error("[store_scraper] Failed to fetch user locations:", error.message);
    process.exit(1);
  }

  if (!userLocations || userLocations.length === 0) {
    console.log("[store_scraper] No user locations found. Nothing to scrape.");
    return;
  }

  console.log(`[store_scraper] Found ${userLocations.length} user location(s)`);

  // 2. Cluster overlapping locations using each user's radius
  const clusters = clusterLocations(
    userLocations.map((l) => ({
      lat: parseFloat(l.lat),
      lng: parseFloat(l.lng),
      radius: l.radius_miles || 20,
    }))
  );

  console.log(`[store_scraper] Clustered into ${clusters.length} unique scrape zone(s)`);

  // 3. Scrape each cluster
  let totalStores = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const bbox = buildBoundingBox(cluster.lat, cluster.lng, cluster.radius);

    console.log(
      `\n[store_scraper] Zone ${i + 1}/${clusters.length}: ` +
      `center (${cluster.lat.toFixed(4)}, ${cluster.lng.toFixed(4)}), ` +
      `radius ${cluster.radius} mi`
    );

    try {
      const elements = await fetchFromOverpass(bbox.south, bbox.west, bbox.north, bbox.east);
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

  console.log(`\n[store_scraper] Complete. Total stores upserted: ${totalStores}`);
}

runScraper().catch((err) => {
  console.error("[store_scraper] Fatal error:", err);
  process.exit(1);
});