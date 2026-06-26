-- Tracco Tx - Esquema multi-tenant (tablas con prefijo tx_ para convivir con
-- otras apps del proyecto). RLS por RUT: cada usuario ve solo los RUT a los que
-- esta autorizado (tx_usuario_rut). El service_role (Edge Functions) salta RLS.

-- 1) Usuarios autorizados (correo). El login valida contra el SII y ademas exige
--    que el correo exista aqui.
create table if not exists public.tx_usuarios (
  email       text primary key,
  nombre      text,
  rol         text not null default 'cliente',   -- 'admin' | 'cliente' | 'contador'
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- 2) Contribuyentes (un registro por RUT) + configuracion para el F29.
create table if not exists public.tx_contribuyentes (
  rut             text primary key,               -- formato 12345678-9
  razon_social    text,
  giro            text,
  renta_efectiva  boolean not null default true,
  paga_ppm        boolean not null default true,
  ppm_tasa        numeric(6,3),                    -- % PPM
  tramo_iepd_pct  numeric(5,2) not null default 80, -- % recuperable IEPD (codigo 544)
  config          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 3) Autorizacion usuario <-> RUT (multi-tenant).
create table if not exists public.tx_usuario_rut (
  email  text not null references public.tx_usuarios(email) on delete cascade,
  rut    text not null references public.tx_contribuyentes(rut) on delete cascade,
  rol    text not null default 'cliente',
  primary key (email, rut)
);

-- 4) Camiones: patente + caja rol, asignables por rango de fechas.
create table if not exists public.tx_camiones (
  id             uuid primary key default gen_random_uuid(),
  rut            text not null references public.tx_contribuyentes(rut) on delete cascade,
  patente        text not null,
  caja_rol       text,
  vigente_desde  date,
  vigente_hasta  date,
  activo         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists tx_camiones_rut_idx on public.tx_camiones(rut);

-- 5) Facturas: UNA fila por factura con su contenido clasificado.
create table if not exists public.tx_facturas (
  id                uuid primary key default gen_random_uuid(),
  rut               text not null references public.tx_contribuyentes(rut) on delete cascade,
  tipo              text not null,                 -- 'compra' | 'venta'
  tipo_dte          integer,                       -- 33, 34, 61, ...
  folio             text not null,
  rut_contraparte   text,
  razon_social      text,
  fecha_emision     date,
  fecha_recepcion   date,
  periodo           char(6),                       -- AAAAMM
  neto              bigint,
  iva               bigint,
  exento            bigint,
  total             bigint,
  iepd              bigint,                         -- monto impuesto especifico diesel
  cod_otro_impuesto integer,                        -- 28 = IEPD
  litros            numeric(14,2),
  categoria         text,                           -- clasificacion de gasto (IA/regla/manual)
  subcategoria      text,
  camion_id         uuid references public.tx_camiones(id) on delete set null,
  clasif_origen     text,                           -- 'ia' | 'regla' | 'manual'
  raw               jsonb,
  created_at        timestamptz not null default now(),
  unique (rut, tipo, tipo_dte, folio)
);
create index if not exists tx_facturas_rut_periodo_idx on public.tx_facturas(rut, periodo);
create index if not exists tx_facturas_categoria_idx on public.tx_facturas(rut, categoria);

-- 6) Resumen por periodo (mes) y RUT: insumos del Dashboard y del F29/1866/1867.
create table if not exists public.tx_periodos (
  rut               text not null references public.tx_contribuyentes(rut) on delete cascade,
  periodo           char(6) not null,
  litros            numeric(14,2),
  iepd_total        bigint,
  credito_544       bigint,
  ingresos          bigint,
  ingreso_por_litro numeric(14,4),
  f29               jsonb,
  dj1866            jsonb,
  dj1867            jsonb,
  updated_at        timestamptz not null default now(),
  primary key (rut, periodo)
);

-- 7) Reglas de parser por proveedor (auto-sanacion: cuando un proveedor trae otra
--    estructura de XML, se guarda aqui la regla para extraer litros a futuro).
create table if not exists public.tx_dte_parsers (
  id           uuid primary key default gen_random_uuid(),
  rut_emisor   text,                               -- proveedor (RUT) al que aplica
  proveedor    text,
  regla        jsonb not null,
  ejemplo_xml  text,
  activo       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists tx_dte_parsers_emisor_idx on public.tx_dte_parsers(rut_emisor);

-- 8) Taxonomia de categorias de gasto (global o por RUT) para el Dashboard.
create table if not exists public.tx_categorias (
  id            uuid primary key default gen_random_uuid(),
  rut           text,                               -- null = categoria global
  nombre        text not null,
  descripcion   text,
  palabras_clave text[],
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: cada usuario accede solo a los RUT autorizados (por su correo en el JWT).
-- ---------------------------------------------------------------------------
alter table public.tx_usuarios        enable row level security;
alter table public.tx_contribuyentes  enable row level security;
alter table public.tx_usuario_rut     enable row level security;
alter table public.tx_camiones        enable row level security;
alter table public.tx_facturas        enable row level security;
alter table public.tx_periodos        enable row level security;
alter table public.tx_dte_parsers     enable row level security;
alter table public.tx_categorias      enable row level security;

-- Helper inline: el correo del usuario autenticado.
--   auth.jwt() ->> 'email'

-- Usuario ve su propia fila.
create policy tx_usuarios_self on public.tx_usuarios
  for select using (email = (auth.jwt() ->> 'email'));

-- Usuario ve sus vinculos usuario-rut.
create policy tx_usuario_rut_self on public.tx_usuario_rut
  for select using (email = (auth.jwt() ->> 'email'));

-- Tablas por RUT: acceso si el correo esta autorizado para ese RUT.
create policy tx_contribuyentes_rls on public.tx_contribuyentes
  for all using (exists (select 1 from public.tx_usuario_rut ur
    where ur.email = (auth.jwt() ->> 'email') and ur.rut = tx_contribuyentes.rut));

create policy tx_camiones_rls on public.tx_camiones
  for all using (exists (select 1 from public.tx_usuario_rut ur
    where ur.email = (auth.jwt() ->> 'email') and ur.rut = tx_camiones.rut));

create policy tx_facturas_rls on public.tx_facturas
  for all using (exists (select 1 from public.tx_usuario_rut ur
    where ur.email = (auth.jwt() ->> 'email') and ur.rut = tx_facturas.rut));

create policy tx_periodos_rls on public.tx_periodos
  for all using (exists (select 1 from public.tx_usuario_rut ur
    where ur.email = (auth.jwt() ->> 'email') and ur.rut = tx_periodos.rut));

create policy tx_categorias_rls on public.tx_categorias
  for select using (rut is null or exists (select 1 from public.tx_usuario_rut ur
    where ur.email = (auth.jwt() ->> 'email') and ur.rut = tx_categorias.rut));

-- tx_dte_parsers: lectura para cualquier usuario autenticado (reglas compartidas);
-- la escritura la hace el service_role (Edge Functions), que salta RLS.
create policy tx_dte_parsers_read on public.tx_dte_parsers
  for select using (auth.role() = 'authenticated');
