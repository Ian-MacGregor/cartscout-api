import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { findKrogerLocation, searchProduct } from "./kroger.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// The products we want to track — mapped to Kroger search terms
const PRODUCT_SEARCHES = [
  { name: "Whole Milk (1 gal)", category: "Dairy", term: "whole milk gallon" },
  { name: "2% Milk (1 gal)", category: "Dairy", term: "2 percent milk gallon" },
  { name: "Large Eggs (dozen)", category: "Dairy", term: "large eggs dozen" },
  { name: "Butter (1 lb)", category: "Dairy", term: "butter 1 lb" },
  { name: "Cheddar Cheese (8 oz)", category: "Dairy", term: "cheddar cheese 8 oz" },
  { name: "Greek Yogurt (32 oz)", category: "Dairy", term: "greek yogurt 32 oz" },
  { name: "Bananas (1 lb)", category: "Produce", term: "bananas" },
  { name: "Apples (3 lb bag)", category: "Produce", term: "apples 3 lb bag" },
  { name: "Chicken Breast (1 lb)", category: "Meat", term: "chicken breast boneless" },
  { name: "Ground Beef 80/20 (1 lb)", category: "Meat", term: "ground beef 80 20" },
  { name: "Bacon (12 oz)", category: "Meat", term: "bacon 12 oz" },
  { name: "White Bread (loaf)", category: "Bakery", term: "white bread loaf" },
  { name: "Pasta (1 lb)", category: "Pantry", term: "spaghetti pasta 1 lb" },
  { name: "Pasta Sauce (24 oz)", category: "Pantry", term: "pasta sauce 24 oz" },
  { name: "Orange Juice (64 oz)", category: "Beverages", term: "orange juice 64 oz" },
  { name: "Coffee (12 oz bag)", category: "Beverages", term: "ground coffee 12 oz" },
  // Add more as needed
];

async function matchKrogerStores() {
  console.log("[price_scraper] Matching Kroger-family stores...");

  // Find stores that are Kroger-family and don't have a kroger_location_id yet
  const { data: stores, error } = await supabase
    .from("stores")
    .select("*")
    .is("kroger_location_id", null)
    .in("chain_name", [
      "kroger", "ralphs", "fred meyer", "harris teeter",
      "king soopers", "fry's", "qfc", "mariano's",
      "pick 'n save", "smith's", "city market",
    ]);

  if (error || !stores) {
    console.error("[price_scraper] Error fetching stores:", error?.message);
    return;
  }

  console.log(`[price_scraper] Found ${stores.length} unmatched Kroger-family stores`);

  for (const store of stores) {
    try {
      const locations = await findKrogerLocation(store.lat, store.lng, 2);

      if (locations.length > 0) {
        const match = locations[0];
        await supabase
          .from("stores")
          .update({ kroger_location_id: match.locationId })
          .eq("id", store.id);

        console.log(`  Matched "${store.store_name}" → Kroger ID ${match.locationId}`);
      } else {
        console.log(`  No Kroger match for "${store.store_name}"`);
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`  Error matching ${store.store_name}:`, err.message);
    }
  }
}

async function ensureProducts() {
  console.log("[price_scraper] Ensuring products exist in DB...");

  for (const product of PRODUCT_SEARCHES) {
    const { data: existing } = await supabase
      .from("products")
      .select("id")
      .eq("name", product.name)
      .single();

    if (!existing) {
      await supabase
        .from("products")
        .insert({ name: product.name, category: product.category });
      console.log(`  Created product: ${product.name}`);
    }
  }
}

async function scrapeKrogerPrices() {
  console.log("[price_scraper] Scraping Kroger prices...");

  // Get all stores that have a kroger_location_id
  const { data: stores, error } = await supabase
    .from("stores")
    .select("id, store_name, kroger_location_id")
    .not("kroger_location_id", "is", null);

  if (error || !stores || stores.length === 0) {
    console.log("[price_scraper] No Kroger-matched stores to scrape");
    return;
  }

  // Get all products
  const { data: products } = await supabase
    .from("products")
    .select("id, name");

  const productMap = {};
  products.forEach((p) => (productMap[p.name] = p.id));

  console.log(`[price_scraper] Scraping ${stores.length} stores for ${PRODUCT_SEARCHES.length} products`);

  for (const store of stores) {
    console.log(`\n  Store: ${store.store_name} (${store.kroger_location_id})`);

    for (const product of PRODUCT_SEARCHES) {
      const productId = productMap[product.name];
      if (!productId) continue;

      try {
        const results = await searchProduct(product.term, store.kroger_location_id);

        if (results.length > 0 && results[0].price) {
          const best = results[0];

          await supabase
            .from("prices")
            .upsert(
              {
                store_id: store.id,
                product_id: productId,
                price: best.price,
                promo_price: best.promoPrice || null,
                scraped_at: new Date().toISOString(),
              },
              { onConflict: "store_id,product_id" }
            );

          console.log(
            `    ${product.name}: $${best.price}` +
            (best.promoPrice ? ` (sale: $${best.promoPrice})` : "")
          );

          // Save kroger_product_id for future direct lookups
          if (best.productId) {
            await supabase
              .from("products")
              .update({ kroger_product_id: best.productId })
              .eq("id", productId);
          }
        } else {
          console.log(`    ${product.name}: no price found`);
        }

        // Respect rate limits
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        console.error(`    Error for ${product.name}:`, err.message);
      }
    }
  }
}

async function run() {
  console.log(`[price_scraper] Starting at ${new Date().toISOString()}\n`);

  await ensureProducts();
  await matchKrogerStores();
  await scrapeKrogerPrices();

  console.log("\n[price_scraper] Complete.");
}

run().catch((err) => {
  console.error("[price_scraper] Fatal error:", err);
  process.exit(1);
});