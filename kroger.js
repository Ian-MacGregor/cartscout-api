import "dotenv/config";

let cachedToken = null;
let tokenExpiry = 0;

// Get an OAuth2 access token using client credentials
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const credentials = Buffer.from(
    `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=product.compact",
  });

  if (!res.ok) {
    throw new Error(`Kroger auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Expire 5 minutes early to be safe
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

  return cachedToken;
}

// Find the Kroger location ID for a store near given coordinates
export async function findKrogerLocation(lat, lng, radiusMiles = 10) {
  const token = await getToken();

  const res = await fetch(
    `https://api.kroger.com/v1/locations?filter.lat.near=${lat}&filter.lon.near=${lng}&filter.radiusInMiles=${radiusMiles}&filter.limit=10`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }
  );

  if (!res.ok) return [];

  const data = await res.json();
  return (data.data || []).map((loc) => ({
    locationId: loc.locationId,
    name: loc.name,
    chain: loc.chain,
    address: [
      loc.address?.addressLine1,
      loc.address?.city,
      loc.address?.state,
      loc.address?.zipCode,
    ]
      .filter(Boolean)
      .join(", "),
    lat: loc.geolocation?.latitude,
    lng: loc.geolocation?.longitude,
  }));
}

// Search for a product at a specific Kroger location
export async function searchProduct(term, locationId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.kroger.com/v1/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${locationId}&filter.limit=5`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }
  );

  if (!res.ok) return [];

  const data = await res.json();
  return (data.data || []).map((p) => ({
    productId: p.productId,
    upc: p.upc,
    description: p.description,
    brand: p.brand,
    category: p.categories?.[0] || "Grocery",
    price: p.items?.[0]?.price?.regular,
    promoPrice: p.items?.[0]?.price?.promo,
  }));
}

// Get prices for specific product IDs at a location
export async function getProductPrices(productIds, locationId) {
  const token = await getToken();
  const results = [];

  // Kroger API allows filtering by product ID one at a time
  // Batch in small groups to avoid rate limits
  for (const productId of productIds) {
    try {
      const res = await fetch(
        `https://api.kroger.com/v1/products/${productId}?filter.locationId=${locationId}`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        }
      );

      if (!res.ok) continue;

      const data = await res.json();
      const p = data.data;
      if (p) {
        results.push({
          productId: p.productId,
          price: p.items?.[0]?.price?.regular,
          promoPrice: p.items?.[0]?.price?.promo,
        });
      }

      // Respect rate limits
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`  Error fetching price for ${productId}:`, err.message);
    }
  }

  return results;
}