# Subir o banco no site (Supabase) — passo a passo

> Por que: hoje o banco é `localStorage` (só no seu navegador). Para
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
   `reprovadas`, `importacoes`, `profiles`.

## 3. Criar os logins (6 admins + 10 usuários)

1. **Authentication → Users → Add user → Create new user**:
   - crie primeiro o seu admin (ex: `voce@empresa.com`), marque
     **Auto Confirm user** → **Create user**.
2. **Table Editor → profiles**: ache a linha desse e-mail e troque
   `role` para `admin` (o 1º signup já nasce admin pelo trigger; os
   seguintes nascem `usuario` — promova mais 5 a `admin` aqui).
3. Repita **Add user** para as outras ~15 contas (ou passe o link e peça
   para cada um fazer **Sign up** — o perfil nasce sozinho como `usuario`).
4. Habilite provedor e-mail/senha (já vem habilitado por padrão em
   **Authentication → Providers → Email**).

## 4. Ligar o site no banco (2 min)

1. Abra `js/config.js` e preencha:
   ```js
   var SAD_CONFIG = {
     SUPABASE_URL: "https://xyzcompany.supabase.co",
     SUPABASE_ANON_KEY: "eyJ..."
   };
   ```
2. Commit + push. O próximo deploy do site já usa o banco nuvem.
   > Enquanto `SUPABASE_URL` estiver vazio, o app segue em modo local
   > (bom para testar sem internet).

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

- `js/config.js` — URL + anon key.
- `js/auth.js` — hoje local (`sad_users_v1`); com Supabase, trocar
  `signIn/requireAuth/isAdminEmail` por `supabase-js` Auth + leitura de
  `profiles.role` (o schema e as policies já estão prontos).
- `js/app.js` — `loadDB/saveDB` hoje falam com `localStorage`; a troca é
  ler/gravar em `demandas/quarentena/reprovadas/importacoes` com paginação
  (o formato dos objetos já é 1:1 com as colunas).
- Quota local (~5 MB) deixa de ser problema após migrar.

## 8. Checklist de aceite

- [ ] SQL rodou sem erro; 5 tabelas visíveis.
- [ ] 6 admins com `profiles.role='admin'`.
- [ ] `js/config.js` preenchido e site no ar abre `login.html`.
- [ ] Importação de teste: 2ª importação **não zerou** a caixa.
- [ ] Quarentena: **Apagar TUDO** pede dupla confirmação e não toca a caixa.
- [ ] Caixa: clique em **DATA SOL** alterna antigas ↔ novas.
