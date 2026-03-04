create table public.stores (
  id uuid default uuid_generate_v4() primary key,
  chain_name text not null,
  store_name text not null,
  address text,
  lat numeric(10,7) not null,
  lng numeric(10,7) not null,
  tier text default 'mid',
  osm_id bigint unique,
  last_verified timestamptz default now(),
  created_at timestamptz default now()
);

create index idx_stores_location on public.stores(lat, lng);
create index idx_stores_osm_id on public.stores(osm_id);

-- Allow authenticated users to read stores
alter table public.stores enable row level security;

create policy "Anyone can read stores"
  on public.stores for select using (true);