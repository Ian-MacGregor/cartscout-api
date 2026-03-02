-- Initial DB Schema for Cartscout
-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- Users table (Supabase Auth handles login, but this stores profile extras)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  username text unique not null,
  created_at timestamptz default now()
);

-- Grocery lists
create table public.grocery_lists (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  name text not null default 'New Grocery List',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Items within a list
create table public.list_items (
  id uuid default uuid_generate_v4() primary key,
  list_id uuid references public.grocery_lists(id) on delete cascade not null,
  product_name text not null,
  category text not null,
  base_price numeric(8,2) not null,
  quantity integer not null default 1,
  added_at timestamptz default now()
);

-- Row Level Security (ensures users only see their own data)
alter table public.profiles enable row level security;
alter table public.grocery_lists enable row level security;
alter table public.list_items enable row level security;

-- Policies
create policy "Users can read own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

create policy "Users can read own lists"
  on public.grocery_lists for select using (auth.uid() = user_id);

create policy "Users can create own lists"
  on public.grocery_lists for insert with check (auth.uid() = user_id);

create policy "Users can update own lists"
  on public.grocery_lists for update using (auth.uid() = user_id);

create policy "Users can delete own lists"
  on public.grocery_lists for delete using (auth.uid() = user_id);

create policy "Users can read own list items"
  on public.list_items for select
  using (list_id in (select id from public.grocery_lists where user_id = auth.uid()));

create policy "Users can create items in own lists"
  on public.list_items for insert
  with check (list_id in (select id from public.grocery_lists where user_id = auth.uid()));

create policy "Users can update items in own lists"
  on public.list_items for update
  using (list_id in (select id from public.grocery_lists where user_id = auth.uid()));

create policy "Users can delete items from own lists"
  on public.list_items for delete
  using (list_id in (select id from public.grocery_lists where user_id = auth.uid()));