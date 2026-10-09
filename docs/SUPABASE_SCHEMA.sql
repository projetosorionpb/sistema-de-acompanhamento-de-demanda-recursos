-- ══════════════════════════════════════════════════════════════
-- Supabase — Sistema de Acompanhamento de Demanda (SIATE × LIST)
-- Espelha o banco local (localStorage sad_db_v1) p/ uso MULTIUSUÁRIO no site.
-- Como aplicar: Supabase Dashboard → SQL Editor → New query → colar tudo → Run.
-- ══════════════════════════════════════════════════════════════

-- ── 1. Caixa principal: congruentes + quarentena aprovada ──
create table if not exists demandas (
  numos text primary key,
  codserv text,
  datasol text,
  data_iso date,
  codreg smallint check (codreg in (1,2,3)),
  regional text,
  cidade text,
  cliente text,
  tel1 text,
  tel2 text,
  obs text,
  dscsvc text,
  status_demanda text not null default 'A INICIAR'
    check (status_demanda in ('A INICIAR','EM ANDAMENTO','PENDENTE','ENCERRADO')),
  responsavel text,
  origem text not null default 'CONGRUENTE',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- métrica de conclusão: quando/quem encerrou (app preenche ao marcar ENCERRADO)
  encerrado_em timestamptz,
  encerrado_por text
);
create index if not exists idx_demandas_status on demandas(status_demanda);
create index if not exists idx_demandas_reg on demandas(codreg);
create index if not exists idx_demandas_cidade on demandas(cidade);
create index if not exists idx_demandas_data on demandas(data_iso);
create index if not exists idx_demandas_resp on demandas(responsavel);
create index if not exists idx_demandas_enc on demandas(encerrado_por, encerrado_em);

-- ── 2. Quarentena: divergentes ──
create table if not exists quarentena (
  id bigint generated always as identity primary key,
  numos text not null,
  origem text not null check (origem in ('SO_SIATE','SO_LIST','JA_NA_CAIXA','DIVERGENTE')),
  motivo text,
  dados jsonb,
  created_at timestamptz default now(),
  unique(numos, origem)
);
create index if not exists idx_quar_origem on quarentena(origem);
create index if not exists idx_quar_numos on quarentena(numos);

-- ── 3. Reprovadas (p/ não voltar na próxima importação) ──
create table if not exists reprovadas (
  numos text not null,
  origem text not null check (origem in ('SO_SIATE','SO_LIST','JA_NA_CAIXA','DIVERGENTE')),
  por text,
  created_at timestamptz default now(),
  primary key (numos, origem)
);

-- ── 4. Histórico de importações ──
create table if not exists importacoes (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  por text,
  filtros jsonb,
  siate_filtrada int,
  list_filtrada int,
  cong_total int,
  novas_principal int,
  novas_quarentena int,
  promovidas int default 0,
  ignoradas_reprovadas int default 0,
  preservadas_caixa int default 0,
  duplicadas_quarentena int default 0
);

-- ── 5. Perfis (10 usuários + 6 admins — Auth do Supabase é a fonte) ──
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  role text not null default 'usuario' check (role in ('admin','usuario')),
  name text,
  created_at timestamptz default now()
);
create index if not exists idx_profiles_role on profiles(role);

-- Auto-cria profile no signup. O PRIMEIRO usuário vira admin; demais viram usuario
-- (depois um admin promove a admin no painel / Table Editor).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  n_admins int;
begin
  select count(*) into n_admins from public.profiles where role = 'admin';
  insert into public.profiles (id, email, role, name)
  values (
    new.id,
    coalesce(new.email, ''),
    case when n_admins = 0 then 'admin' else 'usuario' end,
    split_part(coalesce(new.email,''), '@', 1)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at automático
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_demandas_touch on demandas;
create trigger trg_demandas_touch
  before update on demandas
  for each row execute function public.touch_updated_at();

-- ── 6. RLS (privacidade por usuário garantida NO BANCO) ──
-- Premissa: só gente logada (Auth) acessa; app usa anon key + login.
-- demandas: admin vê tudo; usuário vê SÓ disponíveis + própria caixa
-- (vale para SELECT e UPDATE; INSERT/DELETE só admin).
-- quarentena/reprovadas/importacoes: só admin. Sem login = sem acesso.
alter table demandas enable row level security;
alter table quarentena enable row level security;
alter table reprovadas enable row level security;
alter table importacoes enable row level security;
alter table profiles enable row level security;

drop policy if exists "auth_all_demandas" on demandas;
-- Admin: acesso total (inclusive importar e ver a caixa de todos).
drop policy if exists "admin_all_demandas" on demandas;
create policy "admin_all_demandas" on demandas
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
-- Usuário: lê SÓ disponíveis (sem responsável) + a própria caixa.
-- (Nem a lista, nem a quantidade dos outros é visível no banco.)
drop policy if exists "member_read_demandas" on demandas;
create policy "member_read_demandas" on demandas
  for select to authenticated
  using (responsavel is null or lower(responsavel) = lower(auth.jwt()->>'email'));
-- Usuário: pode PEGAR (assumir disponível), trabalhar na sua e LIBERAR.
-- Não insere (import é só-admin) nem apaga.
drop policy if exists "member_update_demandas" on demandas;
create policy "member_update_demandas" on demandas
  for update to authenticated
  using (responsavel is null or lower(responsavel) = lower(auth.jwt()->>'email'))
  with check (responsavel is null or lower(responsavel) = lower(auth.jwt()->>'email'));

drop policy if exists "auth_all_quarentena" on quarentena;
drop policy if exists "admin_all_quarentena" on quarentena;
create policy "admin_all_quarentena" on quarentena
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "auth_all_reprovadas" on reprovadas;
drop policy if exists "admin_all_reprovadas" on reprovadas;
create policy "admin_all_reprovadas" on reprovadas
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "auth_all_importacoes" on importacoes;
drop policy if exists "admin_all_importacoes" on importacoes;
create policy "admin_all_importacoes" on importacoes
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "auth_read_profiles" on profiles;
create policy "auth_read_profiles" on profiles
  for select to authenticated using (true);

drop policy if exists "auth_update_own_profile" on profiles;
create policy "auth_update_own_profile" on profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Promover a admin / criar contas: faça no Dashboard
-- Authentication → Users → Add user, depois Table Editor → profiles → role='admin'.
-- (Permitir update de role pelo app exigiria service_role; de propósito só leitura+self aqui.)
