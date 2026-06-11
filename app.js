/* 10MinMail — disposable email front-end on top of the mail.tm API.
   Real addresses, real inbound mail. Session persisted in localStorage so a
   page refresh keeps the same mailbox until its 10-minute timer runs out. */

const API = "https://api.mail.tm";
const LIFETIME = 10 * 60 * 1000; // 10 minutes per cycle
const MAX_LIFETIME = 60 * 60 * 1000; // hard cap: 60 minutes total
const POLL_MS = 5000;
const STORE_KEY = "tenminmail.session";
const STORE_MSGS = "tenminmail.inbox";

const $ = (id) => document.getElementById(id);
const el = {
  address: $("address"),
  timer: $("timer"),
  copy: $("copyBtn"),
  extend: $("extendBtn"),
  new: $("newBtn"),
  refresh: $("refreshBtn"),
  box: $("box"),
  list: $("list"),
  reader: $("reader"),
  empty: $("empty"),
  count: $("count"),
  toast: $("toast"),
  poll: $("poll"),
};

// The inbox empty-state markup as shipped in index.html. onExpire() overwrites
// it with an "expired" message, so we keep the original to restore on a fresh box.
const DEFAULT_EMPTY_HTML = el.empty.innerHTML;

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
    if (!res.ok) {
      const err = new Error(
        data["hydra:description"] || data.detail || res.statusText,
      );
      err.status = res.status;
      throw err;
    }
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
// Cache the inbox (tied to the current address) so a page refresh shows the
// existing mail instantly instead of flashing the empty state until the first poll.
function saveMsgs() {
  if (!session) return;
  try {
    localStorage.setItem(
      STORE_MSGS,
      JSON.stringify({ a: session.address, m: messages, s: [...seen] }),
    );
  } catch {}
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
  // A freshly created account isn't always ready for /token immediately
  // (brief 401 while it propagates) — retry a few times before giving up.
  let tok;
  for (let i = 0; ; i++) {
    try {
      tok = await api("/token", {
        method: "POST",
        body: { address, password },
      });
      break;
    } catch (e) {
      if (e.status !== 401 || i >= 3) throw e;
      await sleep(500 * (i + 1));
    }
  }
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
  localStorage.removeItem(STORE_MSGS); // fresh box → drop the old inbox cache
  openId = null;
  expired = false;
  // Clear any leftover "expired" message from a previous cycle's empty state.
  el.empty.innerHTML = DEFAULT_EMPTY_HTML;
  render();
  renderInbox();
}

/* mail.tm tokens can expire during a long (extended) session; re-mint one from
   the stored credentials so polling/reading keeps working without a new box. */
async function reauth() {
  if (!session) return null;
  const tok = await api("/token", {
    method: "POST",
    body: { address: session.address, password: session.password },
  });
  session.token = tok.token;
  save();
  return tok.token;
}

async function deleteMailbox(s) {
  if (!s?.id || !s?.token) return;
  try {
    await api(`/accounts/${s.id}`, { method: "DELETE", token: s.token });
  } catch {}
}

async function resume() {
  const s = load();
  if (!s) return createMailbox();
  session = s;
  expired = false;
  // A page refresh must NEVER lose the mailbox. If the 10-min timer lapsed while
  // the page was closed, renew it (keeping the SAME address) instead of wiping
  // it — mail.tm accounts only disappear when we delete them ourselves.
  if (session.expiresAt <= Date.now()) {
    session.createdAt = Date.now();
    session.expiresAt = Date.now() + LIFETIME;
  }
  // Restore the cached inbox for THIS address so mail shows instantly on refresh.
  try {
    const c = JSON.parse(localStorage.getItem(STORE_MSGS));
    if (c && c.a === session.address) {
      messages = c.m || [];
      seen = new Set(c.s || []);
    }
  } catch {}
  render();
  renderInbox();
  try {
    await reauth(); // re-mint the token; the stored one may have expired
  } catch (e) {
    if (e.status === 401) return createMailbox(); // account truly gone server-side
    // network/other blip: keep the restored mailbox; polling will retry
  }
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
  tick();
  toast(session.expiresAt >= cap ? "Reached 60-min max" : "Extended +10 min");
}

/* Refresh: reload the inbox AND renew the countdown to a fresh 10:00
   (still bounded by the 60-min hard cap), then repaint the timer instantly. */
function actRefresh() {
  if (!session || expired) return;
  const cap = session.createdAt + MAX_LIFETIME;
  session.expiresAt = Math.min(Date.now() + LIFETIME, cap);
  save();
  tick();
  poll();
  toast("Refreshed");
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
    let d;
    try {
      d = await api("/messages?page=1", { token: session.token });
    } catch (e) {
      if (e.status !== 401) throw e;
      await reauth(); // token expired mid-session — refresh and retry once
      d = await api("/messages?page=1", { token: session.token });
    }
    const list = d["hydra:member"] || [];
    const fresh = list.some((m) => !seen.has(m.id));
    messages = list;
    if (fresh && seen.size > 0) toast("📬 New email received");
    list.forEach((m) => seen.add(m.id));
    renderInbox();
    saveMsgs();
  } catch (e) {
    /* token may briefly 401 right after create; next poll retries */
  }
}

async function openMessage(id) {
  openId = id;
  el.reader.classList.remove("hidden");
  el.reader.innerHTML = `<div class="text-slate-500 text-sm">Loading…</div>`;
  renderInbox();
  try {
    let m;
    try {
      m = await api(`/messages/${id}`, { token: session.token });
    } catch (e) {
      if (e.status !== 401) throw e;
      await reauth();
      m = await api(`/messages/${id}`, { token: session.token });
    }
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
      // Keep scripts disabled, but let the user actually USE verification links:
      // allow-popups lets links open, allow-popups-to-escape-sandbox means the
      // opened page (the real verify URL) isn't itself sandboxed.
      frame.setAttribute(
        "sandbox",
        "allow-popups allow-popups-to-escape-sandbox",
      );
      frame.className = "w-full rounded-lg bg-white";
      frame.style.height = "55vh";
      // Force every link to open in a new tab so a click escapes the iframe
      // instead of trying (and failing) to navigate inside the sandbox.
      frame.srcdoc =
        `<base target="_blank" rel="noopener noreferrer">` + bodyHtml;
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
  // Show the list/reader grid only when there's mail; otherwise just the compact
  // empty state — no tall dead space when the inbox is empty.
  el.box.style.display = messages.length ? "grid" : "none";
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
    "font-mono text-2xl sm:text-3xl font-extrabold tabular-nums leading-none " +
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
  el.timer.className =
    "font-mono text-2xl sm:text-3xl font-extrabold text-rose-500 tabular-nums leading-none";
  clearInterval(pollTimer);
  el.poll.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span> expired`;
  el.list.innerHTML = "";
  el.reader.classList.add("hidden");
  el.box.style.display = "none";
  el.empty.style.display = "block";
  el.empty.innerHTML = `<div class="text-2xl mb-1.5">⌛</div>
    <p class="text-slate-200 font-semibold text-sm">This address expired</p>
    <p class="text-slate-500 text-xs mt-1 mb-3">Its inbox was wiped. Grab a fresh one to keep going.</p>
    <button id="restart" class="px-4 py-2 rounded-lg btn-accent text-white text-sm font-bold">Get a new address</button>`;
  $("restart").addEventListener("click", actNew);
  const old = session;
  await deleteMailbox(old);
  localStorage.removeItem(STORE_KEY);
  localStorage.removeItem(STORE_MSGS);
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
el.refresh.addEventListener("click", actRefresh);

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
