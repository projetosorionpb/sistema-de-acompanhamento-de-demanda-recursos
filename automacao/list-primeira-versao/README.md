# LIST · Data da 1ª versão da OS (SharePoint)

Automação em JavaScript que lê a lista **Gerenciador de Obras** no SharePoint e
extrai **a data da primeira versão (v1.0) de cada OS** — podendo **publicar
direto no site** (Supabase) ou exportar CSV.

> A página salva em `LIST/` é só o *shell* da lista: os itens chegam por REST
> depois que a página abre. Por isso o script precisa rodar **na página da lista
> logada**, não no arquivo `.html` salvo.

## Como rodar

### Opção A — console do navegador (mais rápido)

1. Abra a lista no SharePoint logado (`.../Lists/Gerenciador de Obras` → **Todos os itens**).
2. `F12` → aba **Console**.
3. Cole o conteúdo de `list-primeira-versao.user.js` inteiro e dê Enter.
   * Se o Chrome bloquear o paste, digite `allow pasting` e Enter, depois cole.
4. Rode:

```js
LPV.executar();          // todas as OS
LPV.uma('123456');       // só uma OS
```

O CSV é baixado automaticamente e o resultado também fica em `LPV.estado.linhas`.

### Opção B — Tampermonkey (uso repetido)

1. Instale a extensão **Tampermonkey**.
2. **Criar novo script** → cole o arquivo `list-primeira-versao.user.js` → salve.
3. Abra a lista do SharePoint; no console aparecerá a mensagem `Pronto. Rode LPV.executar()`.

### Opção C — bookmarklet (clique único, sem instalar nada)

1. Abra `instalar-bookmarklet.html` no navegador.
2. Há **dois botões**:
   - **Conector LIST** — envia as OS para o site (tela **LIST**), sem CSV;
   - **Data da 1ª versão (CSV)** — só baixa o CSV.
3. Arraste o botão desejado para a barra de favoritos (ou copie o código e cole na URL de um favorito).
4. Abra a lista no SharePoint logado e clique no favorito.

O bookmarklet é gerado a partir do userscript (fonte única):

```bat
node automacao/list-primeira-versao/build-bookmarklet.js
```

Isso reescreve `bookmarklet.txt`, `conector.txt` e `instalar-bookmarklet.html`.
Se a política de segurança da página bloquear o favorito, use o console (Opção A).

## Conectar ao site (sem CSV)

O navegador não consegue chamar o SharePoint a partir do site (CORS + sessão do
M365). Por isso o **conector roda na página da lista** e grava no Supabase; o site
(admin) só lê a tabela.

1. No Supabase, rode **`docs/CONEXAO_LIST.sql`** (SQL Editor) uma vez.
2. No site, entre como **admin** → **LIST** → **Gerar token (24h)** e copie.
3. Abra a lista no SharePoint e clique no favorito **Conector LIST** (ou rode no console):
   ```js
   LPV.publicar();
   ```
   Cole o token quando ele pedir (fica guardado no navegador até expirar).
4. O conector grava os itens + a data da 1ª versão em `list_itens` e avisa ao terminar.
5. Volte ao site → **LIST** → **Atualizar**. A tela mostra as OS, a 1ª versão, a
   última modificação e os filtros; o botão **Usar na comparação** joga essa base
   na importação (sem upload de CSV).

O conector também **remove da base as OS que não estão mais na lista** (quando a
extração é completa, sem filtro/limite) — a tela sempre reflete o SharePoint.

Segurança: a `anon key` é pública por design; a escrita só é aceita pela função
`publicar_list()`, que exige o token válido. A tabela `list_itens` é somente-admin.

## Configuração (`LPV.CFG`)

