/* 10MinMail — disposable email front-end on top of the mail.tm API.
   Real addresses, real inbound mail. Session persisted in localStorage so a
   page refresh keeps the same mailbox until its 10-minute timer runs out. */

const API = "https://api.mail.tm";
const LIFETIME = 10 * 60 * 1000; // 10 minutes per cycle
const MAX_LIFETIME = 60 * 60 * 1000; // hard cap: 60 minutes total
const POLL_MS = 5000;
const STORE_KEY = "tenminmail.session";

const $ = (id) => document.getElementById(id);
const el = {
  address: $("address"),
  timer: $("timer"),
  copy: $("copyBtn"),
  extend: $("extendBtn"),
  new: $("newBtn"),
  refresh: $("refreshBtn"),
  list: $("list"),
  reader: $("reader"),
  empty: $("empty"),
  count: $("count"),
  toast: $("toast"),
  poll: $("poll"),
};

let session = null; // {address, password, id, token, createdAt, expiresAt}
let messages = []; // cached list
let seen = new Set(); // ids we've already shown (for "new mail" detection)
let openId = null;
let pollTimer = null,
  tickTimer = null;
let expired = false;

/* ---------- helpers ---------- */
const rand = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36])
    .join("");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Fetch with back-off. mail.tm is rate-limited (~8 req/s → 429); polling plus
   user actions can trip it, and brief network/5xx blips happen. Retry those a
   few times (honouring Retry-After) instead of surfacing them as hard errors. */
async function api(path, { method = "GET", body, token, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      if (attempt >= retries)
        throw new Error("Network error — check your connection");
      await sleep(400 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(ra > 0 ? ra * 1000 : 400 * 2 ** attempt);
      continue;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        data["hydra:description"] || data.detail || res.statusText,
      );
    return data;
  }
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.style.opacity = "1";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.toast.style.opacity = "0"), 1800);
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(session));
}
function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY));
  } catch {
    return null;
  }
}

/* ---------- mailbox lifecycle ---------- */
async function getDomain() {
  const d = await api("/domains?page=1");
  const active = (d["hydra:member"] || []).find(
    (x) => x.isActive && !x.isPrivate,
  );
  if (!active) throw new Error("No mail domain available right now");
  return active.domain;
}

async function createMailbox() {
  const domain = await getDomain();
  const address = `${rand(10)}@${domain}`;
  const password = rand(16);
  const acct = await api("/accounts", {
    method: "POST",
    body: { address, password },
  });
  const tok = await api("/token", {
    method: "POST",
    body: { address, password },
  });
  const now = Date.now();
  session = {
    address,
    password,
    id: acct.id,
    token: tok.token,
    createdAt: now,
    expiresAt: now + LIFETIME,
  };
  save();
  messages = [];
  seen = new Set();
  openId = null;
  expired = false;
  render();
  renderInbox();
}

async function deleteMailbox(s) {
  if (!s?.id || !s?.token) return;
  try {
    await api(`/accounts/${s.id}`, { method: "DELETE", token: s.token });
  } catch {}
}

async function resume() {
  const s = load();
  if (s && s.expiresAt > Date.now()) {
    session = s;
    expired = false;
    render();
    renderInbox();
    return;
  }
  if (s) await deleteMailbox(s); // stale — clean up
  await createMailbox();
}

/* ---------- actions ---------- */
let creating = false;
async function actNew() {
  if (creating) return; // ignore rapid clicks → avoid orphan mailboxes
  creating = true;
  const old = session;
  const prev = el.address.textContent;
  el.address.textContent = "generating…";
  try {
    await createMailbox();
    await deleteMailbox(old);
    toast("New address ready");
    startPolling();
  } catch (e) {
    el.address.textContent = prev; // keep current address usable on failure
    toast("Couldn't get a new address: " + e.message);
  } finally {
    creating = false;
  }
}

function actExtend() {
  if (!session || expired) return;
  const cap = session.createdAt + MAX_LIFETIME;
  session.expiresAt = Math.min(Date.now() + LIFETIME, cap);
  save();
  toast(session.expiresAt >= cap ? "Reached 60-min max" : "Extended +10 min");
}

async function actCopy() {
  try {
    await navigator.clipboard.writeText(session.address);
    toast("Address copied");
  } catch {
    toast("Copy failed");
  }
}

/* ---------- inbox ---------- */
async function poll() {
  if (!session || expired) return;
  try {
    const d = await api("/messages?page=1", { token: session.token });
    const list = d["hydra:member"] || [];
    const fresh = list.some((m) => !seen.has(m.id));
    messages = list;
    if (fresh && seen.size > 0) toast("📬 New email received");
    list.forEach((m) => seen.add(m.id));
    renderInbox();
  } catch (e) {
    /* token may briefly 401 right after create; ignore */
  }
}

