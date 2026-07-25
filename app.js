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
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc, getDocs,
  onSnapshot, query, where, documentId, serverTimestamp, Timestamp
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
  comments: [],
  memberships: [],   // minhas associações [{id, workspaceId, role, ...}]
  allMembers: [],    // todos os membros das minhas empresas
  workspaces: [],    // [{id, name, role}]
  currentWs: "all",  // "all" ou um workspaceId
  tab: "feed",
  search: "",
  filterProject: "",
  filterKind: "",
  filterAssignee: "",
  filterPeriod: "",
  filterTag: "",
  feedSort: "recent",
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
      $("#fab").classList.remove("hidden");
      $("#user-name").textContent = user.displayName || user.email;
      subscribeData();
      handleInviteLink();
    } else {
      $("#app-view").classList.add("hidden");
      $("#fab").classList.add("hidden");
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
// CAMADA DE DADOS (Firestore, realtime) — com escopo por empresa
// ===========================================================================
let membershipUnsub = null;
let scopedUnsubs = [];
let lastWsSignature = "";
let bootstrapped = false;
let permWarned = false;
function loadErr(context, err) {
  console.error("Erro ao carregar " + context + ":", err);
  if (!permWarned) {
    permWarned = true;
    toast("Erro ao carregar dados. Verifique se as regras do Firestore foram publicadas.");
  }
}

function subscribeData() {
  // observa as empresas de que sou membro
  if (membershipUnsub) membershipUnsub();
  const mq = query(collection(db, "memberships"), where("uid", "==", state.user.uid));
  membershipUnsub = onSnapshot(mq, (snap) => {
    state.memberships = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // primeira vez: nenhuma empresa → cria "Geral" e migra o que já existe
    if (!state.memberships.length) {
      renderWsSwitcher();
      render();
      if (!bootstrapped) { bootstrapped = true; runFirstTimeSetup(); }
      return;
    }
    bootstrapped = true;

    const wsIds = state.memberships.map((m) => m.workspaceId);
    // corrige empresa selecionada se ela sumiu
    if (state.currentWs !== "all" && !wsIds.includes(state.currentWs)) setWs("all");

    const sig = wsIds.slice().sort().join(",");
    if (sig !== lastWsSignature) {
      lastWsSignature = sig;
      subscribeScoped(wsIds);
    }
    renderWsSwitcher();
    render();
  }, (err) => {
    console.error("Erro lendo memberships:", err);
    toast("Erro de permissão. Publique as regras atualizadas do Firestore.");
  });
}

function subscribeScoped(wsIds) {
  scopedUnsubs.forEach((u) => u());
  scopedUnsubs = [];
  if (!wsIds.length) {
    state.decisions = []; state.actions = []; state.ideas = []; state.projects = []; state.workspaces = [];
    render();
    return;
  }
  const ids = wsIds.slice(0, 30); // limite do operador "in"

  // nomes das empresas
  const wq = query(collection(db, "workspaces"), where(documentId(), "in", ids));
  scopedUnsubs.push(onSnapshot(wq, (snap) => {
    const byId = {};
    snap.docs.forEach((d) => { byId[d.id] = d.data().name; });
    state.workspaces = state.memberships.map((m) => ({
      id: m.workspaceId,
      name: byId[m.workspaceId] || m.workspaceName || "Empresa",
      role: m.role
    }));
    // auto-cura: se a empresa selecionada não existe mais, volta para "Todas"
    if (state.currentWs !== "all" && !state.workspaces.some((w) => w.id === state.currentWs)) {
      setWs("all");
    }
    renderWsSwitcher();
    render();
  }, (err) => loadErr("empresas", err)));

  // conteúdo (sem orderBy p/ não exigir índice composto; ordenamos no cliente)
  ["decisions", "actions", "ideas", "projects", "comments"].forEach((name) => {
    const q = query(collection(db, name), where("workspaceId", "in", ids));
    scopedUnsubs.push(onSnapshot(q, (snap) => {
      state[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, (err) => loadErr(name, err)));
  });

  // todos os membros das minhas empresas (para atribuir responsável)
  const mAllQ = query(collection(db, "memberships"), where("workspaceId", "in", ids));
  scopedUnsubs.push(onSnapshot(mAllQ, (snap) => {
    state.allMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("Erro lendo membros:", err)));
}

// ---- empresas / associações / convites ----
async function createWorkspace(name) {
  const clean = (name || "").trim() || "Empresa";
  const ref = await addDoc(collection(db, "workspaces"), {
    name: clean, createdBy: state.user.uid, createdAt: serverTimestamp()
  });
  await setDoc(doc(db, "memberships", `${ref.id}_${state.user.uid}`), {
    workspaceId: ref.id, uid: state.user.uid,
    email: state.user.email || "", role: "admin",
    workspaceName: clean, createdAt: serverTimestamp()
  });
  return ref.id;
}

async function runFirstTimeSetup() {
  const wsId = await createWorkspace("Geral");
  await migrateOrphans(wsId);
  setWs("all");
  // o listener de memberships vai reagir à nova associação
}

async function migrateOrphans(wsId) {
  let moved = 0;
  for (const name of ["decisions", "actions", "ideas", "projects"]) {
    try {
      const snap = await getDocs(query(collection(db, name), where("createdBy", "==", state.user.uid)));
      for (const d of snap.docs) {
        if (!("workspaceId" in d.data())) {
          await updateDoc(doc(db, name, d.id), { workspaceId: wsId });
          moved++;
        }
      }
    } catch (e) { console.warn(`Migração de ${name} falhou:`, e); }
  }
  return moved;
}

function randomCode() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
}
async function createInvite(wsId, role) {
  const code = randomCode();
  const ws = state.workspaces.find((w) => w.id === wsId);
  await setDoc(doc(db, "invites", code), {
    workspaceId: wsId, workspaceName: ws ? ws.name : "",
    role: role || "membro", createdBy: state.user.uid, createdAt: serverTimestamp()
  });
  return code;
}
async function joinByCode(code) {
  const clean = (code || "").trim();
  if (!clean) throw new Error("Código vazio");
  const snap = await getDoc(doc(db, "invites", clean));
  if (!snap.exists()) throw new Error("Convite inválido ou expirado");
  const inv = snap.data();
  await setDoc(doc(db, "memberships", `${inv.workspaceId}_${state.user.uid}`), {
    workspaceId: inv.workspaceId, uid: state.user.uid,
    email: state.user.email || "", role: inv.role || "membro",
    workspaceName: inv.workspaceName || "", inviteCode: clean, createdAt: serverTimestamp()
  });
  setWs(inv.workspaceId);
  return inv;
}
async function renameWorkspace(wsId, name) {
  return updateDoc(doc(db, "workspaces", wsId), { name: (name || "").trim() || "Empresa" });
}
async function deleteWorkspaceFull(wsId) {
  // sai da empresa (remove associação) e tenta apagar a empresa (se você a criou)
  try { await deleteDoc(doc(db, "memberships", `${wsId}_${state.user.uid}`)); } catch (_) {}
  try { await deleteDoc(doc(db, "workspaces", wsId)); } catch (_) {}
}
async function membersOf(wsId) {
  const snap = await getDocs(query(collection(db, "memberships"), where("workspaceId", "==", wsId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function removeMember(membershipId) {
  return deleteDoc(doc(db, "memberships", membershipId));
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

async function saveComment(parentType, parentId, workspaceId, text) {
  return addDoc(collection(db, "comments"), {
    parentType, parentId, workspaceId, text,
    createdBy: state.user.uid,
    createdByName: state.user.displayName || state.user.email,
    createdAt: serverTimestamp()
  });
}
function commentsFor(parentId) {
  return state.comments
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => tsMillis(a.createdAt) - tsMillis(b.createdAt));
}
// membros de uma empresa (a partir do estado já carregado)
function membersOfWs(wsId) {
  return state.allMembers.filter((m) => m.workspaceId === wsId);
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
  await updateDoc(doc(db, "actions", id), { status });
  if (status === "concluida") maybeSpawnRecurrence(id);
}
// ao concluir uma ação recorrente, cria a próxima ocorrência
function maybeSpawnRecurrence(id) {
  const a = state.actions.find((x) => x.id === id);
  if (!a || !a.recurrence || a.recurrence === "none") return;
  const base = a.dueDate ? new Date(a.dueDate + "T00:00:00") : new Date();
  if (a.recurrence === "weekly") base.setDate(base.getDate() + 7);
  else if (a.recurrence === "monthly") base.setMonth(base.getMonth() + 1);
  else return;
  const next = base.toISOString().slice(0, 10);
  saveAction({
    title: a.title, type: a.type, assignee: a.assignee || "", assigneeUid: a.assigneeUid || null,
    dueDate: next, decisionId: a.decisionId || null, status: "aberta",
    projectId: a.projectId || "", workspaceId: a.workspaceId,
    tags: a.tags || [], links: a.links || [], recurrence: a.recurrence,
    checklist: (a.checklist || []).map((c) => ({ text: c.text, done: false }))
  });
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

async function ensureProject(name, wsId) {
  const clean = (name || "").trim();
  if (!clean) return "";
  const existing = state.projects.find((p) =>
    p.workspaceId === wsId && p.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.id;
  const ref = await addDoc(collection(db, "projects"), {
    name: clean, status: "ativo", workspaceId: wsId,
    createdBy: state.user.uid, createdAt: serverTimestamp()
  });
  return ref.id;
}

// empresa que a captura vai usar (empresa selecionada, ou a única existente)
function captureWs() {
  if (state.currentWs !== "all") return state.currentWs;
  if (state.workspaces.length === 1) return state.workspaces[0].id;
  return null; // ambíguo — precisa escolher no topo
}
function wsName(id) {
  const w = state.workspaces.find((x) => x.id === id);
  return w ? w.name : "";
}
function isAdminOf(wsId) {
  const w = state.workspaces.find((x) => x.id === wsId);
  return w && w.role === "admin";
}
// define e persiste a empresa selecionada
function setWs(v) {
  state.currentWs = v;
  try { localStorage.setItem("fioo-ws", v); } catch (_) {}
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
    const ws = captureWs();
    if (!ws) return toast("Escolha uma empresa no seletor do topo para registrar");
    const f = e.target;
    const projectId = await resolveProjectFromSelect(f.projectId, ws);
    await saveDecision({
      title: f.title.value.trim(),
      context: f.context.value.trim(),
      rationale: f.rationale.value.trim(),
      participants: f.participants.value.trim(),
      decidedAt: f.decidedAt.value || null,
      status: f.status.value || "vigente",
      supersedesId: f.supersedesId.value || null,
      tags: parseTags(f.tags.value), links: parseLinks(f.links.value),
      projectId, workspaceId: ws
    });
    f.reset();
    toast("Decisão registrada");
  });

  $("#capture-idea").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ws = captureWs();
    if (!ws) return toast("Escolha uma empresa no seletor do topo para registrar");
    const f = e.target;
    await saveIdea({ title: f.title.value.trim(), note: f.note.value.trim(), tags: parseTags(f.tags.value), workspaceId: ws });
    f.reset();
    toast("Ideia registrada");
  });

  $("#capture-action").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ws = captureWs();
    if (!ws) return toast("Escolha uma empresa no seletor do topo para registrar");
    const f = e.target;
    const projectId = await resolveProjectFromSelect(f.projectId, ws);
    const { assignee, assigneeUid } = resolveAssignee(f, ws);
    await saveAction({
      title: f.title.value.trim(),
      type: f.type.value,
      assignee, assigneeUid,
      dueDate: f.dueDate.value || null,
      decisionId: f.decisionId.value || null,
      status: f.status.value,
      tags: parseTags(f.tags.value), links: parseLinks(f.links.value),
      recurrence: f.recurrence.value || "none", checklist: [],
      projectId, workspaceId: ws
    });
    f.reset();
    toast("Ação registrada");
  });
}

// preenche os selects de "responsável (membro)" da captura com membros da empresa atual
function renderMemberSelects() {
  const ws = captureWs();
  const members = ws ? membersOfWs(ws) : [];
  const opts = '<option value="">Responsável: membro… (opcional)</option>' +
    members.map((m) => `<option value="${m.uid}">${escapeHtml(m.email || m.uid)}</option>`).join("");
  document.querySelectorAll(".member-select").forEach((sel) => {
    const cur = sel.value; sel.innerHTML = opts; sel.value = cur;
  });
}

// resolve responsável: membro (uid) tem prioridade; senão texto livre
function resolveAssignee(f, ws) {
  const uid = f.assigneeUid ? (f.assigneeUid.value || null) : null;
  let assignee = f.assignee ? f.assignee.value.trim() : "";
  if (uid) {
    const m = state.allMembers.find((x) => x.uid === uid && x.workspaceId === ws);
    if (m) assignee = m.email || m.uid;
  }
  return { assignee, assigneeUid: uid };
}

// selects de projeto oferecem opção "novo projeto"
async function resolveProjectFromSelect(selectEl, wsId) {
  const val = selectEl.value;
  if (val === "__new__") {
    const name = prompt("Nome do novo projeto:");
    return ensureProject(name, wsId);
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
  $("#filter-assignee").addEventListener("change", (e) => { state.filterAssignee = e.target.value; renderFeed(); });
  $("#filter-tag").addEventListener("change", (e) => { state.filterTag = e.target.value; renderFeed(); });
  $("#filter-period").addEventListener("change", (e) => { state.filterPeriod = e.target.value; renderFeed(); });
  $("#feed-sort").addEventListener("change", (e) => { state.feedSort = e.target.value; renderFeed(); });
  $("#print-intel").addEventListener("click", () => window.print());
  $("#fab").addEventListener("click", () => {
    state.tab = "feed";
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === "feed"));
    $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-feed"));
    window.scrollTo({ top: 0, behavior: "smooth" });
    const t = document.querySelector('#capture-decision textarea[name="title"]');
    if (t) setTimeout(() => t.focus(), 300);
  });

  // seletor de empresa + gestão
  $("#ws-switcher").addEventListener("change", (e) => {
    setWs(e.target.value);
    render();
  });
  $("#ws-manage-btn").addEventListener("click", openWsModal);
  $("#ws-modal").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-ws-close")) closeWsModal();
  });
  $("#admin-btn").addEventListener("click", openAdminModal);
  $("#admin-modal").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-admin-close")) closeAdminModal();
  });

  // modal
  $("#decision-modal").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeWsModal(); closeAdminModal(); }
  });
}

