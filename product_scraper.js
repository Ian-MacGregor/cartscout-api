import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Categories and search terms to scrape
// Each term generates multiple pages of results from Open Food Facts
const SEARCH_TERMS = [
  // Dairy
  "milk", "cheese", "yogurt", "butter", "cream", "eggs", "sour cream",
  "cottage cheese", "cream cheese",
  // Produce
  "apples", "bananas", "oranges", "strawberries", "blueberries",
  "grapes", "lemons", "limes", "avocado", "tomatoes", "potatoes",
  "onions", "carrots", "broccoli", "spinach", "lettuce", "peppers",
  "garlic", "celery", "cucumber", "mushrooms", "corn",
  // Meat
  "chicken breast", "ground beef", "ground turkey", "pork chops",
  "bacon", "sausage", "salmon", "shrimp", "deli turkey", "deli ham",
  "hot dogs", "steak",
  // Bakery
  "bread", "buns", "tortillas", "bagels", "muffins", "rolls",
  "pita bread", "english muffins", "croissants",
  // Pantry
  "pasta", "rice", "spaghetti sauce", "olive oil", "canola oil",
  "flour", "sugar", "peanut butter", "jelly", "canned tomatoes",
  "canned beans", "chicken broth", "soup", "cereal", "oatmeal",
  "granola", "honey", "syrup", "vinegar", "soy sauce", "ketchup",
  "mustard", "mayonnaise", "salsa", "hot sauce",
  // Beverages
  "orange juice", "apple juice", "coffee", "tea", "sparkling water",
  "soda", "lemonade", "almond milk", "oat milk", "coconut water",
  // Frozen
  "frozen pizza", "frozen vegetables", "ice cream", "frozen fruit",
  "frozen meals", "frozen waffles", "frozen fries",
  // Snacks
  "chips", "crackers", "cookies", "granola bars", "popcorn",
  "pretzels", "nuts", "trail mix", "dried fruit",
  // Household
  "paper towels", "toilet paper", "dish soap", "laundry detergent",
  "trash bags", "aluminum foil", "plastic wrap", "sponges",
  // Baby
  "baby food", "baby formula", "diapers", "baby wipes",
  // Pet
  "dog food", "cat food", "cat litter",
  // Breakfast
  "pancake mix", "cereal bars", "instant oatmeal",
  // Condiments
  "salt", "pepper", "cinnamon", "garlic powder", "cumin",
  "paprika", "italian seasoning", "ranch dressing", "salad dressing",
];

function mapCategory(tags) {
  if (!tags || tags.length === 0) return "Grocery";
  const joined = tags.join(" ").toLowerCase();

  if (joined.includes("dairy") || joined.includes("milk") || joined.includes("cheese") || joined.includes("yogurt")) return "Dairy";
  if (joined.includes("meat") || joined.includes("poultry") || joined.includes("beef") || joined.includes("chicken") || joined.includes("pork")) return "Meat";
  if (joined.includes("fruit") || joined.includes("vegetable") || joined.includes("produce") || joined.includes("fresh")) return "Produce";
  if (joined.includes("bread") || joined.includes("baked") || joined.includes("bakery")) return "Bakery";
  if (joined.includes("frozen")) return "Frozen";
  if (joined.includes("beverage") || joined.includes("drink") || joined.includes("juice") || joined.includes("coffee") || joined.includes("tea") || joined.includes("water")) return "Beverages";
  if (joined.includes("snack") || joined.includes("chip") || joined.includes("cookie") || joined.includes("cracker")) return "Snacks";
  if (joined.includes("cereal") || joined.includes("breakfast")) return "Breakfast";
  if (joined.includes("condiment") || joined.includes("sauce") || joined.includes("spice") || joined.includes("seasoning")) return "Condiments";
  if (joined.includes("pasta") || joined.includes("rice") || joined.includes("grain") || joined.includes("bean") || joined.includes("canned")) return "Pantry";
  if (joined.includes("cleaning") || joined.includes("household") || joined.includes("paper")) return "Household";
  if (joined.includes("baby")) return "Baby";
  if (joined.includes("pet")) return "Pet";

  return "Grocery";
}

