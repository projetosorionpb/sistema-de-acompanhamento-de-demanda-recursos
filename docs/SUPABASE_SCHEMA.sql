-- Supabase (futuro) — espelha o banco local atual (localStorage sad_db_v1)
-- Caixa principal: congruentes + quarentena aprovada
-- Quarentena: divergentes | Status: A INICIAR, EM ANDAMENTO, PENDENTE, ENCERRADO

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
  created_at timestamptz default now()
);
create index if not exists idx_demandas_status on demandas(status_demanda);
create index if not exists idx_demandas_reg on demandas(codreg);
create index if not exists idx_demandas_cidade on demandas(cidade);

create table if not exists quarentena (
  id bigint generated always as identity primary key,
  numos text not null,
  origem text not null check (origem in ('SO_SIATE','SO_LIST')),
  motivo text,
  dados jsonb,
  created_at timestamptz default now(),
  unique(numos, origem)
);
create index if not exists idx_quar_origem on quarentena(origem);

create table if not exists importacoes (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  filtros jsonb,
  cong_total int,
  novas_principal int,
  novas_quarentena int
);
