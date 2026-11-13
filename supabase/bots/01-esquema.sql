-- =====================================================================
-- Kionda · Fábrica de bots — base multi-cliente
-- Un solo proyecto de Supabase para todos los negocios (cada fila lleva negocio_id).
-- Primer negocio: Doble As Taller de Motos.
-- =====================================================================

create extension if not exists pgcrypto;

-- Negocios (cada cliente de Kionda)
create table if not exists negocios (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,                 -- ej: 'dobleas'
  nombre text not null,
  rubro text not null default 'taller_motos',
  direccion text, horario text, telefono text, resena_url text,
  wa_phone_id text,                          -- phone number id de Meta (si tiene número propio)
  config jsonb not null default '{
    "intervalos":{"mineral":3500,"semi":6000,"sintetico":8500},
    "meses":6,"dias_antes":7,"turnos_on":true,"cupos":4
  }'::jsonb,
  creado timestamptz not null default now()
);

-- Quién puede entrar al panel de cada negocio (por email)
create table if not exists usuarios_negocio (
  negocio_id uuid references negocios(id) on delete cascade,
  email text not null,
  rol text not null default 'dueno',          -- 'dueno' | 'kionda'
  primary key (negocio_id, email)
);

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  nombre text not null,
  telefono text not null,                     -- formato 549XXXXXXXXXX
  acepta_avisos boolean not null default false,
  creado timestamptz not null default now()
);
create index if not exists clientes_neg on clientes(negocio_id);
create unique index if not exists clientes_tel on clientes(negocio_id, telefono);

create table if not exists motos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  cliente_id uuid not null references clientes(id) on delete cascade,
  modelo text not null, patente text, anio int,
  aceite text not null default 'mineral' check (aceite in ('mineral','semi','sintetico')),
  km_actual_informado int,                    -- lo que responde el cliente al bot
  km_informado_fecha date
);
create index if not exists motos_neg on motos(negocio_id);

create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  moto_id uuid not null references motos(id) on delete cascade,
  fecha date not null default current_date,
  km int not null,
  aceite text not null check (aceite in ('mineral','semi','sintetico')),
  trabajos text[] not null default '{}',
  notas text, precio int,
  creado timestamptz not null default now()
);
create index if not exists services_moto on services(moto_id, fecha);

create table if not exists en_taller (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  moto_id uuid not null references motos(id) on delete cascade,
  estado text not null default 'en_taller' check (estado in ('en_taller','lista','entregada')),
  trabajo text, ingreso date not null default current_date, entregada date
);

create table if not exists turnos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  moto_id uuid references motos(id) on delete set null,
  cliente_id uuid references clientes(id) on delete set null,
  fecha date not null, motivo text,
  origen text not null default 'taller' check (origen in ('taller','bot')),
  creado timestamptz not null default now()
);

create table if not exists presupuestos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  moto_id uuid not null references motos(id) on delete cascade,
  items jsonb not null default '[]',          -- [{"desc":"...","precio":0}]
  estado text not null default 'enviado' check (estado in ('borrador','enviado','aprobado','rechazado')),
  fecha date not null default current_date
);

-- Mensajes que manda el sistema (recordatorios, moto lista, etc.)
create table if not exists avisos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  moto_id uuid references motos(id) on delete set null,
  cliente_id uuid references clientes(id) on delete set null,
  tipo text not null,                         -- recordatorio | lista | service | presupuesto | resena
  estado text not null default 'enviado' check (estado in ('programado','enviado','respondio','volvio','error')),
  wa_msg_id text,
  fecha timestamptz not null default now()
);

-- Conversaciones de WhatsApp (bot vendedor de Kionda + bots de clientes)
create table if not exists chats (
  telefono text not null,
  canal text not null,                        -- phone number id que recibió el mensaje
  modo text not null default 'vendedor',      -- 'vendedor' | 'demo:dobleas' | 'negocio:dobleas'
  historial jsonb not null default '[]',
  nombre text,
  interes text,                               -- frio | tibio | caliente (vendedor)
  resumen text,
  actualizado timestamptz not null default now(),
  primary key (telefono, canal)
);

-- ===================== Seguridad (RLS) =====================
create or replace function mis_negocios() returns setof uuid
language sql stable security definer set search_path = public as $$
  select negocio_id from usuarios_negocio where email = (select auth.jwt() ->> 'email')
$$;

do $$ declare t text; begin
  foreach t in array array['clientes','motos','services','en_taller','turnos','presupuestos','avisos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists acceso on %I', t);
    execute format('create policy acceso on %I for all to authenticated using (negocio_id in (select mis_negocios())) with check (negocio_id in (select mis_negocios()))', t);
  end loop;
end $$;

alter table negocios enable row level security;
drop policy if exists acceso on negocios;
create policy acceso on negocios for all to authenticated using (id in (select mis_negocios())) with check (id in (select mis_negocios()));

alter table usuarios_negocio enable row level security;
drop policy if exists ver_propios on usuarios_negocio;
create policy ver_propios on usuarios_negocio for select to authenticated using (email = (select auth.jwt() ->> 'email'));

alter table chats enable row level security;  -- solo la Edge Function (service role) los toca

-- ===================== Primer negocio =====================
insert into negocios (slug, nombre, direccion, horario, telefono)
values ('dobleas','Doble As Taller de Motos','Miranda 4514, Floresta, CABA',
        'Lunes a viernes de 9 a 18 · Sábados de 9 a 13','5491122968175')
on conflict (slug) do nothing;

insert into usuarios_negocio (negocio_id, email, rol)
select id, 'kionda043@gmail.com', 'kionda' from negocios where slug = 'dobleas'
on conflict do nothing;