// ===========================================================================
// EMPRESAS — seletor no topo + modal de gestão + convites
// ===========================================================================
function renderWsSwitcher() {
  const sel = $("#ws-switcher");
  if (!sel) return;
  const opts = ['<option value="all">🏢 Todas as empresas</option>']
    .concat(state.workspaces
      .slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`))
    .join("");
  sel.innerHTML = opts;
  sel.value = state.currentWs;
  if (sel.value !== state.currentWs) sel.value = "all"; // empresa salva ainda não carregou
}

function renderWsBanner() {
  const el = $("#ws-banner");
  if (!el) return;
  if (state.currentWs === "all") {
    el.className = "ws-banner ws-banner-all";
    el.innerHTML = `<span class="ws-banner-label">Vendo</span><strong>Todas as empresas</strong>`;
  } else {
    const n = wsName(state.currentWs) || "…";
    el.className = "ws-banner";
    el.innerHTML = `<span class="ws-banner-label">Empresa atual</span><strong>🏢 ${escapeHtml(n)}</strong>`;
  }
}

let wsModalOpen = false;
let lastModalWsSig = "";
function openWsModal() { wsModalOpen = true; $("#ws-modal").classList.remove("hidden"); renderWsModal(); }
function closeWsModal() { wsModalOpen = false; $("#ws-modal").classList.add("hidden"); }
function renderWsModalIfOpen() {
  if (!wsModalOpen) return;
  const sig = state.workspaces.map((w) => w.id + w.name + w.role).sort().join("|");
  if (sig === lastModalWsSig) return; // só re-renderiza se a lista de empresas mudou
  renderWsModal();
}

function renderWsModal() {
  const body = $("#ws-modal-body");
  lastModalWsSig = state.workspaces.map((w) => w.id + w.name + w.role).sort().join("|");
  const rows = state.workspaces.slice().sort((a, b) => a.name.localeCompare(b.name)).map((w) => `
    <div class="ws-row">
      <div>
        <div class="ws-row-name">${escapeHtml(w.name)}</div>
        <div class="ws-row-role">${w.role === "admin" ? "Admin" : "Membro"}</div>
      </div>
      <div class="ws-row-actions">
        ${w.role === "admin" ? `<button class="btn btn-ghost btn-sm" data-rename="${w.id}">Renomear</button>` : ""}
        ${w.role === "admin" ? `<button class="btn btn-ghost btn-sm" data-invite="${w.id}">Convidar</button>` : ""}
        ${w.role === "admin" ? `<button class="btn btn-ghost btn-sm" data-members="${w.id}">Membros</button>` : ""}
        ${w.role === "admin" ? `<button class="btn btn-ghost btn-sm" data-adopt="${w.id}">Importar antigos</button>` : ""}
        ${w.role === "admin" ? `<button class="btn btn-ghost btn-sm" data-delws="${w.id}">Excluir</button>` : ""}
      </div>
    </div>`).join("") || '<p style="color:var(--muted);font-size:13px">Você ainda não participa de nenhuma empresa.</p>';

  body.innerHTML = `
    <button class="modal-close" data-ws-close>×</button>
    <h2>Empresas</h2>
    <div class="ws-list">${rows}</div>

    <div class="modal-section">
      <h4>Nova empresa</h4>
      <form id="ws-create-form" style="display:flex;gap:8px">
        <input name="name" placeholder="Nome da empresa" required style="flex:1" />
        <button type="submit" class="btn btn-primary">Criar</button>
      </form>
    </div>

    <div class="modal-section">
      <h4>Entrar com código de convite</h4>
      <form id="ws-join-form" style="display:flex;gap:8px">
        <input name="code" placeholder="Cole o código do convite" required style="flex:1" />
        <button type="submit" class="btn btn-ghost">Entrar</button>
      </form>
    </div>

    <div id="ws-modal-extra"></div>`;

  body.querySelectorAll("[data-ws-close]").forEach((b) => b.addEventListener("click", closeWsModal));

  $("#ws-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    const id = await createWorkspace(name);
    setWs(id);
    toast("Empresa criada");
    renderWsModal();
  });

  $("#ws-join-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const inv = await joinByCode(e.target.code.value);
      toast(`Você entrou em ${inv.workspaceName || "empresa"}`);
      closeWsModal();
    } catch (err) { toast(err.message || "Não foi possível entrar"); }
  });

  body.querySelectorAll("[data-invite]").forEach((b) =>
    b.addEventListener("click", () => showInvite(b.dataset.invite)));
  body.querySelectorAll("[data-members]").forEach((b) =>
    b.addEventListener("click", () => showMembers(b.dataset.members)));
  body.querySelectorAll("[data-rename]").forEach((b) =>
    b.addEventListener("click", async () => {
      const w = state.workspaces.find((x) => x.id === b.dataset.rename);
      const name = prompt("Novo nome da empresa:", w ? w.name : "");
      if (name && name.trim()) { await renameWorkspace(b.dataset.rename, name); toast("Empresa renomeada"); renderWsModal(); }
    }));

  body.querySelectorAll("[data-adopt]").forEach((b) =>
    b.addEventListener("click", async () => {
      const wsId = b.dataset.adopt;
      if (!confirm(`Trazer todos os registros antigos (sem empresa) para "${wsName(wsId)}"?`)) return;
      b.disabled = true; b.textContent = "Importando…";
      const n = await migrateOrphans(wsId);
      toast(n > 0 ? `${n} registro(s) importado(s)` : "Nenhum registro antigo encontrado");
    }));

  body.querySelectorAll("[data-delws]").forEach((b) =>
    b.addEventListener("click", async () => {
      const wsId = b.dataset.delws;
      const nm = wsName(wsId);
      const dc = state.decisions.filter((x) => x.workspaceId === wsId).length;
      const ac = state.actions.filter((x) => x.workspaceId === wsId).length;
      const ic = state.ideas.filter((x) => x.workspaceId === wsId).length;
      const total = dc + ac + ic;
      let msg = `Excluir/sair da empresa "${nm}"?`;
      if (total > 0) msg += `\n\nATENÇÃO: ela ainda tem ${total} registro(s). Você deixará de vê-los.`;
      if (!confirm(msg)) return;
      if (state.currentWs === wsId) setWs("all");
      await deleteWorkspaceFull(wsId);
      toast("Empresa removida");
    }));
}

async function showInvite(wsId) {
  const extra = $("#ws-modal-extra");
  extra.innerHTML = '<p style="color:var(--muted);font-size:13px">Gerando convite…</p>';
  try {
    const code = await createInvite(wsId, "membro");
    const link = `${location.origin}${location.pathname}?invite=${code}`;
    extra.innerHTML = `
      <div class="modal-section">
        <h4>Convite para ${escapeHtml(wsName(wsId))}</h4>
        <p style="font-size:13px;color:var(--muted)">Mande este link (ou só o código). Quem abrir entra como membro.</p>
        <input readonly value="${escapeAttr(link)}" onclick="this.select()" style="margin-bottom:8px" />
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" id="copy-invite">Copiar link</button>
          <span style="font-family:monospace;align-self:center">código: ${code}</span>
        </div>
      </div>`;
    $("#copy-invite").addEventListener("click", () => {
      navigator.clipboard?.writeText(link);
      toast("Link copiado");
    });
  } catch (err) { extra.innerHTML = `<p style="color:var(--red)">${escapeHtml(err.message || "Erro")}</p>`; }
}

async function showMembers(wsId) {
  const extra = $("#ws-modal-extra");
  extra.innerHTML = '<p style="color:var(--muted);font-size:13px">Carregando membros…</p>';
  try {
    const members = await membersOf(wsId);
    extra.innerHTML = `
      <div class="modal-section">
        <h4>Membros de ${escapeHtml(wsName(wsId))}</h4>
        ${members.map((m) => `
          <div class="ws-row">
            <div>${escapeHtml(m.email || m.uid)} <span class="ws-row-role">${m.role === "admin" ? "admin" : "membro"}</span></div>
            ${m.uid !== state.user.uid ? `<button class="btn btn-ghost btn-sm" data-remove="${m.id}">Remover</button>` : "<span class='ws-row-role'>você</span>"}
          </div>`).join("")}
      </div>`;
    extra.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Remover este membro da empresa?")) return;
        await removeMember(b.dataset.remove);
        showMembers(wsId);
        toast("Membro removido");
      }));
  } catch (err) { extra.innerHTML = `<p style="color:var(--red)">${escapeHtml(err.message || "Erro")}</p>`; }
}

// entrar automaticamente se veio por link ?invite=CODE
async function handleInviteLink() {
  const code = new URLSearchParams(location.search).get("invite");
  if (!code) return;
  try {
    const inv = await joinByCode(code);
    toast(`Você entrou em ${inv.workspaceName || "empresa"}`);
  } catch (err) { toast(err.message || "Convite inválido"); }
  // limpa a URL
  history.replaceState({}, "", location.pathname);
}

// ===========================================================================
// RENDER
// ===========================================================================
function render() {
  renderWsSwitcher();
  renderWsBanner();
  renderWsModalIfOpen();
  renderProjectSelects();
  renderMemberSelects();
  renderDecisionSelect();
  renderToday();
  renderFeed();
  renderActions();
  renderProjects();
  renderIntel();
  refreshModalIfOpen();
}

// -------- Projetos (lista + timeline) --------
function renderProjects() {
  const el = $("#projects-list");
  if (!el) return;
  const projs = scopedProjects();
  $("#projects-empty").classList.toggle("hidden", projs.length > 0);
  el.innerHTML = projs
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const dc = activeDecisions().filter((x) => x.projectId === p.id).length;
      const ac = activeActions().filter((x) => x.projectId === p.id).length;
      const ic = activeIdeas().filter((x) => x.projectId === p.id).length;
      return `
        <div class="card decision-link" data-project-id="${p.id}">
          <div class="card-head"><span class="tag tag-project">📁 Projeto</span>${wsBadge(p)}</div>
          <div class="card-title">${escapeHtml(p.name)}</div>
          <div class="card-meta"><span>${dc} decisões</span><span>${ac} ações</span><span>${ic} ideias</span></div>
        </div>`;
    }).join("");
  el.querySelectorAll("[data-project-id]").forEach((node) =>
    node.addEventListener("click", () => openRecord("project", node.dataset.projectId)));
}

function projectName(id) {
  const p = state.projects.find((x) => x.id === id);
  return p ? p.name : "";
}

function renderProjectSelects() {
  const projs = scopedProjects();
  const options = ['<option value="">— sem projeto —</option>']
    .concat(projs.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`))
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
    .concat(projs.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)).join("");
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

