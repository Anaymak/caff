-- Template for every new table in "public" (Supabase stopped auto-granting
-- Data API access to new public tables on 30 Oct 2026). Copy into the SAME
-- migration that creates the table. Grant only what the RLS policies need;
-- omit anon entirely unless the table is meant to be read by signed-out users.

create table public.example (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table public.example enable row level security;

-- create policy ... on public.example for select to authenticated using (...);

-- grant select on public.example to anon;                      -- only if public
grant select, insert, update, delete on public.example to authenticated; -- trim to the policies
grant select, insert, update, delete on public.example to service_role;  -- server-side only
-- identity/serial columns used by inserts from the API also need:
-- grant usage on sequence public.example_id_seq to authenticated;
