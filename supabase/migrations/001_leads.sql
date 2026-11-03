-- Leads de kionda IA: charlas del bot y formulario de contacto
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null default 'bot' check (source in ('bot','form')),
  lang text not null default 'es',
  name text,
  contact text,
  business text,
  need text,
  ideas text,
  summary text,
  score text not null default 'frio' check (score in ('frio','tibio','caliente')),
  wants_quote boolean not null default false,
  status text not null default 'nuevo' check (status in ('nuevo','contactado','descartado')),
  messages jsonb not null default '[]'::jsonb,
  user_turns int not null default 0,
  ip_hash text
);

create index if not exists leads_created_idx on public.leads (created_at desc);
create index if not exists leads_ip_idx on public.leads (ip_hash, created_at desc);

alter table public.leads enable row level security;

-- Solo el admin (mail de Lucas) puede ver y actualizar. El bot escribe con la clave de servicio.
create policy "admin lee leads" on public.leads
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'kionda043@gmail.com');

create policy "admin actualiza leads" on public.leads
  for update to authenticated
  using ((auth.jwt() ->> 'email') = 'kionda043@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'kionda043@gmail.com');
