// ===========================================================================
// Fioo — memória de trabalho do time
// MVP: Firebase Auth (login por pessoa) + Firestore (espaço compartilhado).
// Sem build step: SDK modular via CDN. Serve em GitHub Pages ou Firebase Hosting.
// ===========================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Estado local (espelho em memória das coleções, alimentado por realtime)
const state = {
  user: null,
  decisions: [],
  actions: [],
  projects: [],
  ideas: [],
  tab: "feed",
  search: "",
  filterProject: "",
  filterKind: "",
  todayScope: "mine"
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ===========================================================================
// AUTENTICAÇÃO
// ===========================================================================
function initAuth() {
  const form = $("#login-form");
  const errEl = $("#login-error");

  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  const clearErr = () => errEl.classList.add("hidden");

  async function doAuth(mode) {
    clearErr();
    const email = $("#login-email").value.trim();
    const pass = $("#login-password").value;
    if (!email || !pass) { showErr("Preencha e-mail e senha."); return; }
    try {
      if (mode === "signup") {
        await createUserWithEmailAndPassword(auth, email, pass);
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) { showErr(translateAuthError(err)); }
  }

  // Enter no formulário ou clique em "Entrar"
  form.addEventListener("submit", (e) => { e.preventDefault(); doAuth("signin"); });
  // "Criar conta" (botão type="button", trata separadamente)
  form.querySelector('[data-action="signup"]').addEventListener("click", () => doAuth("signup"));

  $("#google-btn").addEventListener("click", async () => {
    clearErr();
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (err) { showErr(translateAuthError(err)); }
  });

  $("#logout-btn").addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, (user) => {
    state.user = user;
    if (user) {
      $("#login-view").classList.add("hidden");
      $("#app-view").classList.remove("hidden");
      $("#user-name").textContent = user.displayName || user.email;
      subscribeData();
    } else {
      $("#app-view").classList.add("hidden");
      $("#login-view").classList.remove("hidden");
    }
  });
}

function translateAuthError(err) {
  const map = {
    "auth/invalid-email": "E-mail inválido.",
    "auth/user-not-found": "Usuário não encontrado. Tente criar uma conta.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/email-already-in-use": "Este e-mail já tem conta. Use Entrar.",
    "auth/weak-password": "A senha precisa ter ao menos 6 caracteres.",
    "auth/popup-closed-by-user": "Login com Google cancelado."
  };
  return map[err.code] || ("Erro: " + (err.message || err.code));
}

// ===========================================================================
// CAMADA DE DADOS (Firestore, realtime)
// ===========================================================================
let unsubscribers = [];

function subscribeData() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];

  const bind = (name, orderField, dir = "desc") => {
    const q = query(collection(db, name), orderBy(orderField, dir));
    const unsub = onSnapshot(q, (snap) => {
      state[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, (err) => console.error(`Erro lendo ${name}:`, err));
    unsubscribers.push(unsub);
  };

  bind("decisions", "createdAt");
  bind("actions", "createdAt");
  bind("ideas", "createdAt");
  bind("projects", "name", "asc");
}

async function saveDecision(data) {
  const ref = await addDoc(collection(db, "decisions"), {
    ...data,
    archived: false,
    createdBy: state.user.uid,
    createdByName: state.user.displayName || state.user.email,
    createdAt: serverTimestamp()
  });
  // se esta decisão substitui outra, marca a antiga como revogada
  if (data.supersedesId) {
    try { await updateDoc(doc(db, "decisions", data.supersedesId), { status: "revogada" }); }
    catch (e) { console.warn("Não foi possível revogar a decisão anterior:", e); }
  }
  return ref;
}

async function saveIdea(data) {
  return addDoc(collection(db, "ideas"), {
    ...data,
    status: "semente",
    archived: false,
    createdBy: state.user.uid,
    createdByName: state.user.displayName || state.user.email,
    createdAt: serverTimestamp()
  });
}
async function updateIdea(id, data) {
  return updateDoc(doc(db, "ideas", id), data);
}
async function setArchived(coll, id, archived) {
  return updateDoc(doc(db, coll, id), { archived });
}

async function saveAction(data) {
  return addDoc(collection(db, "actions"), {
    ...data,
    createdBy: state.user.uid,
    createdByName: state.user.displayName || state.user.email,
    createdAt: serverTimestamp()
  });
}

async function updateActionStatus(id, status) {
  return updateDoc(doc(db, "actions", id), { status });
}

async function updateDecision(id, data) {
  return updateDoc(doc(db, "decisions", id), data);
}
async function updateAction(id, data) {
  return updateDoc(doc(db, "actions", id), data);
}
async function deleteRecord(coll, id) {
  return deleteDoc(doc(db, coll, id));
}

async function ensureProject(name) {
  const clean = (name || "").trim();
  if (!clean) return "";
  const existing = state.projects.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.id;
  const ref = await addDoc(collection(db, "projects"), {
    name: clean, status: "ativo",
    createdBy: state.user.uid, createdAt: serverTimestamp()
  });
  return ref.id;
}

// ===========================================================================
// CAPTURA
// ===========================================================================
function initCapture() {
  // troca de abas (decisão / ação / ideia)
  $$(".capture-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".capture-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const cap = tab.dataset.cap;
      $("#capture-decision").classList.toggle("hidden", cap !== "decision");
      $("#capture-action").classList.toggle("hidden", cap !== "action");
      $("#capture-idea").classList.toggle("hidden", cap !== "idea");
    });
  });

  $("#capture-decision").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const projectId = await resolveProjectFromSelect(f.projectId);
    await saveDecision({
      title: f.title.value.trim(),
      context: f.context.value.trim(),
      rationale: f.rationale.value.trim(),
      participants: f.participants.value.trim(),
      decidedAt: f.decidedAt.value || null,
      status: f.status.value || "vigente",
      supersedesId: f.supersedesId.value || null,
      projectId
    });
    f.reset();
    toast("Decisão registrada");
  });

  $("#capture-idea").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await saveIdea({ title: f.title.value.trim(), note: f.note.value.trim() });
    f.reset();
    toast("Ideia registrada");
  });

  $("#capture-action").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const projectId = await resolveProjectFromSelect(f.projectId);
    await saveAction({
      title: f.title.value.trim(),
      type: f.type.value,
      assignee: f.assignee.value.trim(),
      dueDate: f.dueDate.value || null,
      decisionId: f.decisionId.value || null,
      status: f.status.value,
      projectId
    });
    f.reset();
    toast("Ação registrada");
  });
}