// helpers de "não arquivado" + escopo da empresa selecionada
const notArchived = (x) => !x.archived;
const inScope = (x) => state.currentWs === "all" || x.workspaceId === state.currentWs;
function activeDecisions() { return state.decisions.filter((x) => notArchived(x) && inScope(x)); }
function activeActions() { return state.actions.filter((x) => notArchived(x) && inScope(x)); }
function activeIdeas() { return state.ideas.filter((x) => notArchived(x) && inScope(x)); }
function scopedProjects() { return state.projects.filter(inScope); }

// chips de etiquetas
function tagsChips(rec) {
  const t = rec.tags || [];
  if (!t.length) return "";
  return `<div class="chips">${t.map((x) => `<span class="chip">#${escapeHtml(x)}</span>`).join("")}</div>`;
}
function parseTags(str) {
  return (str || "").split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
}
function parseLinks(str) {
  return (str || "").split(/[\n,]/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

// etiqueta da empresa no card (só aparece no modo "Todas")
function wsBadge(rec) {
  if (state.currentWs !== "all") return "";
  const n = wsName(rec.workspaceId);
  return n ? `<span class="ws-chip">🏢 ${escapeHtml(n)}</span>` : "";
}

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

  // opções de responsável (distintos no escopo)
  const assignees = Array.from(new Set(items.map((it) => it.assignee).filter(Boolean))).sort();
  const fa = $("#filter-assignee");
  if (fa) {
    const cur = state.filterAssignee;
    fa.innerHTML = '<option value="">Todos os responsáveis</option>' +
      assignees.map((a) => `<option value="${escapeAttr(a)}">${escapeHtml(a)}</option>`).join("");
    fa.value = cur;
  }
  // opções de etiqueta
  const tags = Array.from(new Set(items.flatMap((it) => it.tags || []))).sort();
  const ft = $("#filter-tag");
  if (ft) {
    const cur = state.filterTag;
    ft.innerHTML = '<option value="">Todas as etiquetas</option>' +
      tags.map((t) => `<option value="${escapeAttr(t)}">#${escapeHtml(t)}</option>`).join("");
    ft.value = cur;
  }

  const periodDays = state.filterPeriod ? parseInt(state.filterPeriod, 10) : 0;
  const cutoff = periodDays ? Date.now() - periodDays * 86400000 : 0;

  const filtered = items.filter((it) => {
    if (state.filterProject && it.projectId !== state.filterProject) return false;
    if (state.filterAssignee && it.assignee !== state.filterAssignee) return false;
    if (state.filterTag && !(it.tags || []).includes(state.filterTag)) return false;
    if (cutoff && tsMillis(it.createdAt) < cutoff) return false;
    const haystack = [it.title, it.context, it.rationale, it.participants, it.assignee, it.note, it.createdByName, (it.tags || []).join(" ")]
      .filter(Boolean).join(" ");
    return matchesSearch(haystack);
  });

  if (state.feedSort === "old") filtered.sort((a, b) => tsMillis(a.createdAt) - tsMillis(b.createdAt));
  else if (state.feedSort === "due") filtered.sort((a, b) => (a.dueDate || "9999") .localeCompare(b.dueDate || "9999"));
  else filtered.sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));

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
        ${wsBadge(d)}
        ${proj ? `<span class="card-meta">· ${escapeHtml(proj)}</span>` : ""}
        <span class="date">${fmtDate(d.createdAt)}</span>
      </div>
      <div class="card-title" ${(d.status && d.status !== "vigente") ? 'style="text-decoration:line-through;opacity:.7"' : ""}>${escapeHtml(d.title)}</div>
      ${d.context ? `<div class="card-context">📍 ${escapeHtml(d.context)}</div>` : ""}
      ${tagsChips(d)}
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
        ${wsBadge(i)}
        <span class="date">${fmtDate(i.createdAt)}</span>
      </div>
      <div class="card-title">${escapeHtml(i.title)}</div>
      ${i.note ? `<div class="card-context">${escapeHtml(i.note)}</div>` : ""}
      ${tagsChips(i)}
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
        ${wsBadge(a)}
        ${proj ? `<span class="card-meta">· ${escapeHtml(proj)}</span>` : ""}
        ${a.status !== "concluida" ? `<button class="done-btn" data-done-id="${a.id}" title="Concluir">✓</button>` : ""}
        <span class="date">${fmtDate(a.createdAt)}</span>
      </div>
      <div class="card-title" ${a.status === "concluida" ? 'style="text-decoration:line-through;opacity:.7"' : ""}>${escapeHtml(a.title)}${a.recurrence && a.recurrence !== "none" ? ' 🔁' : ""}</div>
      ${tagsChips(a)}
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
    items = items.filter((a) => a.createdBy === state.user.uid || a.assigneeUid === state.user.uid);
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
      <div class="col" data-col="${col.key}">
        <h3>${col.label} <span class="col-count">(${items.length})</span></h3>
        <div class="col-drop" data-col="${col.key}">
          ${items.map(miniAction).join("") || '<p class="empty col-hint" style="padding:12px 0;font-size:13px">arraste aqui</p>'}
        </div>
      </div>`;
  }).join("");

  board.querySelectorAll(".status-change").forEach((sel) => {
    sel.addEventListener("change", (e) => updateActionStatus(e.target.dataset.id, e.target.value));
    sel.addEventListener("click", (e) => e.stopPropagation());
  });
  board.querySelectorAll(".mini").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".status-change")) return;
      openRecord("action", el.dataset.aid);
    });
    // arrastar
    el.addEventListener("dragstart", (e) => {
      el.classList.add("dragging");
      e.dataTransfer.setData("text/plain", el.dataset.aid);
      e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });
  // soltar nas colunas
  board.querySelectorAll(".col-drop").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drop-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-over");
      const id = e.dataTransfer.getData("text/plain");
      const newStatus = zone.dataset.col;
      const a = state.actions.find((x) => x.id === id);
      if (id && a && a.status !== newStatus) updateActionStatus(id, newStatus);
    });
  });

  void open; // reservado p/ contadores futuros
}

function miniAction(a) {
  const overdue = isOverdue(a);
  const done = (a.checklist || []).filter((c) => c.done).length;
  const total = (a.checklist || []).length;
  return `
    <div class="mini ${overdue ? "overdue" : ""}" data-aid="${a.id}" draggable="true" style="cursor:grab">
      <div><span class="tag tag-${a.type}">${TYPE_LABEL[a.type] || a.type}</span>${a.recurrence && a.recurrence !== "none" ? ' <span class="tag tag-recur">🔁</span>' : ""}</div>
      <div style="margin-top:6px">${escapeHtml(a.title)}</div>
      ${total ? `<div class="mini-meta"><span>☑ ${done}/${total}</span></div>` : ""}
      ${tagsChips(a)}
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
// INTELIGÊNCIA — indicadores + gráficos
// ===========================================================================
let chartInstances = [];
function renderIntel() {
  if (state.tab !== "intel") return;
  const kpiEl = $("#intel-kpis");
  const chartsEl = $("#intel-charts");
  if (!kpiEl || !chartsEl) return;

  const decisions = activeDecisions();
  const actions = activeActions();
  const ideas = activeIdeas();
  const openActions = actions.filter((a) => a.status !== "concluida");
  const overdue = openActions.filter((a) => a.dueDate && daysUntil(a.dueDate) < 0);
  const vigentes = decisions.filter((d) => (d.status || "vigente") === "vigente");
  const compromissos = openActions.filter((a) => a.type === "compromisso");

  const kpis = [
    { label: "Decisões", value: decisions.length },
    { label: "Vigentes", value: vigentes.length },
    { label: "Ações abertas", value: openActions.length },
    { label: "Vencidas", value: overdue.length, warn: overdue.length > 0 },
    { label: "Compromissos abertos", value: compromissos.length },
    { label: "Ideias", value: ideas.length }
  ];
  kpiEl.innerHTML = kpis.map((k) =>
    `<div class="kpi ${k.warn ? "kpi-warn" : ""}"><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div></div>`
  ).join("");

  chartInstances.forEach((c) => { try { c.destroy(); } catch (_) {} });
  chartInstances = [];

  if (typeof Chart === "undefined") {
    chartsEl.innerHTML = '<p class="empty">Gráficos indisponíveis agora (sem conexão para carregar a biblioteca). Tente recarregar.</p>';
    return;
  }

  const comparativo = state.currentWs === "all";
  chartsEl.innerHTML = `
    <div class="chart-card"><h3>Ações por status</h3><div class="chart-box"><canvas id="c-actions"></canvas></div></div>
    <div class="chart-card"><h3>Decisões por status</h3><div class="chart-box"><canvas id="c-decisions"></canvas></div></div>
    <div class="chart-card chart-wide"><h3>Atividade nos últimos 6 meses</h3><div class="chart-box"><canvas id="c-activity"></canvas></div></div>
    ${comparativo ? '<div class="chart-card chart-wide"><h3>Comparativo por empresa</h3><div class="chart-box"><canvas id="c-company"></canvas></div></div>' : ""}`;

  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  Chart.defaults.color = col("--muted");
  Chart.defaults.borderColor = col("--line");
  const legend = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } };

  const st = { aberta: 0, em_andamento: 0, bloqueada: 0, concluida: 0 };
  actions.forEach((a) => { st[a.status] = (st[a.status] || 0) + 1; });
  chartInstances.push(new Chart($("#c-actions"), {
    type: "doughnut",
    data: { labels: ["Abertas", "Em andamento", "Bloqueadas", "Concluídas"],
      datasets: [{ data: [st.aberta, st.em_andamento, st.bloqueada, st.concluida],
        backgroundColor: [col("--accent"), col("--amber"), col("--red"), col("--green")] }] },
    options: legend
  }));

  const dst = { vigente: 0, revista: 0, revogada: 0 };
  decisions.forEach((d) => { const s = d.status || "vigente"; dst[s] = (dst[s] || 0) + 1; });
  chartInstances.push(new Chart($("#c-decisions"), {
    type: "doughnut",
    data: { labels: ["Vigentes", "Revistas", "Revogadas"],
      datasets: [{ data: [dst.vigente, dst.revista, dst.revogada],
        backgroundColor: [col("--green"), col("--amber"), col("--red")] }] },
    options: legend
  }));

  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: d.getFullYear() + "-" + d.getMonth(), label: d.toLocaleDateString("pt-BR", { month: "short" }) });
  }
  const byMonth = (arr) => {
    const m = {};
    arr.forEach((x) => { const ms = tsMillis(x.createdAt); if (!ms) return; const d = new Date(ms); const k = d.getFullYear() + "-" + d.getMonth(); m[k] = (m[k] || 0) + 1; });
    return months.map((mo) => m[mo.key] || 0);
  };
  chartInstances.push(new Chart($("#c-activity"), {
    type: "bar",
    data: { labels: months.map((m) => m.label),
      datasets: [
        { label: "Decisões", data: byMonth(decisions), backgroundColor: col("--accent") },
        { label: "Ações", data: byMonth(actions), backgroundColor: col("--green") },
        { label: "Ideias", data: byMonth(ideas), backgroundColor: col("--amber") }
      ] },
    options: { ...legend, scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } } }
  }));

  if (comparativo) {
    const perWs = state.workspaces.map((w) => ({
      name: w.name,
      dc: state.decisions.filter((x) => !x.archived && x.workspaceId === w.id).length,
      ac: state.actions.filter((x) => !x.archived && x.workspaceId === w.id).length,
      ic: state.ideas.filter((x) => !x.archived && x.workspaceId === w.id).length
    }));
    chartInstances.push(new Chart($("#c-company"), {
      type: "bar",
      data: { labels: perWs.map((p) => p.name),
        datasets: [
          { label: "Decisões", data: perWs.map((p) => p.dc), backgroundColor: col("--accent") },
          { label: "Ações", data: perWs.map((p) => p.ac), backgroundColor: col("--green") },
          { label: "Ideias", data: perWs.map((p) => p.ic), backgroundColor: col("--amber") }
        ] },
      options: { ...legend, scales: { y: { ticks: { precision: 0 } } } }
    }));
  }
}

