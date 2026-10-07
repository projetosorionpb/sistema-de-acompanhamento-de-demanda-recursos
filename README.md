# Sistema de Acompanhamento de Demanda

Repositório: https://github.com/projetosorionpb/sistema-de-acompanhamento-de-demanda-recursos.git

## O que é

Conciliação **SIATE × LIST** pela chave **NUMOS exata**:
- **Congruentes** (nas 2 bases) → **caixa principal**, usuários pegam e trabalham (status: `A INICIAR`, `EM ANDAMENTO`, `PENDENTE`, `ENCERRADO`)
- **Divergentes** (só em uma) → **quarentena**, admin **aprova** (→ caixa) ou **reprova**

Identidade visual igual ao `carregamentoepdpb` (dark/light, laranja `#f0a500`, DM Sans + Space Mono).

## Bases reais (commit `59ec9e7`)

| Base | Arquivo em `BASE/` | Linhas | OS distintas |
|------|--------------------|---------|--------------|
| SIATE | `LISTA OS (1).xls` (aba `LISTA OS`, 79 col) | 19.006 | 19.006 |
| LIST | `Gerenciador de Obras (7).csv` | 6.033 | 5.928 |

Resultado da comparação exata por NUMOS: **1.200 congruentes**, 17.806 só-SIATE, 4.728 só-LIST.

Campos SIATE que importam: `CODSERV`, `NUMOS`, `DATASOL`, `CODREG` (1=LESTE, 2=CENTRO, 3=OESTE), `OBSOS`, `NOMELCD` (cidade), `NOMECLI`, `NUMTEL`.

## Como rodar (MVP local, sem build)

```bat
cd D:\projetos\sistema-de-acompanhamento-de-demanda-recursos
python -m http.server 8080
```

Abrir `http://localhost:8080/login.html`:
- admin → `admin@sistema` / `admin123` (importa, aprova quarentena)
- equipe → `equipe@sistema` / `equipe123` (caixa principal)

Fluxo admin: subir SIATE + LIST → ajustar **filtros** (regional, codserv, cidade, período) → **Comparar bases** → **Jogar no banco** (filtros valem p/ principal; quarentena recebe tudo) → gerenciar quarentena e caixa.

## Estrutura

```
├── index.html          # app (upload, filtros, resumo, caixa, quarentena)
├── login.html          # login demo
├── css/style.css       # identidade (mesmas vars do carregamentoepdpb)
├── js/theme.js         # dark/light (key sad-theme)
├── js/auth.js          # demo local (plugável Supabase)
├── js/app.js           # parse SheetJS, sanitiza, compara NUMOS, banco localStorage
├── BASE/               # bases de exemplo (do remoto)
├── docs/BRIEFING.md
├── docs/SUPABASE_SCHEMA.sql  # tabelas futuras
└── data/               # (legado) usar BASE/
```

Banco atual: `localStorage sad_db_v1`. Schema produtivo em `docs/SUPABASE_SCHEMA.sql`.