// selects de projeto oferecem opção "novo projeto"
async function resolveProjectFromSelect(selectEl) {
  const val = selectEl.value;
  if (val === "__new__") {
    const name = prompt("Nome do novo projeto:");
    return ensureProject(name);
  }
  return val || "";
}

// ===========================================================================
// NAVEGAÇÃO + FILTROS
// ===========================================================================
function initNav() {
  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      $$(".nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + state.tab));
      render();
    });
  });

  // "Meu dia": alternância meus / do time
  $$(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.todayScope = btn.dataset.scope;
      $$(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderToday();
    });
  });
  $("#notif-btn").addEventListener("click", requestNotifications);

  $("#search").addEventListener("input", (e) => { state.search = e.target.value.toLowerCase(); renderFeed(); });
  $("#filter-project").addEventListener("change", (e) => { state.filterProject = e.target.value; renderFeed(); });
  $("#filter-kind").addEventListener("change", (e) => { state.filterKind = e.target.value; renderFeed(); });

  // modal
  $("#decision-modal").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closeModal();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

// ===========================================================================
// RENDER
// ===========================================================================
function render() {
  renderProjectSelects();
  renderDecisionSelect();
  renderToday();
  renderFeed();
  renderActions();
  refreshModalIfOpen();
}

function projectName(id) {
  const p = state.projects.find((x) => x.id === id);
  return p ? p.name : "";
}