// ===========================================================================
// ADMINISTRAÇÃO — usuários + backup
// ===========================================================================
let adminOpen = false;
function openAdminModal() { adminOpen = true; $("#admin-modal").classList.remove("hidden"); renderAdminModal(); }
function closeAdminModal() { adminOpen = false; $("#admin-modal").classList.add("hidden"); }

async function updateMemberRole(mid, role) { return updateDoc(doc(db, "memberships", mid), { role }); }

function downloadBackup() {
  const data = {
    exportadoEm: new Date().toISOString(),
    usuario: state.user.email,
    workspaces: state.workspaces,
    decisions: state.decisions,
    actions: state.actions,
    ideas: state.ideas,
    projects: state.projects,
    memberships: state.memberships
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fioo-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(url);
  toast("Backup baixado");
}

async function importBackup(data) {
  const myWs = new Set(state.workspaces.map((w) => w.id));
  const fix = (o) => {
    const x = { ...o };
    delete x.id;
    if (x.createdAt && typeof x.createdAt.seconds === "number") {
      x.createdAt = new Timestamp(x.createdAt.seconds, x.createdAt.nanoseconds || 0);
    }
    return x;
  };
  let n = 0, skipped = 0;
  for (const coll of ["projects", "decisions", "actions", "ideas", "comments"]) {
    for (const rec of (data[coll] || [])) {
      if (!rec.id || !myWs.has(rec.workspaceId) || rec.createdBy !== state.user.uid) { skipped++; continue; }
      try { await setDoc(doc(db, coll, rec.id), fix(rec)); n++; }
      catch (e) { skipped++; console.warn("Falha ao restaurar:", e); }
    }
  }
  return { n, skipped };
}

async function renderAdminModal() {
  const body = $("#admin-modal-body");
  const adminWs = state.workspaces.filter((w) => w.role === "admin");
  body.innerHTML = `
    <button class="modal-close" data-admin-close>×</button>
    <h2>Administração</h2>
    <div class="modal-section">
      <h4>Backup</h4>
      <p style="color:var(--muted);font-size:13px">Baixa um JSON com tudo a que você tem acesso (decisões, ações, ideias, projetos, empresas e membros).</p>
      <button class="btn btn-primary btn-sm" id="backup-btn">Baixar backup (JSON)</button>
    </div>
    <div class="modal-section">
      <h4>Restaurar backup</h4>
      <p style="color:var(--muted);font-size:13px">Reimporta seus registros a partir de um arquivo de backup (apenas os que você criou, nas empresas de que participa).</p>
      <input type="file" id="restore-file" accept="application/json,.json" />
    </div>
    <div class="modal-section">
      <h4>Usuários por empresa</h4>
      <div id="admin-users"><p style="color:var(--muted);font-size:13px">Carregando…</p></div>
    </div>`;
  body.querySelector("[data-admin-close]").addEventListener("click", closeAdminModal);
  $("#backup-btn").addEventListener("click", downloadBackup);
  $("#restore-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!confirm("Restaurar os registros deste backup? Registros existentes com o mesmo id serão sobrescritos.")) return;
        const { n, skipped } = await importBackup(data);
        toast(`Restaurado: ${n} · ignorado: ${skipped}`);
      } catch (err) { toast("Arquivo inválido"); }
    };
    reader.readAsText(file);
  });

  const usersEl = $("#admin-users");
  if (!adminWs.length) {
    usersEl.innerHTML = '<p style="color:var(--muted);font-size:13px">Você não administra nenhuma empresa.</p>';
    return;
  }
  const blocks = [];
  for (const w of adminWs) {
    let members = [];
    try { members = await membersOf(w.id); } catch (_) {}
    blocks.push(`
      <div class="admin-ws">
        <div class="ws-row-name" style="margin-bottom:6px">🏢 ${escapeHtml(w.name)}</div>
        ${members.map((m) => `
          <div class="ws-row">
            <div>${escapeHtml(m.email || m.uid)} <span class="ws-row-role">${m.role === "admin" ? "admin" : "membro"}</span></div>
            <div class="ws-row-actions">
              ${m.uid !== state.user.uid ? `
                <button class="btn btn-ghost btn-sm" data-role="${m.id}" data-newrole="${m.role === "admin" ? "membro" : "admin"}">${m.role === "admin" ? "Tornar membro" : "Tornar admin"}</button>
                <button class="btn btn-ghost btn-sm" data-rm="${m.id}">Remover</button>` : "<span class='ws-row-role'>você</span>"}
            </div>
          </div>`).join("")}
      </div>`);
  }
  usersEl.innerHTML = blocks.join("");
  usersEl.querySelectorAll("[data-role]").forEach((b) =>
    b.addEventListener("click", async () => { await updateMemberRole(b.dataset.role, b.dataset.newrole); toast("Papel atualizado"); renderAdminModal(); }));
  usersEl.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", async () => { if (!confirm("Remover este usuário da empresa?")) return; await removeMember(b.dataset.rm); toast("Usuário removido"); renderAdminModal(); }));
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

