# Fioo

Memória de trabalho do time. Registra **decisões** (com o porquê e as alternativas
descartadas) e **ações** (tarefa, pendência, follow-up, compromisso), ligando cada
ação à decisão que a originou. Busca textual livre em tudo. Cada pessoa faz login e
alimenta o mesmo espaço compartilhado.

Stack: HTML/CSS/JS puro (sem build) + Firebase Auth + Cloud Firestore.
Serve em Firebase Hosting **ou** GitHub Pages.

---

## 1. Criar o projeto no Firebase

1. Acesse <https://console.firebase.google.com> → **Adicionar projeto**.
2. Dentro do projeto, menu **Criar → Authentication → Começar**. Ative:
   - **E-mail/senha**
   - **Google** (opcional, mas o botão já está pronto no app)
3. Menu **Criar → Firestore Database → Criar banco de dados** → modo de produção,
   região `southamerica-east1` (São Paulo).
4. **Configurações do projeto** (engrenagem) → seção *Seus apps* → ícone **</>**
   (Web) → registre o app. Copie o objeto `firebaseConfig`.

## 2. Configurar as credenciais

Abra `firebase-config.js` e cole os valores copiados no passo anterior.
Essas chaves são públicas por natureza (rodam no navegador) — a segurança real
vem das regras do Firestore + login obrigatório.

## 3. Publicar as regras de segurança

As regras em `firestore.rules` exigem login para tudo, deixam qualquer pessoa
autenticada ler o espaço do time, mas só o autor edita/apaga o que criou (com
exceção do *status* de uma ação, que qualquer um pode mudar — útil para dar baixa
em algo delegado). Publique com a Firebase CLI (passo 4) ou cole no console em
**Firestore → Regras**.

## 4. Deploy no Firebase Hosting (recomendado)

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # selecione seu projeto, dê o apelido "default"
firebase deploy               # publica hosting + regras do Firestore
```

O `firebase.json` já está configurado (serve a pasta atual e aplica as regras).

## 5. Alternativa: GitHub Pages

Como o app é 100% estático, também roda no GitHub Pages:

1. Suba a pasta para um repositório no GitHub.
2. **Settings → Pages → Source: Deploy from a branch**, branch `main`, pasta `/root`.
3. No console do Firebase → **Authentication → Settings → Domínios autorizados**,
   adicione `SEU_USUARIO.github.io` para o login funcionar.

> Deploy contínuo opcional: há um workflow em `.github/workflows/deploy.yml` que
> publica no Firebase Hosting a cada push na `main`. Requer o secret
> `FIREBASE_SERVICE_ACCOUNT` (JSON de uma conta de serviço com papel de Hosting Admin).

## 6. Rodar localmente

```bash
# qualquer servidor estático; ES modules não funcionam via file://
npx serve .
# ou
python3 -m http.server 5000
```

Abra o endereço indicado. Crie sua conta na tela de login e comece a registrar.

---

## Modelo de dados (Firestore)

| Coleção     | Campos principais |
|-------------|-------------------|
| `decisions` | `title`, `context`, `rationale`, `participants`, `decidedAt`, `projectId`, `createdBy`, `createdByName`, `createdAt` |
| `actions`   | `title`, `type` (tarefa\|pendencia\|followup\|compromisso), `assignee`, `dueDate`, `status` (aberta\|em_andamento\|bloqueada\|concluida), `decisionId`, `projectId`, `createdBy`, `createdByName`, `createdAt` |
| `projects`  | `name`, `status`, `createdBy`, `createdAt` |

O elo que dá valor ao sistema é `actions.decisionId` → `decisions.id`: a página da
decisão mostra a árvore de ações que nasceram dela.

## Fora do escopo deste MVP (fase 2+)

- Captura por IA (colar reunião/WhatsApp e classificar automaticamente)
- Integrações (e-mail, WhatsApp, Slack)
- Permissões corporativas por setor
- Detecção automática de "problema recorrente"
- Busca full-text no servidor (hoje a busca é client-side, ok para o tamanho de um time)
