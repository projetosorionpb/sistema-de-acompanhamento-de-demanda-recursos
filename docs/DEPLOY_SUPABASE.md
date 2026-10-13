# Subir o banco no site (Supabase) — passo a passo

> Por que: login e banco são **somente na nuvem**. Para
> **10 usuários + 6 admins** usarem o **mesmo site** com a **mesma caixa**,
> é preciso um banco na nuvem. O projeto já está pronto para o Supabase
> (gratuito e suficiente para esse porte).

## 1. Criar o projeto (10 min)

1. Acesse <https://supabase.com> → **Start your project** → crie conta.
2. **New project** → nome `demanda-orion` → senha do banco (guarde) → região
   `South America (São Paulo)` → **Create new project** (aguarda ~2 min).
3. No projeto: **Project Settings (⚙) → API**:
   - anote **Project URL** (`https://xyzcompany.supabase.co`)
   - anote **anon public key** (`eyJ...` longa).

## 2. Criar as tabelas (5 min)

1. No menu lateral: **SQL Editor → New query**.
2. Abra o arquivo `docs/SUPABASE_SCHEMA.sql` deste repo, copie **tudo**,
   cole no editor e clique **Run** (deve dar *Success*).
3. Confira em **Table Editor**: existem `demandas`, `quarentena`,
   `reprovadas`, `importacoes`, `profiles`, `config`.

## 3. Criar os logins

1. Crie **o primeiro admin** em **Authentication → Users → Add user**
   (ex: `voce@empresa.com`), marque **Auto Confirm user** → **Create user**.
   O perfil nasce sozinho; o primeiro usuário vira `admin` pelo trigger.
2. Abra o site logado como esse admin → **Acompanhar usuários**:
   - **Criar**: informe e-mail, senha e o papel (admin/usuário) → **Criar**.
   - **tornar admin / tornar usuário**: troca o papel de qualquer conta.
   > Excluir conta: **Supabase → Authentication → Users**.
3. Para o **Criar pelo site** funcionar, em **Authentication → Providers → Email**:
   - mantenha **Enable sign ups** ligado;
   - idealmente **desligue "Confirm email"** para o usuário entrar na hora.
     (Se ligado, o app avisa que o usuário precisa confirmar o e-mail.)

> Alternativa sem o site: **Authentication → Users → Add user** e ajuste
> `profiles.role` no Table Editor.

## 4. Ligar o site no banco (2 min)

1. Abra `js/config.js` e preencha:
   ```js
   var SAD_CONFIG = {
     SUPABASE_URL: "https://xyzcompany.supabase.co",
     SUPABASE_ANON_KEY: "eyJ..."
   };
   ```
2. Commit + push. O próximo deploy do site já usa o banco nuvem.
   > `SUPABASE_URL` vazio = app não funcional (sem login/banco). É obrigatório.

## 5. Publicar o site (escolha uma)

**Opção A — GitHub Pages (mais simples, grátis):**

```bat
git add -A
git commit -m "liga supabase + ordenacao + quarentena em massa"
git push origin main
```

No GitHub: **Settings → Pages → Deploy from branch → `main` / root**.
URL sai como `https://<org>.github.io/<repo>/` — abra `/login.html`.

**Opção B — Vercel/Netlify:** suba a pasta como site estático
(sem build; só arquivos). Não precisa de variável de ambiente —
a config já vai no `js/config.js`.

## 6. Rotina diária (importação incremental)

1. Admin baixa SIATE + LIST do dia → **Importar bases** → sobe os 2 arquivos.
2. Ajusta filtros → **Comparar bases** → confere totais.
3. **Jogar no banco**:
   - **soma, nunca apaga**: caixa existente preservada (status/responsável);
   - reprovada **não volta**; OS da quarentena que virou congruente é
     **promovida** sozinha para a caixa;
   - com a opção **“Já está na caixa → quarentena”** marcada (padrão), OS
     repetida vai para a quarentena como **JÁ NA CAIXA** para revisão —
     desmarque para só ignorar repetidas.
4. Quarentena: **Aprovar filtrados** / **Apagar filtrados** / **Apagar TUDO**
   (apagar arquiva como reprovada).
5. Caixa: ordene por **Data SOL · mais novas/antigas** (select ou clique no
   cabeçalho `NUM OS` / `DATA SOL`).
6. Equipe: cada usuário pega OS em **Disponíveis** → trabalha em
   **Minha caixa** → marca **ENCERRADO** (conta na métrica do dia).
   Ninguém vê a caixa alheia; admin acompanha tudo em
   **Acompanhar usuários** (Hoje ✅ / Em mãos / Total por pessoa) e
   **📈 Métricas** (dia/semana/mês/personalizado + CSV).
   OS com serviço diferente entre as bases cai na aba **⚔️ Conflitos**
   (revisar e liberar pelo lado SIATE ou LIST).
7. **Distribuição automática** (opcional): em **🚚 Distribuição**, ative e
   defina a cota (ex. 10 igual p/ todos ou individual por usuário).
   Quem zerar as abertas recebe sozinho as mais antigas disponíveis.

## 7. Camada de código (onde plugar)

- `js/config.js` — URL + anon key (obrigatório: login e banco são somente nuvem).
- `js/auth.js` — login Supabase Auth; papel vem de `profiles.role`. Sem contas
  locais/demo: crie em **Authentication → Users** e defina o papel em `profiles`.
- `js/db.js` **camada de dados**: carrega as tabelas para um cache em memória e
  grava por *diff* (INSERT de novas, UPDATE das alteradas, DELETE das removidas,
  em lotes de 500). **Nada é gravado no navegador**; se o Supabase falhar, o app
  avisa e não salva.
  - `demandas`: admin insere (importação); usuário faz UPDATE só na própria
    caixa/disponível (respeita o RLS).
  - `quarentena`/`reprovadas`/`importacoes`: só admin grava (RLS).
- `js/app.js` — `loadDB/saveDB` falam com `window.SADDB`; após pegar, liberar ou
  encerrar, re-busca do servidor (`refreshIfShared`) para ver a caixa atualizada.
- O topo do app mostra **☁ Compartilhado** (Supabase ativo) ou ⚠/⚙ sem banco.

## 7.1. Atualizações recentes (rode o SQL de novo)

O schema é idempotente — rode `docs/SUPABASE_SCHEMA.sql` de novo para aplicar:

- **Status `OCORRENCIA`** substitui `PENDENTE` (a constraint é migrada e as
  linhas antigas convertidas).
- Coluna **`motivo_ocorrencia`** em `demandas` (motivo digitado no modal).
- Tela **Encerrados**: OS `ENCERRADO` saem da caixa principal.
- **Usuário não pode liberar** OS — a policy `member_update_demandas` agora
  exige `responsavel = e-mail` no `WITH CHECK`.
- **Limpar banco** apaga caixa + quarentena + reprovadas + histórico de
  importações, no Supabase.

## 8. Checklist de aceite

- [ ] SQL rodou sem erro; 6 tabelas visíveis.
- [ ] Contas admin com `profiles.role='admin'`.
- [ ] `js/config.js` preenchido e site no ar abre `login.html`.
- [ ] Importação de teste: 2ª importação **não zerou** a caixa.
- [ ] Quarentena: **Apagar TUDO** pede dupla confirmação e some no Supabase.
- [ ] Encerrar uma OS: ela sai da caixa e aparece em **Encerrados**.
- [ ] Marcar **Ocorrência**: abre o modal e salva o motivo.
- [ ] Caixa: clique em **DATA SOL** alterna antigas ↔ novas.
