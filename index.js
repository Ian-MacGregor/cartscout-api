import "dotenv/config";
    import { serve } from "@hono/node-server";
    import { Hono } from "hono";
    import { cors } from "hono/cors";
    import { createClient } from "@supabase/supabase-js";

    const app = new Hono();

    // Allow your GitHub Pages frontend to call this API
    app.use(
      "*",
      cors({
        origin: [
          "http://localhost:5173",
          "https://ian-macgregor.github.io",
        ],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      })
    );

    // Helper: create a Supabase client scoped to the logged-in user
    function getSupabase(authHeader) {
      // Service client for admin operations
      const serviceClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY
      );

      // If there's a user token, create a user-scoped client
      if (authHeader) {
        const token = authHeader.replace("Bearer ", "");
        return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
      }

      return serviceClient;
    }

    // ─── Auth Routes ───

    // Sign up
    app.post("/api/auth/signup", async (c) => {
      const { email, password, username } = await c.req.json();
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY
      );

      // Create auth user
      const { data: authData, error: authError } =
        await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });

      if (authError) return c.json({ error: authError.message }, 400);

      // Create profile
      const { error: profileError } = await supabase
        .from("profiles")
        .insert({ id: authData.user.id, username });

      if (profileError) return c.json({ error: profileError.message }, 400);

      // Sign them in immediately
      const { data: session, error: signInError } =
        await supabase.auth.signInWithPassword({ email, password });

      if (signInError) return c.json({ error: signInError.message }, 400);

      return c.json({
        user: { id: authData.user.id, email, username },
        session: session.session,
      });
    });

    // Sign in
    app.post("/api/auth/login", async (c) => {
      const { email, password } = await c.req.json();
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY
      );

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) return c.json({ error: error.message }, 401);

      // Fetch profile
      const { data: profile } = await supabase
        .from("profiles")
        .select("username")
        .eq("id", data.user.id)
        .single();

      return c.json({
        user: {
          id: data.user.id,
          email: data.user.email,
          username: profile?.username,
        },
        session: data.session,
      });
    });

    // ─── Grocery List Routes ───

    // Get all lists for the user
    app.get("/api/lists", async (c) => {
      const supabase = getSupabase(c.req.header("Authorization"));

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { data, error } = await supabase
        .from("grocery_lists")
        .select("*, list_items(*)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) return c.json({ error: error.message }, 500);
      return c.json(data);
    });

    // Create a new list
    app.post("/api/lists", async (c) => {
      const supabase = getSupabase(c.req.header("Authorization"));

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { name } = await c.req.json();

      const { data, error } = await supabase
        .from("grocery_lists")
        .insert({ user_id: user.id, name: name || "New Grocery List" })
        .select()
        .single();

      if (error) return c.json({ error: error.message }, 500);
      return c.json(data);
    });

    // Update a list name
    app.put("/api/lists/:id", async (c) => {
      const supabase = getSupabase(c.req.header("Authorization"));

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { name } = await c.req.json();

      const { data, error } = await supabase
        .from("grocery_lists")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", c.req.param("id"))
        .eq("user_id", user.id)
        .select()
        .single();

      if (error) return c.json({ error: error.message }, 500);
      return c.json(data);
    });

    // Delete a list
    app.delete("/api/lists/:id", async (c) => {
      const supabase = getSupabase(c.req.header("Authorization"));

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { error } = await supabase
        .from("grocery_lists")
        .delete()
        .eq("id", c.req.param("id"))
        .eq("user_id", user.id);

      if (error) return c.json({ error: error.message }, 500);
      return c.json({ success: true });
    });

    // ─── List Item Routes ───

    // Add item to a list
    app.post("/api/lists/:listId/items", async (c) => {
      const supabase = getSupabase(c.req.header("Authorization"));

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { product_name, category, base_price, quantity } = await c.req.json();

      const { data, error } = await supabase
        .from("list_items")
        .insert({
          list_id: c.req.param("listId"),
          product_name,
          category,
          base_price,
          quantity: quantity || 1,
        })
        .select()
        .single();

      if (error) return c.json({ error: error.message }, 500);
      return c.json(data);
    });

    // Update item quantity
    app.put("/api/items/:id", async (c) => {
      const supabase = getSupabase(c.req.header("Authorization"));

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { quantity } = await c.req.json();

      const { data, error } = await supabase
        .from("list_items")
        .update({ quantity })
        .eq("id", c.req.param("id"))
        .select()
        .single();

      if (error) return c.json({ error: error.message }, 500);
      return c.json(data);
    });

    // Remove item
    app.delete("/api/items/:id", async (c) => {
      const supabase = getSupabase(c.req.header("Authorization"));

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { error } = await supabase
        .from("list_items")
        .delete()
        .eq("id", c.req.param("id"));

      if (error) return c.json({ error: error.message }, 500);
      return c.json({ success: true });
    });

    // ─── Health Check ───
    app.get("/api/health", (c) => c.json({ status: "ok" }));

    // ─── Start Server ───
    const port = process.env.PORT || 3001;
    serve({ fetch: app.fetch, port }, () => {
      console.log(`CartScout API running on port ${port}`);
    });

// ─── Store Routes ───

// Get stores near a location
app.get("/api/stores", async (c) => {
  const lat = parseFloat(c.req.query("lat"));
  const lng = parseFloat(c.req.query("lng"));
  const radius = parseFloat(c.req.query("radius") || "20");

  if (isNaN(lat) || isNaN(lng)) {
    return c.json({ error: "lat and lng are required" }, 400);
  }

  // Approximate bounding box (1 degree lat ≈ 69 miles)
  const latDelta = radius / 69;
  const lngDelta = radius / (69 * Math.cos(lat * Math.PI / 180));

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
  );

  const { data, error } = await supabase
    .from("stores")
    .select("*")
    .gte("lat", lat - latDelta)
    .lte("lat", lat + latDelta)
    .gte("lng", lng - lngDelta)
    .lte("lng", lng + lngDelta);

  if (error) return c.json({ error: error.message }, 500);

  // Calculate actual distances and sort
  const withDistance = data.map(store => ({
    ...store,
    distance: Math.round(
      Math.sqrt(
        Math.pow((store.lat - lat) * 69, 2) +
        Math.pow((store.lng - lng) * 69 * Math.cos(lat * Math.PI / 180), 2)
      ) * 10
    ) / 10,
  }))
    .filter(s => s.distance <= radius)
    .sort((a, b) => a.distance - b.distance);

  return c.json(withDistance);
});