function renderProjectSelects() {
  const options = ['<option value="">— sem projeto —</option>']
    .concat(state.projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`))
    .concat('<option value="__new__">+ novo projeto…</option>')
    .join("");
  $$(".project-select").forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = options;
    sel.value = cur;
  });

  // filtro do feed
  const filter = $("#filter-project");
  const curF = state.filterProject;
  filter.innerHTML = ['<option value="">Todos os projetos</option>']
    .concat(state.projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)).join("");
  filter.value = curF;
}

function renderDecisionSelect() {
  const opts = activeDecisions()
    .map((d) => `<option value="${d.id}">${escapeHtml(truncate(d.title, 60))}</option>`).join("");

  const sel = document.querySelector(".decision-select");
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Nasceu de qual decisão? (opcional)</option>' + opts;
    sel.value = cur;
  }
  const sup = document.querySelector(".supersede-select");
  if (sup) {
    const cur = sup.value;
    sup.innerHTML = '<option value="">Substitui alguma decisão? (opcional)</option>' + opts;
    sup.value = cur;
  }
}

// helpers de "não arquivado"
const notArchived = (x) => !x.archived;
function activeDecisions() { return state.decisions.filter(notArchived); }
function activeActions() { return state.actions.filter(notArchived); }
function activeIdeas() { return state.ideas.filter(notArchived); }

function matchesSearch(text) {
  return !state.search || (text || "").toLowerCase().includes(state.search);
}

function renderFeed() {
  const list = $("#feed-list");
  const k = state.filterKind;
  const items = [];

  if (k === "" || k === "decision") activeDecisions().forEach((d) => items.push({ kind: "decision", ...d }));
  if (k === "" || k === "action") activeActions().forEach((a) => items.push({ kind: "action", ...a }));
  if (k === "" || k === "idea") activeIdeas().forEach((i) => items.push({ kind: "idea", ...i }));

  const filtered = items.filter((it) => {
    if (state.filterProject && it.projectId !== state.filterProject) return false;
    const haystack = [it.title, it.context, it.rationale, it.participants, it.assignee, it.note, it.createdByName]
      .filter(Boolean).join(" ");
    return matchesSearch(haystack);
  });

  filtered.sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));

  $("#feed-empty").classList.toggle("hidden", filtered.length > 0);
  list.innerHTML = filtered.map((it) =>
    it.kind === "decision" ? decisionCard(it)
    : it.kind === "idea" ? ideaCard(it)
    : actionCard(it)
  ).join("");

  // clique abre o registro
  list.querySelectorAll("[data-decision-id]").forEach((el) => {
    el.addEventListener("click", () => openRecord("decision", el.dataset.decisionId));
  });
  list.querySelectorAll("[data-idea-id]").forEach((el) => {
    el.addEventListener("click", () => openRecord("idea", el.dataset.ideaId));
  });
  list.querySelectorAll("[data-action-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".done-btn")) return;
      openRecord("action", el.dataset.actionId);
    });
  });
  wireDoneButtons(list);
}

function wireDoneButtons(scope) {
  scope.querySelectorAll(".done-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      updateActionStatus(btn.dataset.doneId, "concluida");
      toast("Concluída");
    });
  });
}

const DSTATUS_LABEL = { vigente: "Vigente", revista: "Revista", revogada: "Revogada" };

function decisionStatusTag(d) {
  const s = d.status || "vigente";
  if (s === "vigente") return "";
  return `<span class="tag dstatus-${s}">${DSTATUS_LABEL[s]}</span>`;
}

function decisionCard(d) {
  const proj = projectName(d.projectId);
  return `
    <div class="card decision-link" data-decision-id="${d.id}">
      <div class="card-head">
        <span class="tag tag-decision">Decisão</span>
        ${decisionStatusTag(d)}
        ${proj ? `<span class="card-meta">· ${escapeHtml(proj)}</span>` : ""}
        <span class="date">${fmtDate(d.createdAt)}</span>
      </div>
      <div class="card-title" ${(d.status && d.status !== "vigente") ? 'style="text-decoration:line-through;opacity:.7"' : ""}>${escapeHtml(d.title)}</div>
      ${d.context ? `<div class="card-context">📍 ${escapeHtml(d.context)}</div>` : ""}
      <div class="card-meta">
        ${d.participants ? `<span>👥 ${escapeHtml(d.participants)}</span>` : ""}
        <span>registrado por ${escapeHtml(d.createdByName || "")}</span>
      </div>
    </div>`;
}

function ideaCard(i) {
  return `
    <div class="card decision-link" data-idea-id="${i.id}">
      <div class="card-head">
        <span class="tag tag-idea">💡 Ideia</span>
        ${i.status === "promovida" ? '<span class="tag dstatus-revista">Virou projeto</span>' : ""}
        <span class="date">${fmtDate(i.createdAt)}</span>
      </div>
      <div class="card-title">${escapeHtml(i.title)}</div>
      ${i.note ? `<div class="card-context">${escapeHtml(i.note)}</div>` : ""}
      <div class="card-meta"><span>registrado por ${escapeHtml(i.createdByName || "")}</span></div>
    </div>`;
}

const TYPE_LABEL = { tarefa: "Tarefa", pendencia: "Pendência", followup: "Follow-up", compromisso: "Compromisso" };
const STATUS_LABEL = { aberta: "Aberta", em_andamento: "Em andamento", bloqueada: "Bloqueada", concluida: "Concluída" };

function actionCard(a) {
  const proj = projectName(a.projectId);
  const overdue = isOverdue(a);
  return `
    <div class="card decision-link" data-action-id="${a.id}">
      <div class="card-head">
        <span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>
        ${proj ? `<span class="card-meta">· ${escapeHtml(proj)}</span>` : ""}
        ${a.status !== "concluida" ? `<button class="done-btn" data-done-id="${a.id}" title="Concluir">✓</button>` : ""}
        <span class="date">${fmtDate(a.createdAt)}</span>
      </div>
      <div class="card-title" ${a.status === "concluida" ? 'style="text-decoration:line-through;opacity:.7"' : ""}>${escapeHtml(a.title)}</div>
      <div class="card-meta">
        ${a.assignee ? `<span>👤 ${escapeHtml(a.assignee)}</span>` : ""}
        ${a.dueDate ? `<span class="${overdue ? "overdue-flag" : ""}">📅 ${fmtDay(a.dueDate)}${overdue ? " (vencido)" : ""}</span>` : ""}
        <span>${STATUS_LABEL[a.status] || a.status}</span>
      </div>
    </div>`;
}

// -------- Meu dia (lembretes por urgência) --------
function daysUntil(isoDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(isoDate + "T00:00:00");
  return Math.round((d - today) / 86400000);
}

function renderToday() {
  const el = $("#today-list");
  if (!el) return;

  let items = activeActions().filter((a) => a.status !== "concluida");
  if (state.todayScope === "mine" && state.user) {
    items = items.filter((a) => a.createdBy === state.user.uid);
  }

  const buckets = {
    vencidos: [], hoje: [], semana: [], depois: [], semprazo: []
  };
  items.forEach((a) => {
    if (!a.dueDate) { buckets.semprazo.push(a); return; }
    const d = daysUntil(a.dueDate);
    if (d < 0) buckets.vencidos.push(a);
    else if (d === 0) buckets.hoje.push(a);
    else if (d <= 7) buckets.semana.push(a);
    else buckets.depois.push(a);
  });

  const groups = [
    { key: "vencidos", label: "⚠️ Vencidos", cls: "grp-red" },
    { key: "hoje", label: "Vencem hoje", cls: "grp-amber" },
    { key: "semana", label: "Esta semana", cls: "" },
    { key: "depois", label: "Mais adiante", cls: "" },
    { key: "semprazo", label: "Sem prazo", cls: "" }
  ];

  const total = items.length;
  $("#today-empty").classList.toggle("hidden", total > 0);

  el.innerHTML = groups.map((g) => {
    const list = buckets[g.key].sort((a, b) => {
      const da = a.dueDate ? daysUntil(a.dueDate) : 9999;
      const db = b.dueDate ? daysUntil(b.dueDate) : 9999;
      return da - db;
    });
    if (!list.length) return "";
    return `
      <div class="today-group ${g.cls}">
        <h3>${g.label} <span class="col-count">(${list.length})</span></h3>
        ${list.map(todayItem).join("")}
      </div>`;
  }).join("");

  el.querySelectorAll("[data-aid]").forEach((node) => {
    node.addEventListener("click", (e) => {
      if (e.target.closest(".done-btn")) return;
      openRecord("action", node.dataset.aid);
    });
  });
  wireDoneButtons(el);

  // botão de avisos: só aparece se o navegador suporta e ainda não decidiu
  const nb = $("#notif-btn");
  if ("Notification" in window && Notification.permission === "default") {
    nb.classList.remove("hidden");
  } else {
    nb.classList.add("hidden");
  }

  checkReminders();
}

function todayItem(a) {
  const proj = projectName(a.projectId);
  const due = a.dueDate ? `${fmtDay(a.dueDate)}` : "";
  return `
    <div class="mini" data-aid="${a.id}" style="cursor:pointer">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>
        <span style="flex:1">${escapeHtml(a.title)}</span>
        <button class="done-btn" data-done-id="${a.id}" title="Concluir">✓</button>
      </div>
      <div class="mini-meta">
        <span>${a.assignee ? "👤 " + escapeHtml(a.assignee) : ""}${proj ? " · " + escapeHtml(proj) : ""}</span>
        <span>${due}</span>
      </div>
    </div>`;
}

// notificações locais (enquanto o app está aberto/instalado)
let notifiedThisSession = false;
async function requestNotifications() {
  if (!("Notification" in window)) return;
  const perm = await Notification.requestPermission();
  if (perm === "granted") { toast("Avisos ativados"); checkReminders(); }
  renderToday();
}
function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (notifiedThisSession || !state.user) return;
  const overdue = activeActions().filter((a) =>
    a.status !== "concluida" && a.createdBy === state.user.uid &&
    a.dueDate && daysUntil(a.dueDate) < 0
  ).length;
  if (overdue > 0) {
    notifiedThisSession = true;
    new Notification("Fioo", {
      body: `Você tem ${overdue} item(ns) vencido(s) esperando ação.`,
      icon: "icon.svg"
    });
  }
}

// -------- Painel de Ações (por status, follow-ups vencidos em destaque) --------
function renderActions() {
  const board = $("#actions-board");
  const cols = [
    { key: "aberta", label: "Abertas" },
    { key: "em_andamento", label: "Em andamento" },
    { key: "bloqueada", label: "Bloqueadas" },
    { key: "concluida", label: "Concluídas" }
  ];

  const all = activeActions();
  const open = all.filter((a) => a.status !== "concluida");
  $("#actions-empty").classList.toggle("hidden", all.length > 0);

  board.innerHTML = cols.map((col) => {
    const items = all
      .filter((a) => a.status === col.key)
      .sort((a, b) => {
        // vencidos primeiro
        const ov = (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0);
        if (ov) return ov;
        return tsMillis(b.createdAt) - tsMillis(a.createdAt);
      });
    return `
      <div class="col">
        <h3>${col.label} <span class="col-count">(${items.length})</span></h3>
        ${items.map(miniAction).join("") || '<p class="empty" style="padding:12px 0;font-size:13px">—</p>'}
      </div>`;
  }).join("");

  board.querySelectorAll(".status-change").forEach((sel) => {
    sel.addEventListener("change", (e) => updateActionStatus(e.target.dataset.id, e.target.value));
    sel.addEventListener("click", (e) => e.stopPropagation());
  });
  board.querySelectorAll(".mini").forEach((el) => {
    el.addEventListener("click", () => openRecord("action", el.dataset.aid));
  });

  void open; // reservado p/ contadores futuros
}

function miniAction(a) {
  const overdue = isOverdue(a);
  return `
    <div class="mini ${overdue ? "overdue" : ""}" data-aid="${a.id}" style="cursor:pointer">
      <div><span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span></div>
      <div style="margin-top:6px">${escapeHtml(a.title)}</div>
      <div class="mini-meta">
        <span>${a.assignee ? "👤 " + escapeHtml(a.assignee) : ""}</span>
        <span class="${overdue ? "overdue-flag" : ""}">${a.dueDate ? fmtDay(a.dueDate) : ""}</span>
      </div>
      <div class="mini-actions">
        <select class="status-change" data-id="${a.id}">
          ${Object.entries(STATUS_LABEL).map(([k, v]) =>
            `<option value="${k}" ${k === a.status ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </div>
    </div>`;
}

// ===========================================================================
// MODAL — ver / editar / excluir decisões e ações
// ===========================================================================
let modal = { type: null, id: null, mode: "view" };

function openRecord(type, id) {
  modal = { type, id, mode: "view" };
  $("#decision-modal").classList.remove("hidden");
  renderModal();
}
function closeModal() {
  modal = { type: null, id: null, mode: "view" };
  $("#decision-modal").classList.add("hidden");
}
// mantém o modal vivo quando o realtime atualiza (só em modo leitura)
function refreshModalIfOpen() {
  if (modal.id && modal.mode === "view") renderModal();
}

function collForType(t) { return t === "decision" ? "decisions" : t === "idea" ? "ideas" : "actions"; }
function listForType(t) { return t === "decision" ? state.decisions : t === "idea" ? state.ideas : state.actions; }

function currentRecord() {
  return listForType(modal.type).find((x) => x.id === modal.id) || null;
}
function isMine(rec) { return rec && state.user && rec.createdBy === state.user.uid; }

function renderModal() {
  const rec = currentRecord();
  const body = $("#decision-modal-body");
  if (!rec) { closeModal(); return; }
  let html;
  if (modal.mode === "createAction") html = createActionForm(rec);
  else if (modal.mode === "edit") html = editForm(rec);
  else html = modal.type === "decision" ? decisionView(rec)
    : modal.type === "idea" ? ideaView(rec) : actionView(rec);
  body.innerHTML = html;
  wireModal();
}

function wireModal() {
  const body = $("#decision-modal-body");
  body.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));

  const editBtn = body.querySelector("[data-edit]");
  if (editBtn) editBtn.addEventListener("click", () => { modal.mode = "edit"; renderModal(); });

  const arcBtn = body.querySelector("[data-archive]");
  if (arcBtn) arcBtn.addEventListener("click", async () => {
    const coll = collForType(modal.type), id = modal.id;
    await setArchived(coll, id, true);
    closeModal();
    toast("Arquivado", { label: "Desfazer", fn: () => setArchived(coll, id, false) });
  });

  const newActBtn = body.querySelector("[data-new-action]");
  if (newActBtn) newActBtn.addEventListener("click", () => { modal.mode = "createAction"; renderModal(); });

  const promoteBtn = body.querySelector("[data-promote]");
  if (promoteBtn) promoteBtn.addEventListener("click", async () => {
    const idea = currentRecord();
    await ensureProject(idea.title);
    await updateIdea(modal.id, { status: "promovida" });
    renderModal();
    toast("Ideia virou projeto");
  });

  body.querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", () => openRecord(el.dataset.openType, el.dataset.open)));

  const cancelBtn = body.querySelector("[data-cancel]");
  if (cancelBtn) cancelBtn.addEventListener("click", () => { modal.mode = "view"; renderModal(); });

  const form = body.querySelector("form");
  if (form) form.addEventListener("submit", onModalSubmit);
}

async function onModalSubmit(e) {
  e.preventDefault();
  const f = e.target;

  // criar nova ação a partir da decisão aberta
  if (modal.mode === "createAction") {
    const projectId = await resolveProjectFromSelect(f.projectId);
    await saveAction({
      title: f.title.value.trim(),
      type: f.type.value,
      assignee: f.assignee.value.trim(),
      dueDate: f.dueDate.value || null,
      decisionId: modal.id,
      status: f.status.value,
      projectId
    });
    modal.mode = "view";
    renderModal();
    toast("Ação criada e vinculada");
    return;
  }

  if (modal.type === "decision") {
    const projectId = await resolveProjectFromSelect(f.projectId);
    const supersedesId = f.supersedesId.value || null;
    await updateDecision(modal.id, {
      title: f.title.value.trim(),
      context: f.context.value.trim(),
      rationale: f.rationale.value.trim(),
      participants: f.participants.value.trim(),
      decidedAt: f.decidedAt.value || null,
      status: f.status.value,
      supersedesId,
      projectId
    });
    if (supersedesId && supersedesId !== modal.id) {
      try { await updateDecision(supersedesId, { status: "revogada" }); } catch (_) {}
    }
  } else if (modal.type === "idea") {
    await updateIdea(modal.id, { title: f.title.value.trim(), note: f.note.value.trim() });
  } else {
    const projectId = await resolveProjectFromSelect(f.projectId);
    await updateAction(modal.id, {
      title: f.title.value.trim(),
      type: f.type.value,
      assignee: f.assignee.value.trim(),
      dueDate: f.dueDate.value || null,
      decisionId: f.decisionId.value || null,
      status: f.status.value,
      projectId
    });
  }
  modal.mode = "view";
  renderModal();
  toast("Alterações salvas");
}

// -------- Views (somente leitura) --------
function ownerButtons(rec) {
  if (!isMine(rec)) return "";
  return `<button class="btn btn-ghost btn-sm" data-edit>Editar</button>
          <button class="btn btn-ghost btn-sm" data-archive>Arquivar</button>`;
}
function linkTo(type, rec) {
  return `<span class="inline-link" data-open="${rec.id}" data-open-type="${type}">${escapeHtml(truncate(rec.title, 70))}</span>`;
}

function decisionView(d) {
  const linked = activeActions().filter((a) => a.decisionId === d.id);
  const proj = projectName(d.projectId);
  const supersedes = d.supersedesId ? state.decisions.find((x) => x.id === d.supersedesId) : null;
  const supersededBy = state.decisions.find((x) => !x.archived && x.supersedesId === d.id);
  const st = d.status || "vigente";
  return `
    <button class="modal-close" data-close>×</button>
    <span class="tag tag-decision">Decisão</span>
    ${st !== "vigente" ? `<span class="tag dstatus-${st}">${DSTATUS_LABEL[st]}</span>` : ""}
    <h2>${escapeHtml(d.title)}</h2>
    <div class="card-meta">
      ${d.decidedAt ? `<span>📅 ${fmtDay(d.decidedAt)}</span>` : ""}
      ${proj ? `<span>· ${escapeHtml(proj)}</span>` : ""}
      <span>registrado por ${escapeHtml(d.createdByName || "")}</span>
    </div>
    ${supersedes ? section("Substitui a decisão", linkTo("decision", supersedes)) : ""}
    ${supersededBy ? section("Substituída por", linkTo("decision", supersededBy)) : ""}
    ${d.context ? section("Contexto / de onde veio", escapeHtml(d.context)) : ""}
    ${d.rationale ? section("Por quê / alternativas descartadas", escapeHtml(d.rationale).replace(/\n/g, "<br>")) : ""}
    ${d.participants ? section("Participantes", escapeHtml(d.participants)) : ""}
    <div class="modal-section">
      <h4>Ações que nasceram desta decisão (${linked.length})</h4>
      ${linked.length ? linked.map((a) => `
        <div class="linked-action inline-link" data-open="${a.id}" data-open-type="action">
          <span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>
          <span>${escapeHtml(a.title)}</span>
          <span style="margin-left:auto;color:var(--muted);font-size:12px">${STATUS_LABEL[a.status] || a.status}</span>
        </div>`).join("") : '<p style="color:var(--muted);font-size:13px">Nenhuma ação vinculada ainda.</p>'}
    </div>
    <div class="modal-section" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" data-new-action>+ Nova ação a partir desta</button>
      ${ownerButtons(d)}
    </div>`;
}

function actionView(a) {
  const proj = projectName(a.projectId);
  const overdue = isOverdue(a);
  const origin = a.decisionId ? state.decisions.find((d) => d.id === a.decisionId) : null;
  return `
    <button class="modal-close" data-close>×</button>
    <span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>
    <h2>${escapeHtml(a.title)}</h2>
    <div class="card-meta">
      ${a.assignee ? `<span>👤 ${escapeHtml(a.assignee)}</span>` : ""}
      ${a.dueDate ? `<span class="${overdue ? "overdue-flag" : ""}">📅 ${fmtDay(a.dueDate)}${overdue ? " (vencido)" : ""}</span>` : ""}
      <span>${STATUS_LABEL[a.status] || a.status}</span>
      ${proj ? `<span>· ${escapeHtml(proj)}</span>` : ""}
      <span>por ${escapeHtml(a.createdByName || "")}</span>
    </div>
    ${origin ? `<div class="modal-section"><h4>Nasceu da decisão</h4><div>${linkTo("decision", origin)}</div></div>` : ""}
    <div class="modal-section" style="display:flex;gap:8px;justify-content:flex-end">${ownerButtons(a)}</div>`;
}

function ideaView(i) {
  return `
    <button class="modal-close" data-close>×</button>
    <span class="tag tag-idea">💡 Ideia</span>
    ${i.status === "promovida" ? '<span class="tag dstatus-revista">Virou projeto</span>' : ""}
    <h2>${escapeHtml(i.title)}</h2>
    <div class="card-meta"><span>registrado por ${escapeHtml(i.createdByName || "")}</span></div>
    ${i.note ? section("Detalhes", escapeHtml(i.note).replace(/\n/g, "<br>")) : ""}
    <div class="modal-section" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      ${isMine(i) && i.status !== "promovida" ? '<button class="btn btn-ghost btn-sm" data-promote>Promover a projeto</button>' : ""}
      ${ownerButtons(i)}
    </div>`;
}

// -------- Formulários --------
function projectOptions(selectedId) {
  return ['<option value="">— sem projeto —</option>']
    .concat(state.projects.map((p) =>
      `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${escapeHtml(p.name)}</option>`))
    .concat('<option value="__new__">+ novo projeto…</option>').join("");
}
function decisionOptions(selectedId, excludeId) {
  return activeDecisions().filter((d) => d.id !== excludeId).map((d) =>
    `<option value="${d.id}" ${d.id === selectedId ? "selected" : ""}>${escapeHtml(truncate(d.title, 60))}</option>`).join("");
}

function actionFieldsForm(rec) {
  const r = rec || {};
  return `
    <form class="capture-form">
      <textarea name="title" rows="2" required>${escapeHtml(r.title)}</textarea>
      <div class="capture-grid">
        <select name="type" class="type-select">
          ${Object.entries(TYPE_LABEL).map(([k, v]) =>
            `<option value="${k}" ${k === r.type ? "selected" : ""}>${v}</option>`).join("")}
        </select>
        <select name="projectId" class="project-select">${projectOptions(r.projectId)}</select>
      </div>
      <div class="capture-grid">
        <input name="assignee" placeholder="Responsável / com quem" value="${escapeAttr(r.assignee)}" />
        <input name="dueDate" type="date" value="${r.dueDate || ""}" />
      </div>
      <div class="capture-grid">
        <select name="decisionId">
          <option value="">Nasceu de qual decisão? (opcional)</option>
          ${decisionOptions(r.decisionId)}
        </select>
        <select name="status">
          ${Object.entries(STATUS_LABEL).map(([k, v]) =>
            `<option value="${k}" ${k === (r.status || "aberta") ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </div>
      <div class="capture-footer" style="gap:8px">
        <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>`;
}

function createActionForm(decision) {
  // decisionId será fixado como modal.id no submit; projeto herda da decisão
  return `
    <button class="modal-close" data-close>×</button>
    <h2>Nova ação</h2>
    <p style="color:var(--muted);font-size:13px;margin-top:-6px">Vinculada a: ${escapeHtml(truncate(decision.title, 70))}</p>
    ${actionFieldsForm({ projectId: decision.projectId, status: "aberta", type: "tarefa" })}`;
}

function editForm(rec) {
  if (modal.type === "decision") {
    const st = rec.status || "vigente";
    return `
      <button class="modal-close" data-close>×</button>
      <h2>Editar decisão</h2>
      <form class="capture-form">
        <textarea name="title" rows="2" required>${escapeHtml(rec.title)}</textarea>
        <div class="capture-grid">
          <input name="context" placeholder="Contexto / de onde veio" value="${escapeAttr(rec.context)}" />
          <select name="projectId" class="project-select">${projectOptions(rec.projectId)}</select>
        </div>
        <textarea name="rationale" rows="3" placeholder="Por quê / alternativas descartadas">${escapeHtml(rec.rationale)}</textarea>
        <div class="capture-grid">
          <input name="participants" placeholder="Participantes" value="${escapeAttr(rec.participants)}" />
          <input name="decidedAt" type="date" value="${rec.decidedAt || ""}" />
        </div>
        <div class="capture-grid">
          <select name="status">
            ${Object.entries(DSTATUS_LABEL).map(([k, v]) =>
              `<option value="${k}" ${k === st ? "selected" : ""}>${v}</option>`).join("")}
          </select>
          <select name="supersedesId">
            <option value="">Substitui alguma decisão? (opcional)</option>
            ${decisionOptions(rec.supersedesId, rec.id)}
          </select>
        </div>
        <div class="capture-footer" style="gap:8px">
          <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </form>`;
  }
  if (modal.type === "idea") {
    return `
      <button class="modal-close" data-close>×</button>
      <h2>Editar ideia</h2>
      <form class="capture-form">
        <textarea name="title" rows="2" required>${escapeHtml(rec.title)}</textarea>
        <textarea name="note" rows="3" placeholder="Detalhes (opcional)">${escapeHtml(rec.note)}</textarea>
        <div class="capture-footer" style="gap:8px">
          <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </form>`;
  }
  return `
    <button class="modal-close" data-close>×</button>
    <h2>Editar ação</h2>
    ${actionFieldsForm(rec)}`;
}

function section(title, html) {
  return `<div class="modal-section"><h4>${title}</h4><div>${html}</div></div>`;
}

// ===========================================================================
// UTIL
// ===========================================================================
function tsMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  return 0;
}
function fmtDate(ts) {
  const ms = tsMillis(ts);
  if (!ms) return "agora";
  return new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}
function fmtDay(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}
function isOverdue(a) {
  if (!a.dueDate || a.status === "concluida") return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(a.dueDate + "T00:00:00") < today;
}
function truncate(s, n) { return (s || "").length > n ? s.slice(0, n) + "…" : (s || ""); }
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s); }
let toastTimer;
function toast(msg, action) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "toast";
  const span = document.createElement("span");
  span.textContent = msg;
  el.appendChild(span);
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-btn";
    btn.textContent = action.label;
    btn.addEventListener("click", () => { action.fn(); el.remove(); });
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), action ? 5000 : 2200);
}

// ===========================================================================
// BOOT
// ===========================================================================
initAuth();
initCapture();
initNav();

// PWA: registra o service worker (habilita instalar no celular + shell offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) =>
      console.warn("Service worker não registrado:", err));
  });
}
