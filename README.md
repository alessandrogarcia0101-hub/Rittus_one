# RITTUS ONE — pacote completo (Supabase + Vercel + GitHub)

Este pacote pega o `app.html` grande (Inspeção NR, Auditoria, PT, APR, Combate a
Incêndio, Calculadora Financeira, Documentos e Licenças, Plano de Ação, RITTUS
ID) e monta tudo o que falta para ele rodar do zero com um banco de dados de
verdade (Supabase), publicado no GitHub + Vercel — **sem mudar o visual nem o
comportamento de nenhuma tela**. Tudo o que você já conhece do app continua
igual; só o "por baixo do capô" deixou de ser o `localStorage` do navegador e
passou a ser a nuvem.

## Por que isso importava

O jeito como o app estava (`localStorage`) funciona, mas cada dado fica preso
num navegador/dispositivo só. Se você limpar o navegador, trocar de celular ou
usar de dois lugares diferentes, os dados não se encontram — e nada é
compartilhado entre a sua equipe. Com Supabase, todo mundo da mesma empresa
(organização) vê os mesmos dados, de qualquer aparelho, com login individual.

## O que foi entregue

```
├── app.html                  ← o app original, com 3 mudanças cirúrgicas (ver abaixo)
├── index.html                ← tela de login/cadastro (nova)
├── config.js                 ← ⚠️ EDITE AQUI suas credenciais do Supabase
├── supabase-bridge.js        ← a "ponte" entre o app e o Supabase (novo)
├── manifest.webmanifest      ← usado pela tela de login
├── vercel.json                ← configuração de deploy
├── .gitignore
└── sql/
    ├── 01_schema_base.sql     ← organizações, perfis, empresas, unidades, inspeção NR, plano de ação
    ├── 02_schema_modulos.sql  ← auditoria, PT, APR, combate a incêndio, calculadora, documentos, RITTUS ID
    ├── 03_rls.sql             ← segurança (cada empresa só vê os próprios dados)
    └── 04_catalogo_nr.sql     ← catálogo padrão de checklist por NR (NR-01 a NR-35)
```

### O que mudou dentro do `app.html`

Comparado ao arquivo que você me passou, só 3 coisas mudaram — nada de lógica,
nada de tela, nada de texto:

1. **68 chamadas de `localStorage.getItem/setItem`** viraram `_dbGet(...)` /
   `_dbSet(...)` (funções que fazem exatamente a mesma coisa, mas guardando na
   nuvem em vez do navegador). Todas as ~293 funções do app continuam do
   jeitinho que estavam.
2. **3 `<script src="...">` novos** logo antes do script principal, carregando
   a biblioteca do Supabase, o `config.js` e a `supabase-bridge.js`.
3. **Um pequeno bloco no final** que repinta a tela (Painel, selects, badge do
   Plano de Ação) assim que os dados terminam de chegar da nuvem — porque a
   primeira pintura da tela acontece antes da internet responder, e sem isso
   ela ficaria com contadores zerados por um instante.

Se quiser conferir isso você mesmo, é só comparar este `app.html` com o que
você me mandou usando qualquer ferramenta de "diff" — o restante do arquivo é
byte a byte idêntico.

---

## Passo a passo para publicar do zero

### 1. Crie o projeto no Supabase

