create table public.products (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  category text not null,
  upc text,
  kroger_product_id text unique,
  base_price numeric(8,2),
  created_at timestamptz default now()
);

create table public.prices (
  id uuid default uuid_generate_v4() primary key,
  store_id uuid references public.stores(id) on delete cascade not null,
  product_id uuid references public.products(id) on delete cascade not null,
  price numeric(8,2) not null,
  promo_price numeric(8,2),
  scraped_at timestamptz default now(),
  unique(store_id, product_id)
);

create index idx_prices_store on public.prices(store_id);
create index idx_prices_product on public.prices(product_id);
create index idx_products_kroger_id on public.products(kroger_product_id);

-- Add kroger_location_id to stores for mapping
alter table public.stores add column kroger_location_id text;
create index idx_stores_kroger_loc on public.stores(kroger_location_id);

-- Open read access
alter table public.products enable row level security;
alter table public.prices enable row level security;

create policy "Anyone can read products"
  on public.products for select using (true);

create policy "Anyone can read prices"
  on public.prices for select using (true);