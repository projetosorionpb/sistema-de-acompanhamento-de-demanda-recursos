# Sistema de Acompanhamento de Demanda

Repositório: https://github.com/projetosorionpb/sistema-de-acompanhamento-de-demanda-recursos.git

## O que é

Conciliação **SIATE × LIST** pela chave **NUMOS exata**:
- **Congruentes** (nas 2 bases) → **caixa principal**, usuários pegam e trabalham (status: `A INICIAR`, `EM ANDAMENTO`, `OCORRENCIA`, `ENCERRADO`). Encerradas saem da caixa e vão para a tela **Encerrados**; ao marcar **Ocorrência**, abre um modal para o motivo.
- **Divergentes** (só em uma) → **quarentena**, admin **aprova** (→ caixa) ou **reprova**

Identidade visual: SaaS empresarial (dark/light, laranja `#f0a500`, Inter + Space Mono), ícones **SVG** (sem emojis).

## Bases reais (commit `59ec9e7`)

| Base | Arquivo em `BASE/` | Linhas | OS distintas |
|------|--------------------|---------|--------------|
| SIATE | `LISTA OS (1).xls` (aba `LISTA OS`, 79 col) | 19.006 | 19.006 |
| LIST | `Gerenciador de Obras (7).csv` | 6.033 | 5.928 |

Resultado da comparação exata por NUMOS: **1.200 congruentes**, 17.806 só-SIATE, 4.728 só-LIST.

Campos SIATE que importam: `CODSERV`, `NUMOS`, `DATASOL`, `CODREG` (1=LESTE, 2=CENTRO, 3=OESTE), `OBSOS`, `NOMELCD` (cidade), `NOMECLI`, `NUMTEL`.

## Como rodar

Banco e login são **somente Supabase** (nuvem). Antes de rodar, siga `docs/DEPLOY_SUPABASE.md`:
criar projeto, rodar o SQL e preencher `js/config.js`.

```bat
cd D:\projetos\sistema-de-acompanhamento-de-demanda-recursos
python -m http.server 8080
```

Abrir `http://localhost:8080/login.html` e entrar com uma conta criada em
**Supabase → Authentication → Users** (o papel vem de `profiles.role`).

Fluxo admin: subir SIATE + LIST → ajustar **filtros** (regional, codserv, cidade, período) → **Comparar bases** → **Jogar no banco** (incremental: soma sem apagar; preserva status/responsável; reprovada não volta; quarentena virada congruente é promovida) → gerenciar quarentena e caixa.

## Novidades

- **Quarentena em massa (admin):** Aprovar filtrados → caixa, Apagar filtrados, Apagar TUDO (dupla confirmação; arquiva como reprovada p/ não voltar; caixa nunca é tocada).
- **Duplicadas na importação:** OS congruente que **já está na caixa** vai para a quarentena como **JÁ NA CAIXA** para o admin revisar (opção “Já está na caixa → quarentena”, pode desmarcar para só ignorar).
- **Caixa individual + privacidade:** usuário trabalha em **Minha caixa** × **Disponíveis**; ninguém (exceto admin) vê nem as OS nem as quantidades dos outros. Métrica própria de **encerradas hoje** na caixa; admin vê **Hoje ✅ / Em mãos / Total** por pessoa em Acompanhar usuários.
- **Métricas (admin):** nova tela **📈 Métricas** — encerradas por usuário e por dia em Hoje, Últimos 7/30 dias, Este mês ou período personalizado, com export CSV. A prévia do Comparar bases agora avisa **vítimas do filtro** e **quarentena zerada suspeita** (mesmo arquivo nos 2 campos).
- **Conflitos SIATE×LIST:** OS nas duas bases com **serviço diferente** não vai direto p/ caixa — abre **modal** de incongruências e vai para a aba **⚔️ Conflitos** da quarentena, com valores lado a lado e botões **P/ caixa (SIATE)** / **P/ caixa (LIST)** / Reprovar. Abas separadas: Conflitos, Só SIATE, Só LIST, Já na caixa.
- **Distribuição automática (admin):** tela **Distribuição** — ativa/desativa, cota padrão igual p/ todos + cota individual por usuário (0 pula). Quem zera as abertas recebe sozinho (mais antigas primeiro): no login, na importação e ao encerrar a última. Admins não recebem.
- **Ordenação da caixa:** select + clique no cabeçalho **NUM OS / DATA SOL** (mais antigas ↔ mais novas) — ideal p/ importação diária.
- **Multiusuário (Supabase):** login e dados **somente na nuvem** — todos veem a mesma caixa/quarentena. Contas e papéis são geridos no Dashboard (**Authentication → Users** e **Table Editor → profiles**). Sem logins demo e sem dados no navegador.
- **Banco compartilhado (Supabase):** `js/db.js` carrega as tabelas em cache e grava por diff (INSERT/UPDATE/DELETE, em lotes). Se a nuvem não responder, o app avisa e **não** grava localmente. O topo mostra **☁ Compartilhado** (ou ⚠ Sem banco / ⚙ Não configurado).

## Estrutura

```
├── index.html          # app (upload, filtros, resumo, caixa, quarentena)
├── login.html          # login (Supabase Auth + demos locais)
├── css/style.css       # UI SaaS empresarial (dark/light, sem emojis)
├── js/theme.js         # dark/light (key sad-theme)
├── js/icons.js         # ícones SVG (SADICON) — substituem emojis
├── js/auth.js          # login Supabase (roles em profiles)
├── js/db.js            # camada de dados: Supabase (somente nuvem)
├── js/config.js        # SUPABASE_URL + ANON_KEY (obrigatório)
├── js/app.js           # parse SheetJS, sanitiza, compara NUMOS, caixa, quarentena
├── BASE/               # bases de exemplo (locais; fora do Git/deploy)
├── docs/BRIEFING.md
├── docs/SUPABASE_SCHEMA.sql  # tabelas produtivas
└── data/               # (legado) usar BASE/
```

Banco e login: **Supabase** (somente nuvem) — todos veem a mesma caixa.
Schema em `docs/SUPABASE_SCHEMA.sql` + passo a passo em `docs/DEPLOY_SUPABASE.md`.
