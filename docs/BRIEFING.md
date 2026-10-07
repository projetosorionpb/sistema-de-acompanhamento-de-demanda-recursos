# Briefing — Sistema de Acompanhamento de Demanda (v2, com dados reais)

## 1. Bases
- **SIATE** = `BASE/LISTA OS (1).xls` (aba `LISTA OS`, 19.006 linhas, 79 colunas, 19.006 NUMOS distintas)
- **LIST** = `BASE/Gerenciador de Obras (7).csv` (6.033 linhas, 5.928 OS distintas)

## 2. Campos SIATE que importam
| Campo | Coluna | Tratamento |
|-------|--------|------------|
| CODSERV | `codserv` | inteiro (string) |
| NUMOS | `numos` | **chave** — só dígitos, exato |
| DATASOL | `datasol` | serial Excel → ISO `yyyy-mm-dd` (ou dd/mm/yyyy) |
| CODREG | `codreg` | 1=LESTE, 2=CENTRO, 3=OESTE |
| OBSOS | `obsos` | texto, máx 500 |
| NOMELCD | `nomelcd` | cidade, UPPER/trim |
| NOMECLI | `nomecli` | nome cliente |
| NUMTEL | `numtel` (+`numtel2`) | só dígitos |

LIST: chave `OS` normalizada igual; mantém codserv, descrição, local, regional, solicitação, status origem, telefone.

## 3. Regra de comparação
**Exatamente o NUMOS** (string de dígitos, sem tolerância).

Medido nas bases de exemplo: **1.200 congruentes**, 17.806 só-SIATE, 4.728 só-LIST.

## 4. Fluxo
```
Admin baixa as 2 bases e sobe no site
  → site sanitiza (remove sem-NUMOS e duplicadas, log)
  → pergunta filtros antes de gravar (regional, codserv, cidade, período datasol)
  → compara NUMOS exato, avisa totais
  → [Jogar no banco]
      congruentes (filtradas) → CAIXA PRINCIPAL (status inicial A INICIAR)
      divergentes (todas)     → QUARENTENA (SO_SIATE / SO_LIST + motivo)
Usuários pegam da caixa → assumem (vira EM ANDAMENTO) → atualizam status
Admin na quarentena → APROVAR (vai p/ caixa, A INICIAR) ou REPROVAR (arquiva)
```

## 5. Status da demanda
`A INICIAR` → `EM ANDAMENTO` → `PENDENTE` / `ENCERRADO` (troca livre pelo usuário na caixa).

## 6. Perfis
- **admin**: upload, filtros, comparar, jogar no banco, aprovar/reprovar quarentena, tudo da caixa.
- **usuario**: só caixa principal (pegar/liberar, trocar status), quarentena somente leitura.

## 7. Identidade visual
Igual ao `carregamentoepdpb`: header fixo + badge, toggle dark/light, botão gradiente `#f0a500→#ff6b35`, cards `panel`, badges, tabelas, footer “Feito por Valdeci Nunes”, fontes DM Sans + Space Mono.

## 8. Estado técnico (MVP)
- Estático, sem build: `index.html`, `login.html`, `css/`, `js/` + SheetJS CDN.
- Banco local `localStorage sad_db_v1`; schema Supabase futuro em `docs/SUPABASE_SCHEMA.sql`.
- Login demo local em `js/auth.js` (trocar pelo Supabase depois — ver `carregamentoepdpb/js/auth.js`).
