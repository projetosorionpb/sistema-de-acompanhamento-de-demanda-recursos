# Sistema de Acompanhamento de Demanda

Repositório: https://github.com/projetosorionpb/sistema-de-acompanhamento-de-demanda-recursos.git

## O que é

Conciliação **SIATE × LIST** pela chave **NUMOS exata**:
- **Congruentes** (nas 2 bases) → **caixa principal**, usuários pegam e trabalham (status: `A INICIAR`, `EM ANDAMENTO`). Marcar **Ocorrência** tira a OS da caixa (vai para **Ocorrências**, com motivo) e, ao **resolver** (usuário ou admin), ela volta para a caixa. **Encerrar** leva para **Encerrados**; **Despachar** leva para **Despachados**. Usuário não libera OS; admin pode retirar OS de qualquer pessoa.
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
Para usar a **LIST conectada** (admin, sem CSV), rode também `docs/CONEXAO_LIST.sql`.

```bat
cd D:\projetos\sistema-de-acompanhamento-de-demanda-recursos
python -m http.server 8080
```

Abrir `http://localhost:8080/login.html` e entrar com uma conta criada em
**Supabase → Authentication → Users** (o papel vem de `profiles.role`).

Fluxo admin: subir SIATE + LIST → ajustar **filtros** (regional, codserv, cidade, período) → **Comparar bases** → **Jogar no banco** (incremental: soma sem apagar; preserva status/responsável; reprovada não volta; quarentena virada congruente é promovida) → gerenciar quarentena e caixa.

**Regra dos filtros da comparação:** cada planilha é filtrada por regional, serviço, cidade e data. O conjunto comparado é a união dos NUMOS que passaram em pelo menos uma base; para esses NUMOS, o sistema traz também o registro correspondente da outra planilha para identificar conflitos de CODSERV. Se nenhum dos lados passar nos filtros, a OS fica fora da comparação, quarentena e banco. Com filtro de data ativo, linha sem data válida não passa.

## Novidades

- **Limpar banco com controle (admin):** ao clicar em **Limpar banco**, escolha **apagar tudo** (pede sua senha de login) ou **apagar somente filtrados**. No modo filtrado, marque/desmarque os **serviços (CODSERV)** — com **Selecionar tudo / Desmarcar tudo** — e confira a prévia de quantas OS da caixa, itens de quarentena e reprovadas serão apagados. A limpeza filtrada mantém o histórico de importações.
- **Desfazer última importação (admin):** remove o que a última importação criou e ainda está **A INICIAR** na caixa, além dos itens de **quarentena** criados nela. Preserva OS já trabalhadas, importações anteriores, reprovadas e a lista do SharePoint; depois é só reimportar com os filtros corretos.
- **LIST conectada (admin):** tela **LIST** mostra os itens do SharePoint com a **data da 1ª versão**, última modificação e filtros — inclusive **filtrar várias OS de uma vez colando a lista** (vírgula, espaço ou uma por linha), com contagem de encontradas/não encontradas. Sem upload de CSV: um conector roda na página da lista e grava no Supabase (`docs/CONEXAO_LIST.sql`); o botão **Instalar conector** na própria tela LIST abre os bookmarklets.

- **Quarentena em massa (admin):** Aprovar filtrados → caixa, Apagar filtrados, Apagar TUDO (dupla confirmação; arquiva como reprovada p/ não voltar; caixa nunca é tocada).
- **Duplicadas na importação:** OS congruente que **já está na caixa** vai para a quarentena como **JÁ NA CAIXA** para o admin revisar (opção “Já está na caixa → quarentena”, pode desmarcar para só ignorar).
- **Caixa individual + privacidade:** usuário trabalha em **Minha caixa** × **Disponíveis**; ninguém (exceto admin) vê nem as OS nem as quantidades dos outros. Métrica própria de **encerradas/despachadas hoje** na caixa; admin vê **Hoje ✅ / Em mãos / Total** por pessoa em Acompanhar usuários.
- **Métricas (admin):** tela **Métricas** com **gráficos** (evolução diária encerradas × despachadas, donut por status, barras empilhadas por usuário, por regional e top serviços) e **filtros por período** (Hoje, 7/30 dias, mês ou personalizado), **usuário**, **status da OS**, **regional** e **serviço** — com **seleção múltipla** (checkbox) em cada um. KPIs de OS no filtro, encerradas, despachadas, em mãos, ocorrências e usuários; tabelas por usuário e por dia/semana; export CSV. A prévia detalha quantas linhas passaram pelos filtros em cada base, pares incluídos para detectar divergências e OS excluídas por não passarem em nenhuma.
- **Conflitos SIATE×LIST:** OS nas duas bases com **serviço diferente** não vai direto p/ caixa — abre **modal** de incongruências e vai para a aba **⚔️ Conflitos** da quarentena, com valores lado a lado e botões **P/ caixa (SIATE)** / **P/ caixa (LIST)** / Reprovar. Abas separadas: Conflitos, Só SIATE, Só LIST, Já na caixa. **Conflitos de OS que já estão na caixa também entram na aba** (aprovar um lado atualiza os dados da OS, preservando status e responsável) e não são reabertos nas próximas importações depois de resolvidos.
- **Distribuição automática (admin):** tela **Distribuição** — ativa/desativa geral, **liga/desliga o automático por usuário** (linha **Auto**) e cota (padrão + individual; 0 pula). Quem zera as abertas recebe sozinho (mais antigas primeiro): no login, na importação e ao encerrar/despachar a última. Admins não recebem.
- **Despachados:** OS com status **DESPACHADO** saem da caixa e ficam na tela **Despachados** (cada usuário vê as suas; admin vê todas), com data do despacho e botão **Reabrir** (volta para a caixa). A tela tem **filtros por campo** (NUM OS, serviço, cliente, cidade, regional, origem, períodos de Data SOL e de despacho, responsável e quem despachou), ordenação clicável e **exportação da lista filtrada** em **CSV/XLSX**.
- **Ocorrências:** OS em ocorrência sai da caixa e fica em **Ocorrências** (com o motivo). Botão **Ocorrência resolvida** devolve à caixa (usuário responsável ou admin).
- **Admin retira OS:** no **Ver OS** (Métricas/Acompanhar) o admin tem **Retirar** — a OS volta para os disponíveis.
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
├── automacao/          # conector LIST (SharePoint) + bookmarklets
├── docs/BRIEFING.md
├── docs/SUPABASE_SCHEMA.sql  # tabelas produtivas
├── docs/CONEXAO_LIST.sql     # LIST conectada (admin, sem CSV)
└── data/               # (legado) usar BASE/
```

Banco e login: **Supabase** (somente nuvem) — todos veem a mesma caixa.
Schema em `docs/SUPABASE_SCHEMA.sql` + passo a passo em `docs/DEPLOY_SUPABASE.md`.