async function openMessage(id) {
  openId = id;
  el.reader.classList.remove("hidden");
  el.reader.innerHTML = `<div class="text-slate-500 text-sm">Loading…</div>`;
  renderInbox();
  try {
    const m = await api(`/messages/${id}`, { token: session.token });
    await api(`/messages/${id}`, {
      method: "PATCH",
      token: session.token,
      body: { seen: true },
    }).catch(() => {});
    const from = m.from?.address || "unknown";
    const date = new Date(m.createdAt).toLocaleString();
    const bodyHtml = m.html && m.html.length ? m.html.join("") : null;
    el.reader.innerHTML = `
      <div class="mb-4">
        <h3 class="text-white font-semibold text-base mb-1 break-words">${esc(m.subject || "(no subject)")}</h3>
        <div class="text-sm text-slate-400 break-words">from <span class="text-slate-200">${esc(from)}</span></div>
        <div class="text-xs text-slate-500 mt-0.5">${date}</div>
      </div>`;
    if (bodyHtml) {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "");
      frame.className = "w-full rounded-lg bg-white";
      frame.style.height = "55vh";
      frame.srcdoc = bodyHtml;
      el.reader.appendChild(frame);
    } else {
      const pre = document.createElement("pre");
      pre.className =
        "whitespace-pre-wrap text-sm text-slate-300 leading-relaxed";
      pre.textContent = m.text || "(empty message)";
      el.reader.appendChild(pre);
    }
  } catch (e) {
    el.reader.innerHTML = `<div class="text-rose-400 text-sm">Could not load message: ${esc(e.message)}</div>`;
  }
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function renderInbox() {
  el.count.textContent = String(messages.length);
  el.empty.style.display = messages.length ? "none" : "block";
  el.list.innerHTML = messages
    .map((m) => {
      const from = m.from?.address || "unknown";
      const time = new Date(m.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const active = m.id === openId ? "bg-accent/15" : "hover:bg-edge/60";
      const unread = !m.seen
        ? `<span class="h-2 w-2 rounded-full bg-accent shrink-0 mt-1.5"></span>`
        : `<span class="w-2 shrink-0"></span>`;
      return `<li data-id="${m.id}" class="ping-in cursor-pointer px-4 py-3 flex gap-2.5 transition ${active}">
      ${unread}
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-sm font-medium text-slate-100 truncate">${esc(from)}</span>
          <span class="text-[11px] text-slate-500 shrink-0">${time}</span>
        </div>
        <div class="text-sm text-slate-300 truncate ${m.seen ? "" : "font-semibold"}">${esc(m.subject || "(no subject)")}</div>
        <div class="text-xs text-slate-500 truncate">${esc(m.intro || "")}</div>
      </div>
    </li>`;
    })
    .join("");
  el.list
    .querySelectorAll("li")
    .forEach((li) =>
      li.addEventListener("click", () => openMessage(li.dataset.id)),
    );
}

/* ---------- timer ---------- */
function render() {
  el.address.textContent = session.address;
}

function tick() {
  if (!session) return;
  const left = session.expiresAt - Date.now();
  if (left <= 0) return onExpire();
  const m = Math.floor(left / 60000),
    s = Math.floor((left % 60000) / 1000);
  el.timer.textContent = `${m}:${String(s).padStart(2, "0")}`;
  el.timer.className =
    "font-mono text-2xl sm:text-3xl font-bold tabular-nums leading-none " +
    (left < 30000
      ? "text-rose-400"
      : left < 120000
        ? "text-amber-400"
        : "text-emerald-400");
}

async function onExpire() {
  if (expired) return;
  expired = true;
  el.timer.textContent = "0:00";
  el.timer.className = "font-mono text-2xl sm:text-3xl font-bold text-rose-500";
  clearInterval(pollTimer);
  el.poll.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span> expired`;
  el.list.innerHTML = "";
  el.reader.classList.add("hidden");
  el.empty.style.display = "block";
  el.empty.innerHTML = `<div class="text-4xl mb-3">⌛</div>
    <p class="text-slate-200 font-medium">This address expired</p>
    <p class="text-slate-500 text-sm mt-1 mb-4">Its inbox was wiped. Grab a fresh one to keep going.</p>
    <button id="restart" class="px-4 py-2 rounded-lg bg-accent hover:bg-indigo-500 text-white text-sm font-medium">Get a new address</button>`;
  $("restart").addEventListener("click", actNew);
  const old = session;
  await deleteMailbox(old);
  localStorage.removeItem(STORE_KEY);
}

function startPolling() {
  clearInterval(pollTimer);
  el.poll.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span> auto-refreshing`;
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

/* ---------- wire up ---------- */
el.copy.addEventListener("click", actCopy);
el.address.addEventListener("click", actCopy);
el.extend.addEventListener("click", actExtend);
el.new.addEventListener("click", actNew);
el.refresh.addEventListener("click", () => {
  poll();
  toast("Refreshed");
});

(async function main() {
  tickTimer = setInterval(tick, 1000);
  try {
    await resume();
    tick();
    startPolling();
  } catch (e) {
    el.address.textContent = "error";
    toast("Failed to create mailbox: " + e.message);
  }
})();