const CATEGORY_BASE_PRICES = {
  Dairy: 4.29, Produce: 2.99, Meat: 6.49, Bakery: 3.29,
  Pantry: 3.49, Beverages: 4.99, Frozen: 4.49, Snacks: 3.99,
  Breakfast: 4.49, Condiments: 3.29, Household: 6.99,
  Baby: 8.99, Pet: 7.99, Grocery: 3.99,
};

async function fetchProducts(searchTerm, page = 1, retries = 3) {
  const url =
    `https://world.openfoodfacts.org/cgi/search.pl?` +
    `search_terms=${encodeURIComponent(searchTerm)}` +
    `&search_simple=1` +
    `&action=process` +
    `&json=1` +
    `&page=${page}` +
    `&page_size=20` +
    `&countries_tags_en=united-states` +
    `&fields=product_name,brands,quantity,categories_tags_en,code`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

      if (!res.ok) {
        throw new Error(`OFF API error: ${res.status}`);
      }

      return (await res.json()).products || [];
    } catch (err) {
      console.log(`    Attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) return [];
      // Be respectful to the free API
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return [];
}

function parseProduct(raw) {
  if (!raw.product_name || raw.product_name.trim().length < 3) return null;

  const brand = raw.brands?.split(",")[0]?.trim();
  const qty = raw.quantity;
  let name = raw.product_name.trim();

  // Prepend brand if not already in the name
  if (brand && !name.toLowerCase().includes(brand.toLowerCase())) {
    name = `${brand} ${name}`;
  }

  // Append quantity/size if present
  if (qty && !name.includes(qty)) {
    name = `${name} (${qty})`;
  }

  // Skip names that are too long or clearly garbage data
  if (name.length > 120) return null;

  const category = mapCategory(raw.categories_tags_en);
  const basePrice = CATEGORY_BASE_PRICES[category] || 3.99;

  return {
    name,
    category,
    base_price: basePrice,
    upc: raw.code || null,
  };
}

async function upsertProducts(products) {
  if (products.length === 0) return 0;

  // Deduplicate by name within the batch
  const seen = new Set();
  const unique = products.filter((p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const chunkSize = 100;
  let total = 0;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);

    // Check which ones already exist
    const names = chunk.map((p) => p.name);
    const { data: existing } = await supabase
      .from("products")
      .select("name")
      .in("name", names);

    const existingNames = new Set((existing || []).map((e) => e.name.toLowerCase()));
    const newProducts = chunk.filter((p) => !existingNames.has(p.name.toLowerCase()));

    if (newProducts.length > 0) {
      const { error } = await supabase.from("products").insert(newProducts);

      if (error) {
        console.error(`  Error inserting chunk:`, error.message);
      } else {
        total += newProducts.length;
      }
    }
  }

  return total;
}

async function run() {
  console.log(`[product_scraper] Starting at ${new Date().toISOString()}`);
  console.log(`[product_scraper] ${SEARCH_TERMS.length} search terms to process\n`);

  let totalNew = 0;
  let totalProcessed = 0;

  for (let t = 0; t < SEARCH_TERMS.length; t++) {
    const term = SEARCH_TERMS[t];
    console.log(`[${t + 1}/${SEARCH_TERMS.length}] Searching: "${term}"`);

    try {
      const allRaw = [];
      let page = 1;
      const maxPages = 3;

      while (page <= maxPages) {
        const raw = await fetchProducts(term, page);
        allRaw.push(...raw);

        // Stop if we got fewer results than page size (no more pages)
        if (raw.length < 20) break;

        page++;
        await new Promise((r) => setTimeout(r, 2000));
      }

      const parsed = allRaw.map(parseProduct).filter(Boolean);
      totalProcessed += parsed.length;

      const inserted = await upsertProducts(parsed);
      totalNew += inserted;

      console.log(`  Found ${allRaw.length} raw → ${parsed.length} valid → ${inserted} new (${page} page${page > 1 ? "s" : ""})`);

      // Be respectful to the free API
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  Error for "${term}":`, err.message);
    }
  }

  console.log(`\n[product_scraper] Complete.`);
  console.log(`  Total processed: ${totalProcessed}`);
  console.log(`  Total new products added: ${totalNew}`);
}

run().catch((err) => {
  console.error("[product_scraper] Fatal error:", err);
  process.exit(1);
});