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
  getFirestore, collection, addDoc, updateDoc, doc,
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
  tab: "feed",
  search: "",
  filterProject: "",
  filterKind: ""
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
  bind("projects", "name", "asc");
}

async function saveDecision(data) {
  return addDoc(collection(db, "decisions"), {
    ...data,
    createdBy: state.user.uid,
    createdByName: state.user.displayName || state.user.email,
    createdAt: serverTimestamp()
  });
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
  // troca de abas (decisão / ação)
  $$(".capture-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".capture-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const cap = tab.dataset.cap;
      $("#capture-decision").classList.toggle("hidden", cap !== "decision");
      $("#capture-action").classList.toggle("hidden", cap !== "action");
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
      projectId
    });
    f.reset();
    toast("Decisão registrada");
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
      $("#tab-feed").classList.toggle("hidden", state.tab !== "feed");
      $("#tab-actions").classList.toggle("hidden", state.tab !== "actions");
      render();
    });
  });

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
  renderFeed();
  renderActions();
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
  const sel = document.querySelector(".decision-select");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Nasceu de qual decisão? (opcional)</option>'
    + state.decisions.map((d) => `<option value="${d.id}">${escapeHtml(truncate(d.title, 60))}</option>`).join("");
  sel.value = cur;
}

function matchesSearch(text) {
  return !state.search || (text || "").toLowerCase().includes(state.search);
}

function renderFeed() {
  const list = $("#feed-list");
  const items = [];

  if (state.filterKind !== "action") {
    state.decisions.forEach((d) => items.push({ kind: "decision", ...d }));
  }
  if (state.filterKind !== "decision") {
    state.actions.forEach((a) => items.push({ kind: "action", ...a }));
  }

  const filtered = items.filter((it) => {
    if (state.filterProject && it.projectId !== state.filterProject) return false;
    const haystack = [it.title, it.context, it.rationale, it.participants, it.assignee, it.createdByName]
      .filter(Boolean).join(" ");
    return matchesSearch(haystack);
  });

  filtered.sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));

  $("#feed-empty").classList.toggle("hidden", filtered.length > 0);
  list.innerHTML = filtered.map((it) =>
    it.kind === "decision" ? decisionCard(it) : actionCard(it)
  ).join("");

  // clique abre decisão
  list.querySelectorAll("[data-decision-id]").forEach((el) => {
    el.addEventListener("click", () => openDecision(el.dataset.decisionId));
  });
}

function decisionCard(d) {
  const proj = projectName(d.projectId);
  return `
    <div class="card decision-link" data-decision-id="${d.id}">
      <div class="card-head">
        <span class="tag tag-decision">Decisão</span>
        ${proj ? `<span class="card-meta">· ${escapeHtml(proj)}</span>` : ""}
        <span class="date">${fmtDate(d.createdAt)}</span>
      </div>
      <div class="card-title">${escapeHtml(d.title)}</div>
      ${d.context ? `<div class="card-context">📍 ${escapeHtml(d.context)}</div>` : ""}
      <div class="card-meta">
        ${d.participants ? `<span>👥 ${escapeHtml(d.participants)}</span>` : ""}
        <span>registrado por ${escapeHtml(d.createdByName || "")}</span>
      </div>
    </div>`;
}

const TYPE_LABEL = { tarefa: "Tarefa", pendencia: "Pendência", followup: "Follow-up", compromisso: "Compromisso" };
const STATUS_LABEL = { aberta: "Aberta", em_andamento: "Em andamento", bloqueada: "Bloqueada", concluida: "Concluída" };

function actionCard(a) {
  const proj = projectName(a.projectId);
  const overdue = isOverdue(a);
  return `
    <div class="card">
      <div class="card-head">
        <span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>
        ${proj ? `<span class="card-meta">· ${escapeHtml(proj)}</span>` : ""}
        <span class="date">${fmtDate(a.createdAt)}</span>
      </div>
      <div class="card-title">${escapeHtml(a.title)}</div>
      <div class="card-meta">
        ${a.assignee ? `<span>👤 ${escapeHtml(a.assignee)}</span>` : ""}
        ${a.dueDate ? `<span class="${overdue ? "overdue-flag" : ""}">📅 ${fmtDay(a.dueDate)}${overdue ? " (vencido)" : ""}</span>` : ""}
        <span>${STATUS_LABEL[a.status] || a.status}</span>
      </div>
    </div>`;
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

  const open = state.actions.filter((a) => a.status !== "concluida");
  $("#actions-empty").classList.toggle("hidden", state.actions.length > 0);

  board.innerHTML = cols.map((col) => {
    const items = state.actions
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
  });

  void open; // reservado p/ contadores futuros
}

function miniAction(a) {
  const overdue = isOverdue(a);
  return `
    <div class="mini ${overdue ? "overdue" : ""}">
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
// MODAL DE DECISÃO
// ===========================================================================
function openDecision(id) {
  const d = state.decisions.find((x) => x.id === id);
  if (!d) return;
  const linked = state.actions.filter((a) => a.decisionId === id);
  const proj = projectName(d.projectId);

  $("#decision-modal-body").innerHTML = `
    <button class="modal-close" data-close>×</button>
    <span class="tag tag-decision">Decisão</span>
    <h2>${escapeHtml(d.title)}</h2>
    <div class="card-meta">
      ${d.decidedAt ? `<span>📅 ${fmtDay(d.decidedAt)}</span>` : ""}
      ${proj ? `<span>· ${escapeHtml(proj)}</span>` : ""}
      <span>registrado por ${escapeHtml(d.createdByName || "")}</span>
    </div>
    ${d.context ? section("Contexto / de onde veio", escapeHtml(d.context)) : ""}
    ${d.rationale ? section("Por quê / alternativas descartadas", escapeHtml(d.rationale).replace(/\n/g, "<br>")) : ""}
    ${d.participants ? section("Participantes", escapeHtml(d.participants)) : ""}
    <div class="modal-section">
      <h4>Ações que nasceram desta decisão (${linked.length})</h4>
      ${linked.length ? linked.map((a) => `
        <div class="linked-action">
          <span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>
          <span>${escapeHtml(a.title)}</span>
          <span style="margin-left:auto;color:var(--muted);font-size:12px">${STATUS_LABEL[a.status] || a.status}</span>
        </div>`).join("") : '<p style="color:var(--muted);font-size:13px">Nenhuma ação vinculada ainda.</p>'}
    </div>`;

  $("#decision-modal-body").querySelector("[data-close]")
    .addEventListener("click", closeModal);
  $("#decision-modal").classList.remove("hidden");
}

function section(title, html) {
  return `<div class="modal-section"><h4>${title}</h4><div>${html}</div></div>`;
}
function closeModal() { $("#decision-modal").classList.add("hidden"); }

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
let toastTimer;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2200);
}

// ===========================================================================
// BOOT
// ===========================================================================
initAuth();
initCapture();
initNav();
