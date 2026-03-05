create table public.user_locations (
  user_id uuid references public.profiles(id) on delete cascade primary key,
  lat numeric(10,7) not null,
  lng numeric(10,7) not null,
  updated_at timestamptz default now()
);

alter table public.user_locations enable row level security;

create policy "Users can upsert own location"
  on public.user_locations for insert with check (auth.uid() = user_id);

create policy "Users can update own location"
  on public.user_locations for update using (auth.uid() = user_id);

-- Service role needs to read all locations for the scraper
create policy "Service can read all locations"
  on public.user_locations for select using (true);