| Chave | Padrão | Para que serve |
|---|---|---|
| `modo` | `'auto'` | `auto` / `criado` / `versoes` / `ambos` — ver abaixo |
| `campoOS` | `''` | `''` detecta sozinho (OS, NUMOS, Nº OS…); senão use o *InternalName* |
| `filtroOS` | `''` | `'123'`, `'123,456'` ou regex `/^12/` |
| `limite` | `0` | limita a quantidade de itens (0 = todos) |
| `tamanhoPagina` | `500` | itens por requisição (paginação por `Id gt`, máx. 5.000) |
| `concorrencia` | `6` | requisições simultâneas ao histórico |
| `conferirAmostra` | `15` | no modo `criado`, quantos itens conferir contra `/versions` |
| `fuso` | `America/Sao_Paulo` | fuso usado para montar a data |
| `csvSeparador` | `';'` | Excel pt-BR |
| `baixarCSV` / `baixarJSON` | `true` / `false` | exportações |
| `nomeArquivo` | `primeira-versao-os` | prefixo do arquivo |
| `supabaseUrl` / `supabaseKey` | projeto do site | usados por `LPV.publicar()` (a anon key é pública) |
| `tamanhoLote` | `400` | itens por chamada ao publicar (mínimo 50) |

Exemplo:

```js
LPV.CFG.modo = 'versoes';
LPV.CFG.filtroOS = '123456';
LPV.executar();
```

## Modos

- **`criado` (rápido — padrão em listas grandes):** lê o campo `Created` do item.
  No SharePoint, a versão 1.0 é criada junto com o item, então `Created` **é** a
  data da primeira versão. São ~1 requisição por 500 itens (7 mil itens ≈ 15
  requisições). O script ainda confere uma amostra contra o histórico real e
  avisa se houver divergência.
- **`versoes` (exato):** busca `/_api/.../items(<id>)/versions` de cada item e
  usa o `Created` da versão `1.0`. Em listas grandes isso é 1 requisição por
  item — pode demorar e sofrer *throttling* (o script respeita `Retry-After`).
- **`ambos`:** busca o histórico de todos e compara com `Created`, mostrando
  divergências. Bom para auditar se a lista foi migrada/copiada.
- **`auto`:** `ambos` até 400 itens; acima disso, `criado` + amostra.

## Saída

CSV com `;` e BOM (abre certo no Excel pt-BR):

| Coluna | Conteúdo |
|---|---|
| `OS` | número da OS (coluna detectada) |
| `ItemID` | ID do item na lista |
| `DataPrimeiraVersao` | `AAAA-MM-DD` (fuso local) |
| `DataPrimeiraVersaoBR` | `DD/MM/AAAA` |
| `HoraPrimeiraVersao` | `HH:MM:SS` |
| `RotuloVersao` | `1.0` |
| `OrigemData` | `Histórico de versões` ou `Campo Criado do item` |
| `TotalVersoes` / `VersaoAtual` | preenchidos nos modos que leem histórico |
| `CriadoUTC` / `ModificadoUTC` | carimbos originais do SharePoint |
| `ModificadoBR` | última modificação |
| `CODSERV`, `DESCRICAO`, `LOCAL`, `REGIONAL`, `SOLICITACAO`, `STATUS`, `TELEFONE` | dados da LIST usados na comparação e na tela LIST |

## Listas grandes (limite de 5.000 itens)

O SharePoint bloqueia consultas que passam do **limite de exibição da vista**
(5.000 itens) com `SPQueryThrottledException`:
*"A operação tentada não é permitida porque excede o limiar da vista de lista."*

Por isso o script **não** usa `$top` + `$orderby=Id` sozinho. Ele pagina por
**cursor de Id** (`$filter=Id gt <último>&$orderby=Id asc&$top=500`), que usa o
índice da lista e atravessa o limite. Se ainda assim a consulta for barrada, ele
reduz a página para 100 e continua do mesmo ponto automaticamente.

> Listas de exemplo: 7.098 itens → ~15 requisições de 500 em 500.

## Observações

- Precisa de permissão de leitura na lista; o histórico exige “Exibir versões”
  (padrão para membros).
- O SharePoint limita requisições por usuário; o script espera e repete em
  `429/503`. Se abusar no modo `versoes`, reduza `concorrencia`.
- `Created` e o `Created` da versão 1.0 são iguais em itens criados direto na
  lista. Se a lista foi **migrada/copiada**, ambos podem refletir a data da
  cópia — nesse caso a data original não existe no SharePoint.
- Se o versionamento da lista estiver **desligado**, o script avisa e usa o
  campo `Created` do item automaticamente.
- `LPV.parar()` interrompe após as requisições em andamento.