1. Entre em [supabase.com](https://supabase.com) → **New project**.
2. Anote a **senha do banco** que você escolher (não precisa dela depois, mas
   guarde por segurança).
3. Quando o projeto terminar de criar, vá em **SQL Editor** (menu lateral).

### 2. Rode os 4 arquivos `.sql`, NESTA ORDEM

Abra cada arquivo da pasta `sql/`, cole o conteúdo inteiro no SQL Editor e
clique em **Run**. A ordem importa (cada um depende do anterior):

1. `01_schema_base.sql`
2. `02_schema_modulos.sql`
3. `03_rls.sql`
4. `04_catalogo_nr.sql`

Se algum der erro de "already exists", pode rodar de novo sem problema — os
scripts foram escritos para serem repetíveis (`if not exists`, `drop policy if
exists`, etc.).

### 3. Pegue sua URL e chave "anon"

Em **Project Settings → API**, copie:
- **Project URL**
- **anon public key**

### 4. Preencha o `config.js`

Abra `config.js` e troque as duas linhas:

```js
window.RITTUS_SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
window.RITTUS_SUPABASE_ANON_KEY = "SUA-CHAVE-ANON-AQUI";
```

pelos valores reais que você copiou no passo 3. Esse é o **único** arquivo que
precisa editar antes de publicar.

### 5. Suba para o GitHub

```bash
git init
git add .
git commit -m "RITTUS ONE — versão Supabase"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/rittus-one.git
git push -u origin main
```

(Se preferir, crie o repositório primeiro pelo site do GitHub e siga as
instruções de "…or push an existing repository from the command line" que ele
mesmo mostra.)

### 6. Publique na Vercel

1. Entre em [vercel.com](https://vercel.com) → **Add New → Project**.
2. Importe o repositório que você acabou de criar.
3. Como é HTML puro (sem build), pode deixar tudo em branco em "Build and
   Output Settings" — a Vercel serve os arquivos estáticos direto.
4. Clique em **Deploy**.

Pronto: `https://seu-projeto.vercel.app/` abre a tela de login
(`index.html`), e depois de entrar cai no `app.html`.

### 7. Teste

1. Abra o site publicado, clique em "Criar acesso" e cadastre o primeiro
   usuário — ele vira automaticamente **admin** de uma organização nova.
2. Faça uma inspeção NR do início ao fim e confira se ela aparece em
   Histórico.
3. Abra o mesmo login em outro navegador (ou peça pra um colega testar) — os
   dados devem aparecer iguais, porque agora vêm do Supabase, não mais do
   navegador de cada um.

---

## Lacunas que já existiam no `app.html` (não foram criadas por esta migração)

Durante a análise, encontrei alguns pontos em que o próprio app (mesmo antes
de eu mexer em qualquer coisa) já perdia dado ou deixava algo pela metade. O
schema SQL já tem lugar pronto pra guardar tudo isso — só falta o `app.html`
realmente coletar e enviar. Deixei documentado aqui pra você decidir a
prioridade:

- **PT e APR só salvam um "cabeçalho"**: riscos, controles, EPIs, EPCs,
  equipe, etapas e assinaturas são montados na tela e aparecem no PDF, mas
  nunca chegam a ser salvos (nem no `localStorage` de antes, nem agora) — o
  app descarta esses dados assim que você fecha a aba. As tabelas `pts` e
  `aprs` já têm colunas prontas (`riscos`, `controles`, `epis`, `equipe`,
  `etapas`, `assinaturas`) esperando por isso.
- **Combate a Incêndio (inspeções) salva quase nada**: `_salvarInspecaoCI()`
  grava só `{id, modulo, fotos}` — o checklist respondido, a não conformidade,
  ação corretiva, responsável e prazo do formulário nunca são persistidos. A
  tabela `ci_inspecoes` já tem essas colunas prontas.
- **Duas inspeções (NR) com formatos diferentes**: dependendo de qual tela
  você usa (fluxo linear antigo vs. o fluxo novo de múltiplos módulos), o
  objeto salvo tem campos bem diferentes — o fluxo novo, inclusive, descarta o
  checklist e o plano de ação embutido. A ponte (`supabase-bridge.js`) já lida
  com os dois formatos sem quebrar, mas o ideal a médio prazo é unificar isso
  no próprio app.
- **Plano de Ação sem rastreabilidade**: quando uma não conformidade de
  qualquer módulo vira uma ação automática, o registro guarda só textos soltos
  (nome da unidade, da empresa) — não guarda de qual inspeção/item ela veio. O
  schema já tem `inspecao_id`/`inspecao_item_id` prontos; só falta o app
  passar esses IDs adiante.
- **RITTUS ID não tinha organização nenhuma**: era 100% por navegador, sem
  nenhum conceito de empresa dona dos dados. Coloquei `organizacao_id` do
  zero nas tabelas novas — funciona, mas antes você usava esse módulo "solto";
  agora ele também respeita a mesma separação por organização dos outros.
- **Diagnóstico público do RITTUS ID (QR code) é público de propósito** — sem
  login, como já era — mas isso significa que, com Row Level Security
  simples, qualquer pessoa com a chave "anon" consegue ler a tabela inteira de
  colaboradores (incluindo CPF, telefone, contato de emergência), não só os
  campos que a tela pública mostra. Deixei uma nota detalhada dentro de
  `03_rls.sql` sobre trocar isso por uma Edge Function antes de colocar CPF
  real de trabalhadores em produção.
- **Calculadora Financeira**: antes só guardava o último cálculo (sobrescrevia
  toda vez). Agora virou histórico de verdade (`calc_financeiro_historico`,
  uma linha por cálculo) — isso já é uma melhoria automática desta migração,
  não uma lacuna.

Nenhum desses pontos impede o app de funcionar — são exatamente as mesmas
lacunas que já existiam. Preferi listar tudo às claras a "consertar
silenciosamente" coisas que talvez você queira revisar com sua equipe antes.

## Fotos, assinaturas e arquivos

Onde o app já guardava uma foto/assinatura em base64 (equipamentos de CI,
plano de ação, RITTUS ID), a ponte agora sobe esse arquivo de verdade para o
Storage do Supabase (buckets `evidencias` e `rittus-id`, já criados pelo
`01_schema_base.sql`) e guarda só o link — em vez de inflar cada linha do
banco com uma string base64 gigante. Se o upload falhar por qualquer motivo
(sem internet, por exemplo), a ponte mantém o base64 como estava antes, então
nada quebra — só não fica tão leve quanto poderia.

## Próximos passos sugeridos (fora do escopo desta entrega)

- Implementar de fato a coleta de riscos/EPIs/equipe/etapas em PT e APR (ver
  "Lacunas" acima).
- Preencher `inspecao_id`/`inspecao_item_id` ao criar uma ação a partir de uma
  não conformidade.
- Trocar a policy pública do RITTUS ID por uma Edge Function antes de usar CPF
  real.
- Upload de foto de evidência por item do checklist de Combate a Incêndio.
- Controle por papel (`admin`/`gestor`/`inspetor`) escondendo ações na
  interface, hoje o banco já diferencia os papéis mas a tela ainda não.