function collForType(t) {
  return t === "decision" ? "decisions" : t === "idea" ? "ideas" : t === "project" ? "projects" : "actions";
}
function listForType(t) {
  return t === "decision" ? state.decisions : t === "idea" ? state.ideas : t === "project" ? state.projects : state.actions;
}

function currentRecord() {
  return listForType(modal.type).find((x) => x.id === modal.id) || null;
}
function isMine(rec) { return rec && state.user && rec.createdBy === state.user.uid; }

function renderModal() {
  const rec = currentRecord();
  const body = $("#decision-modal-body");
  if (!rec) { closeModal(); return; }
  const ta0 = body.querySelector(".comment-form textarea");
  const draft = ta0 ? ta0.value : "";
  let html;
  if (modal.mode === "createAction") html = createActionForm(rec);
  else if (modal.mode === "edit") html = editForm(rec);
  else html = modal.type === "decision" ? decisionView(rec)
    : modal.type === "idea" ? ideaView(rec)
    : modal.type === "project" ? projectView(rec) : actionView(rec);
  body.innerHTML = html;
  wireModal();
  const ta = body.querySelector(".comment-form textarea");
  if (ta && draft) ta.value = draft;
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

  const form = body.querySelector("form.capture-form");
  if (form) form.addEventListener("submit", onModalSubmit);

  // comentários
  const cform = body.querySelector(".comment-form");
  if (cform) cform.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rec = currentRecord();
    const text = e.target.text.value.trim();
    if (!rec || !text) return;
    await saveComment(modal.type, rec.id, rec.workspaceId, text);
    e.target.reset();
  });
  body.querySelectorAll("[data-delc]").forEach((b) =>
    b.addEventListener("click", async () => { await deleteRecord("comments", b.dataset.delc); }));

  // checklist
  body.querySelectorAll("[data-check]").forEach((cb) =>
    cb.addEventListener("change", () => { const a = currentRecord(); if (a) toggleCheck(a, +cb.dataset.check); }));
  body.querySelectorAll("[data-checkdel]").forEach((b) =>
    b.addEventListener("click", () => { const a = currentRecord(); if (a) delCheck(a, +b.dataset.checkdel); }));
  const chf = body.querySelector(".check-form");
  if (chf) chf.addEventListener("submit", (e) => {
    e.preventDefault();
    const a = currentRecord();
    const t = e.target.text.value.trim();
    if (a && t) { addCheck(a, t); e.target.reset(); }
  });
}

