-- ══════════════════════════════════════════════════════════════
-- Conexão LIST (SharePoint) → Supabase → site de acompanhamento
-- Aplicar no Supabase: SQL Editor → New query → colar → Run.
-- Idempotente: pode rodar de novo sem apagar dados.
--
-- Como funciona:
--   1) O admin gera um token no site (tela LIST).
--   2) O conector (bookmarklet/Tampermonkey) roda na página da lista do
--      SharePoint, lê os itens + a data da 1ª versão e chama a função
--      publicar_list() com esse token.
--   3) O site (admin) lê a tabela list_itens e mostra a tela LIST.
--
-- Segurança: list_itens é somente-admin. A escrita é feita apenas pela
-- função publicar_list(), que exige um token válido e não expirado.
-- ══════════════════════════════════════════════════════════════

-- ── 1. Snapshot da LIST ─────────────────────────────────────────
create table if not exists public.list_itens (
  numos text primary key,
  item_id bigint,
  codserv text,
  descricao text,
  local text,
  regional text,
  solicitacao text,
  solicitacao_iso date,
  status_origem text,
  telefone text,
  data_primeira_versao date,
  primeira_versao_em timestamptz,
  modificado_em timestamptz,
  run_id uuid,
  atualizado_em timestamptz not null default now()
);

-- Migração para bancos já criados.
alter table public.list_itens add column if not exists run_id uuid;

create index if not exists idx_list_itens_pv on public.list_itens(data_primeira_versao);
create index if not exists idx_list_itens_mod on public.list_itens(modificado_em);
create index if not exists idx_list_itens_reg on public.list_itens(regional);
create index if not exists idx_list_itens_local on public.list_itens(local);

-- ── 2. Tokens de conexão (gerados no site, 24h) ─────────────────
create table if not exists public.list_conexao_tokens (
  token uuid primary key,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  criado_por uuid,
  usado_em timestamptz
);

-- ── 3. RLS: leitura/gestão só para admin; escrita só via RPC ────
-- public.is_admin() vem do SUPABASE_SCHEMA.sql; recriada aqui para este
-- arquivo funcionar sozinho.
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

alter table public.list_itens enable row level security;
alter table public.list_conexao_tokens enable row level security;

drop policy if exists "admin_all_list_itens" on public.list_itens;
create policy "admin_all_list_itens" on public.list_itens
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admin_all_list_tokens" on public.list_conexao_tokens;
create policy "admin_all_list_tokens" on public.list_conexao_tokens
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ── 4. Publicação (usada pelo conector na página do SharePoint) ──
create or replace function public.publicar_list(p_token uuid, p_itens jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_linhas int := 0;
begin
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then
    raise exception 'Payload inválido: esperado um array de itens.';
  end if;

  if p_token is null or not exists (
    select 1 from public.list_conexao_tokens t
     where t.token = p_token
       and t.expira_em > now()
  ) then
    raise exception 'Token de conexão inválido ou expirado. Gere outro na tela LIST.'
      using errcode = '28000';
  end if;

  with entrada as (
    select
      nullif(trim(coalesce(x ->> 'numos', '')), '')                    as numos,
      nullif(x ->> 'item_id', '')::bigint                              as item_id,
      nullif(x ->> 'codserv', '')                                      as codserv,
      nullif(x ->> 'descricao', '')                                    as descricao,
      nullif(x ->> 'local', '')                                        as local,
      nullif(x ->> 'regional', '')                                     as regional,
      nullif(x ->> 'solicitacao', '')                                  as solicitacao,
      nullif(x ->> 'solicitacao_iso', '')::date                        as solicitacao_iso,
      nullif(x ->> 'status_origem', '')                                as status_origem,
      nullif(x ->> 'telefone', '')                                     as telefone,
      nullif(x ->> 'data_primeira_versao', '')::date                   as data_primeira_versao,
      nullif(x ->> 'primeira_versao_em', '')::timestamptz              as primeira_versao_em,
      nullif(x ->> 'modificado_em', '')::timestamptz                   as modificado_em,
      nullif(x ->> 'run_id', '')::uuid                                 as run_id
    from jsonb_array_elements(p_itens) x
  ),
  -- A LIST pode ter mais de um item com a mesma OS. A chave do sistema é o
  -- NUMOS, então consolidamos em uma linha: fica o item com a 1ª versão mais
  -- antiga (e, em empate, o menor Id). Sem isso, o ON CONFLICT falha quando o
  -- mesmo numos aparece duas vezes no mesmo lote.
  unica as (
    select distinct on (numos) *
    from entrada
    where numos is not null
    order by numos, primeira_versao_em nulls last, item_id nulls last
  )
  insert into public.list_itens (
    numos, item_id, codserv, descricao, local, regional,
    solicitacao, solicitacao_iso, status_origem, telefone,
    data_primeira_versao, primeira_versao_em, modificado_em, run_id, atualizado_em
  )
  select
    numos, item_id, codserv, descricao, local, regional,
    solicitacao, solicitacao_iso, status_origem, telefone,
    data_primeira_versao, primeira_versao_em, modificado_em, run_id, now()
  from unica
  on conflict (numos) do update set
    item_id              = excluded.item_id,
    codserv              = excluded.codserv,
    descricao            = excluded.descricao,
    local                = excluded.local,
    regional             = excluded.regional,
    solicitacao          = excluded.solicitacao,
    solicitacao_iso      = excluded.solicitacao_iso,
    status_origem        = excluded.status_origem,
    telefone             = excluded.telefone,
    data_primeira_versao = excluded.data_primeira_versao,
    primeira_versao_em   = excluded.primeira_versao_em,
    modificado_em        = excluded.modificado_em,
    run_id               = excluded.run_id,
    atualizado_em        = now();

  get diagnostics v_linhas = row_count;

  update public.list_conexao_tokens
     set usado_em = now()
   where token = p_token;

  return jsonb_build_object('ok', true, 'linhas', v_linhas, 'total', jsonb_array_length(p_itens));
end;
$$;

-- O conector roda no domínio do SharePoint, sem login Supabase:
-- ele usa a anon key + o token acima. A função é SECURITY DEFINER.
revoke all on function public.publicar_list(uuid, jsonb) from public;
grant execute on function public.publicar_list(uuid, jsonb) to anon, authenticated;

-- ── 5. Finalização: remove itens que não vieram nesta execução ──
-- Chamada uma vez, ao final, com o run_id usado nos lotes. Mantém a base
-- exatamente igual à lista do SharePoint (sem OS antigas esquecidas).
create or replace function public.finalizar_list(p_token uuid, p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_apagadas int := 0;
begin
  if p_token is null or not exists (
    select 1 from public.list_conexao_tokens t
     where t.token = p_token
       and t.expira_em > now()
  ) then
    raise exception 'Token de conexão inválido ou expirado. Gere outro na tela LIST.'
      using errcode = '28000';
  end if;

  if p_run is null then
    raise exception 'run_id obrigatório.';
  end if;

  delete from public.list_itens where run_id is distinct from p_run;
  get diagnostics v_apagadas = row_count;

  update public.list_conexao_tokens set usado_em = now() where token = p_token;

  return jsonb_build_object('ok', true, 'apagadas', v_apagadas);
end;
$$;

revoke all on function public.finalizar_list(uuid, uuid) from public;
grant execute on function public.finalizar_list(uuid, uuid) to anon, authenticated;

-- Recarrega o cache de schema do PostgREST (garante as RPCs disponíveis).
notify pgrst, 'reload schema';