async function onModalSubmit(e) {
  e.preventDefault();
  const f = e.target;

  const rec = currentRecord();
  const recWs = rec ? rec.workspaceId : captureWs();

  // criar nova ação a partir da decisão aberta (herda a empresa da decisão)
  if (modal.mode === "createAction") {
    const projectId = await resolveProjectFromSelect(f.projectId, recWs);
    const { assignee, assigneeUid } = resolveAssignee(f, recWs);
    await saveAction({
      title: f.title.value.trim(),
      type: f.type.value,
      assignee, assigneeUid,
      dueDate: f.dueDate.value || null,
      decisionId: modal.id,
      status: f.status.value,
      tags: parseTags(f.tags.value), links: parseLinks(f.links.value),
      recurrence: f.recurrence.value || "none", checklist: [],
      projectId, workspaceId: recWs
    });
    modal.mode = "view";
    renderModal();
    toast("Ação criada e vinculada");
    return;
  }

  if (modal.type === "decision") {
    const projectId = await resolveProjectFromSelect(f.projectId, recWs);
    const supersedesId = f.supersedesId.value || null;
    await updateDecision(modal.id, {
      title: f.title.value.trim(),
      context: f.context.value.trim(),
      rationale: f.rationale.value.trim(),
      participants: f.participants.value.trim(),
      decidedAt: f.decidedAt.value || null,
      status: f.status.value,
      supersedesId,
      tags: parseTags(f.tags.value), links: parseLinks(f.links.value),
      projectId
    });
    if (supersedesId && supersedesId !== modal.id) {
      try { await updateDecision(supersedesId, { status: "revogada" }); } catch (_) {}
    }
  } else if (modal.type === "idea") {
    await updateIdea(modal.id, { title: f.title.value.trim(), note: f.note.value.trim(), tags: parseTags(f.tags.value) });
  } else {
    const projectId = await resolveProjectFromSelect(f.projectId, recWs);
    const { assignee, assigneeUid } = resolveAssignee(f, recWs);
    await updateAction(modal.id, {
      title: f.title.value.trim(),
      type: f.type.value,
      assignee, assigneeUid,
      dueDate: f.dueDate.value || null,
      decisionId: f.decisionId.value || null,
      status: f.status.value,
      tags: parseTags(f.tags.value), links: parseLinks(f.links.value),
      recurrence: f.recurrence.value || "none",
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
    ${tagsSection(d)}
    ${linksSection(d)}
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
    </div>
    ${commentsSection(d)}`;
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
    ${a.recurrence && a.recurrence !== "none" ? section("Recorrência", a.recurrence === "weekly" ? "🔁 Toda semana" : "🔁 Todo mês") : ""}
    ${tagsSection(a)}
    ${linksSection(a)}
    ${checklistSection(a)}
    <div class="modal-section" style="display:flex;gap:8px;justify-content:flex-end">${ownerButtons(a)}</div>
    ${commentsSection(a)}`;
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

function projectView(p) {
  const items = [];
  activeDecisions().filter((x) => x.projectId === p.id).forEach((d) => items.push({ kind: "decision", ...d }));
  activeActions().filter((x) => x.projectId === p.id).forEach((a) => items.push({ kind: "action", ...a }));
  activeIdeas().filter((x) => x.projectId === p.id).forEach((i) => items.push({ kind: "idea", ...i }));
  items.sort((a, b) => tsMillis(a.createdAt) - tsMillis(b.createdAt));

  return `
    <button class="modal-close" data-close>×</button>
    <span class="tag tag-project">📁 Projeto</span>
    <h2>${escapeHtml(p.name)}</h2>
    <div class="modal-section">
      <h4>Linha do tempo (${items.length})</h4>
      <div class="timeline">
        ${items.map((it) => {
          const label = it.kind === "decision" ? "Decisão" : it.kind === "idea" ? "Ideia" : (TYPE_LABEL[it.type] || it.type);
          const tagcls = it.kind === "decision" ? "tag-decision" : it.kind === "idea" ? "tag-idea" : "tag-" + it.type;
          const status = it.kind === "action" ? (STATUS_LABEL[it.status] || "")
            : it.kind === "decision" ? (DSTATUS_LABEL[it.status || "vigente"] || "") : "";
          return `
            <div class="tl-item inline-link" data-open="${it.id}" data-open-type="${it.kind}">
              <div class="tl-date">${fmtDate(it.createdAt)}</div>
              <div class="tl-body"><span class="tag ${tagcls}">${label}</span> ${escapeHtml(it.title)}${status ? ` <span class="tl-status">· ${status}</span>` : ""}</div>
            </div>`;
        }).join("") || '<p style="color:var(--muted);font-size:13px">Nada neste projeto ainda.</p>'}
      </div>
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

function memberOptions(wsId, selectedUid) {
  return '<option value="">Responsável: membro… (opcional)</option>' +
    membersOfWs(wsId).map((m) =>
      `<option value="${m.uid}" ${m.uid === selectedUid ? "selected" : ""}>${escapeHtml(m.email || m.uid)}</option>`).join("");
}
function actionFieldsForm(rec, wsId) {
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
        <select name="assigneeUid">${memberOptions(wsId, r.assigneeUid)}</select>
        <input name="dueDate" type="date" value="${r.dueDate || ""}" />
      </div>
      <input name="assignee" placeholder="…ou responsável externo" value="${escapeAttr(r.assignee)}" />
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
      <div class="capture-grid">
        <input name="tags" placeholder="Etiquetas" value="${escapeAttr((r.tags || []).join(", "))}" />
        <select name="recurrence">
          ${[["none", "Sem recorrência"], ["weekly", "Repete toda semana"], ["monthly", "Repete todo mês"]].map(([k, v]) =>
            `<option value="${k}" ${k === (r.recurrence || "none") ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </div>
      <input name="links" placeholder="Links (https://…)" value="${escapeAttr((r.links || []).join(", "))}" />
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
    ${actionFieldsForm({ projectId: decision.projectId, status: "aberta", type: "tarefa" }, decision.workspaceId)}`;
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
        <div class="capture-grid">
          <input name="tags" placeholder="Etiquetas" value="${escapeAttr((rec.tags || []).join(", "))}" />
          <input name="links" placeholder="Links (https://…)" value="${escapeAttr((rec.links || []).join(", "))}" />
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
        <input name="tags" placeholder="Etiquetas" value="${escapeAttr((rec.tags || []).join(", "))}" />
        <div class="capture-footer" style="gap:8px">
          <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </form>`;
  }
  return `
    <button class="modal-close" data-close>×</button>
    <h2>Editar ação</h2>
    ${actionFieldsForm(rec, rec.workspaceId)}`;
}

function section(title, html) {
  return `<div class="modal-section"><h4>${title}</h4><div>${html}</div></div>`;
}

function tagsSection(rec) {
  return (rec.tags && rec.tags.length) ? section("Etiquetas", tagsChips(rec)) : "";
}
function linksSection(rec) {
  const links = rec.links || [];
  if (!links.length) return "";
  return section("Links", links.map((u) =>
    `<div><a href="${escapeAttr(u)}" target="_blank" rel="noopener" class="ext-link">🔗 ${escapeHtml(u)}</a></div>`).join(""));
}
function checklistSection(a) {
  const list = a.checklist || [];
  const mine = isMine(a);
  return `
    <div class="modal-section">
      <h4>Checklist (${list.filter((c) => c.done).length}/${list.length})</h4>
      <div class="checklist">
        ${list.map((c, i) => `
          <label class="check-item">
            <input type="checkbox" data-check="${i}" ${c.done ? "checked" : ""} ${mine ? "" : "disabled"} />
            <span class="${c.done ? "check-done" : ""}">${escapeHtml(c.text)}</span>
            ${mine ? `<button class="check-del" data-checkdel="${i}" title="Remover">×</button>` : ""}
          </label>`).join("") || '<p style="color:var(--muted);font-size:13px">Sem itens.</p>'}
      </div>
      ${mine ? `<form class="check-form"><input name="text" placeholder="Adicionar item…" /><button class="btn btn-ghost btn-sm" type="submit">Adicionar</button></form>` : ""}
    </div>`;
}
async function toggleCheck(a, i) {
  const list = (a.checklist || []).map((c, idx) => idx === i ? { text: c.text, done: !c.done } : c);
  return updateAction(a.id, { checklist: list });
}
async function addCheck(a, text) {
  return updateAction(a.id, { checklist: [...(a.checklist || []), { text, done: false }] });
}
async function delCheck(a, i) {
  return updateAction(a.id, { checklist: (a.checklist || []).filter((_, idx) => idx !== i) });
}

function highlightMentions(html) {
  return html.replace(/@([\wÀ-ÿ.\-]+)/g, '<span class="mention">@$1</span>');
}
function commentsSection(rec) {
  const list = commentsFor(rec.id);
  return `
    <div class="modal-section">
      <h4>Comentários (${list.length})</h4>
      <div class="comments">
        ${list.map((c) => `
          <div class="comment">
            <div class="comment-head">
              <strong>${escapeHtml(c.createdByName || "")}</strong>
              <span class="comment-date">${fmtDate(c.createdAt)}</span>
              ${c.createdBy === state.user.uid ? `<button class="comment-del" data-delc="${c.id}" title="Excluir">×</button>` : ""}
            </div>
            <div>${highlightMentions(escapeHtml(c.text).replace(/\n/g, "<br>"))}</div>
          </div>`).join("") || '<p style="color:var(--muted);font-size:13px">Nenhum comentário ainda.</p>'}
      </div>
      <form class="comment-form">
        <textarea name="text" rows="2" placeholder="Comentar… use @ para mencionar alguém" required></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:6px">
          <button type="submit" class="btn btn-primary btn-sm">Comentar</button>
        </div>
      </form>
    </div>`;
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
// TEMA (claro / escuro)
// ===========================================================================
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  const btn = $("#theme-btn");
  if (btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f4f6fb" : "#0f1626");
}
function initTheme() {
  let saved = "dark";
  try { saved = localStorage.getItem("fioo-theme") || "dark"; } catch (_) {}
  applyTheme(saved);
  const btn = $("#theme-btn");
  if (btn) btn.addEventListener("click", () => {
    const now = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(now);
    try { localStorage.setItem("fioo-theme", now); } catch (_) {}
  });
}

// ===========================================================================
// BOOT
// ===========================================================================
try { state.currentWs = localStorage.getItem("fioo-ws") || "all"; } catch (_) {}
initTheme();
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
