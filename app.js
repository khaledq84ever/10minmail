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
  new: $("newBtn"),
  refresh: $("refreshBtn"),
  box: $("box"),
  list: $("list"),
  reader: $("reader"),
  empty: $("empty"),
  count: $("count"),
  toast: $("toast"),
  poll: $("poll"),
  lang: $("langBtn"),
};

/* ---------- i18n (Arabic-first, English toggle) ---------- */
const I18N = {
  ar: {
    subtitle: "بريد مؤقت · بدون تسجيل",
    auto_delete: "يُحذف تلقائيًا عند الانتهاء",
    title_addr: "عنوانك المؤقت",
    expires_in: "ينتهي خلال",
    new_email: "بريد جديد",
    refresh: "تحديث",
    refresh_title: "تحديث الوارد · +10 دقائق",
    inbox: "الوارد",
    waiting: "بانتظار الرسائل…",
    waiting_sub: "استخدم العنوان أعلاه للتسجيل في أي مكان.",
    footer_note:
      "مزوّد البريد mail.tm · للاختبار والتسجيلات المؤقتة فقط — لا تستخدمه لحسابات حساسة.",
    built_by: "برمجة",
    copy_aria: "نسخ العنوان",
    click_copy: "اضغط للنسخ",
    auto_refreshing: "تحديث تلقائي",
    reconnecting: "إعادة الاتصال…",
    expired_pill: "منتهٍ",
    generating: "جارٍ الإنشاء…",
    new_ready: "تم تجهيز بريد جديد",
    new_fail: "تعذّر الحصول على بريد جديد: ",
    max_60: "بلغت الحد الأقصى 60 دقيقة",
    refreshed_10: "+10 دقائق · تم التحديث",
    copied: "تم نسخ العنوان",
    copy_fail: "فشل النسخ",
    new_mail: "📬 وصلت رسالة جديدة",
    loading: "جارٍ التحميل…",
    from: "من",
    no_subject: "(بدون موضوع)",
    empty_msg: "(رسالة فارغة)",
    select_msg: "اختر رسالة لقراءتها هنا",
    load_fail: "تعذّر تحميل الرسالة: ",
    create_fail: "تعذّر إنشاء البريد: ",
    error: "خطأ",
    expired_title: "انتهى هذا العنوان",
    expired_sub: "تم مسح الوارد. احصل على عنوان جديد للمتابعة.",
    get_new: "احصل على بريد جديد",
  },
  en: {
    subtitle: "Disposable Email · No Signup",
    auto_delete: "Auto-Deletes On Expiry",
    title_addr: "Your Temporary Address",
    expires_in: "Expires In",
    new_email: "New Email",
    refresh: "Refresh",
    refresh_title: "Reload Inbox · +10 Min",
    inbox: "Inbox",
    waiting: "Waiting For Emails…",
    waiting_sub: "Use The Address Above To Sign Up Anywhere.",
    footer_note:
      "Mail Backend By mail.tm · For Testing & Throwaway Signups Only — Never Use For Sensitive Accounts.",
    built_by: "Built By",
    copy_aria: "Copy Address",
    click_copy: "Click To Copy",
    auto_refreshing: "Auto-Refreshing",
    reconnecting: "Reconnecting…",
    expired_pill: "Expired",
    generating: "Generating…",
    new_ready: "New Email Ready",
    new_fail: "Couldn't Get A New Email: ",
    max_60: "Reached 60-Min Max",
    refreshed_10: "+10 Min · Refreshed",
    copied: "Address Copied",
    copy_fail: "Copy Failed",
    new_mail: "📬 New Email Received",
    loading: "Loading…",
    from: "From",
    no_subject: "(no subject)",
    empty_msg: "(empty message)",
    select_msg: "Select A Message To Read It Here",
    load_fail: "Could Not Load Message: ",
    create_fail: "Failed To Create Mailbox: ",
    error: "Error",
    expired_title: "This Address Expired",
    expired_sub: "Its Inbox Was Wiped. Grab A Fresh One To Keep Going.",
    get_new: "Get A New Email",
  },
};
const LANG_KEY = "tenminmail.lang";
let LANG = "ar";
try {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "ar" || saved === "en") LANG = saved;
} catch {}
const t = (k) => (I18N[LANG] && I18N[LANG][k]) ?? I18N.en[k] ?? k;

/* Apply a language: flip dir/lang + font, translate all static [data-i18n]
   nodes (and title/aria attributes), then repaint the dynamic bits. */
function applyLang(lang) {
  LANG = lang === "en" ? "en" : "ar";
  try {
    localStorage.setItem(LANG_KEY, LANG);
  } catch {}
  const html = document.documentElement;
  html.lang = LANG;
  html.dir = LANG === "ar" ? "rtl" : "ltr";
  document
    .querySelectorAll("[data-i18n]")
    .forEach((n) => (n.textContent = t(n.getAttribute("data-i18n"))));
  document
    .querySelectorAll("[data-i18n-title]")
    .forEach((n) =>
      n.setAttribute("title", t(n.getAttribute("data-i18n-title"))),
    );
  document
    .querySelectorAll("[data-i18n-aria]")
    .forEach((n) =>
      n.setAttribute("aria-label", t(n.getAttribute("data-i18n-aria"))),
    );
  if (el.lang) el.lang.textContent = LANG === "ar" ? "EN" : "ع";
  // Repaint dynamic content in the new language.
  if (expired) paintExpired();
  else {
    setPollStatus(pollFails >= 2 ? "retry" : "live");
    if (session) renderInbox();
  }
}

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
  el.address.textContent = t("generating");
  try {
    await createMailbox();
    await deleteMailbox(old);
    toast(t("new_ready"));
    startPolling();
  } catch (e) {
    el.address.textContent = prev; // keep current address usable on failure
    toast(t("new_fail") + e.message);
  } finally {
    creating = false;
  }
}

/* Refresh: reload the inbox AND add +10 min to the remaining time (so the
   mailbox can run past its first 10 minutes), still bounded by the 60-min
   hard cap, then repaint the timer instantly. */
function actRefresh() {
  if (!session || expired) return;
  const cap = session.createdAt + MAX_LIFETIME;
  session.expiresAt = Math.min(session.expiresAt + LIFETIME, cap);
  save();
  tick();
  poll();
  toast(session.expiresAt >= cap ? t("max_60") : t("refreshed_10"));
}

async function actCopy() {
  try {
    await navigator.clipboard.writeText(session.address);
    toast(t("copied"));
  } catch {
    toast(t("copy_fail"));
  }
}

/* ---------- inbox ---------- */
let pollFails = 0;
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
    if (fresh && seen.size > 0) toast(t("new_mail"));
    list.forEach((m) => seen.add(m.id));
    renderInbox();
    saveMsgs();
    if (pollFails) {
      pollFails = 0; // recovered — back to the normal live indicator
      setPollStatus("live");
    }
  } catch (e) {
    // api() already retried transient 429/5xx; a throw here means we're
    // genuinely offline (or the token briefly 401s right after create, which
    // the next poll retries). After a couple of misses, stop pretending we're
    // live and show a "reconnecting" state so the user isn't misled.
    if (++pollFails >= 2) setPollStatus("retry");
  }
}

async function openMessage(id) {
  openId = id;
  // Mark read locally right away so the unread dot/bold clears instantly,
  // instead of waiting for the next poll to reflect the server PATCH below.
  const opened = messages.find((m) => m.id === id);
  if (opened) opened.seen = true;
  el.reader.classList.remove("hidden");
  el.reader.innerHTML = `<div class="text-slate-500 text-sm">${t("loading")}</div>`;
  renderInbox();
  saveMsgs();
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
        <h3 class="text-white font-semibold text-base mb-1 break-words">${esc(m.subject || t("no_subject"))}</h3>
        <div class="text-sm text-slate-400 break-words">${t("from")} <span dir="ltr" class="text-slate-200 font-semibold">${esc(from)}</span></div>
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
      pre.textContent = m.text || t("empty_msg");
      el.reader.appendChild(pre);
    }
  } catch (e) {
    el.reader.innerHTML = `<div class="text-rose-400 text-sm">${t("load_fail")}${esc(e.message)}</div>`;
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
  // Fill the otherwise-blank desktop reader pane with a hint until a message is opened.
  if (messages.length && !openId) {
    el.reader.innerHTML = `<div class="hidden md:flex h-full items-center justify-center text-slate-500 text-sm">${t("select_msg")}</div>`;
  }
  el.list.innerHTML = messages
    .map((m) => {
      const from = m.from?.address || "unknown";
      const time = new Date(m.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const active =
        m.id === openId
          ? "bg-emerald-400/10 shadow-[inset_3px_0_0_#34d399]"
          : "hover:bg-white/[0.04]";
      const unread = !m.seen
        ? `<span class="h-2 w-2 rounded-full bg-mint shadow-[0_0_8px_#34d399] shrink-0 mt-1.5"></span>`
        : `<span class="w-2 shrink-0"></span>`;
      return `<li data-id="${m.id}" class="ping-in cursor-pointer px-4 py-3 flex gap-2.5 transition ${active}">
      ${unread}
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-2">
          <span dir="ltr" class="text-sm font-bold text-slate-100 truncate">${esc(from)}</span>
          <span dir="ltr" class="text-[11px] text-slate-500 shrink-0">${time}</span>
        </div>
        <div class="text-sm text-slate-300 truncate ${m.seen ? "" : "font-semibold"}">${esc(m.subject || t("no_subject"))}</div>
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
    "font-mono text-3xl sm:text-4xl font-extrabold tabular-nums leading-none sm:text-right " +
    (left < 30000
      ? "text-rose-400"
      : left < 120000
        ? "text-amber-400"
        : "text-emerald-400");
}

// Paint the terminal "expired" state into the inbox card. Split out so a
// language toggle can repaint it in the new language.
function paintExpired() {
  el.poll.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-rose-500"></span> ${t("expired_pill")}`;
  el.list.innerHTML = "";
  el.reader.classList.add("hidden");
  el.box.style.display = "none";
  el.empty.style.display = "block";
  el.empty.innerHTML = `<div class="mx-auto mb-3 h-12 w-12 rounded-2xl btn-ghost grid place-items-center text-rose-400">
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    </div>
    <p class="text-slate-100 font-bold text-sm">${t("expired_title")}</p>
    <p class="text-slate-500 text-xs mt-1.5 mb-4">${t("expired_sub")}</p>
    <button id="restart" class="px-4 py-2.5 rounded-xl btn-accent text-sm font-extrabold transition hover:-translate-y-0.5">${t("get_new")}</button>`;
  $("restart").addEventListener("click", actNew);
}

async function onExpire() {
  if (expired) return;
  expired = true;
  el.timer.textContent = "0:00";
  el.timer.className =
    "font-mono text-3xl sm:text-4xl font-extrabold text-rose-500 tabular-nums leading-none sm:text-end";
  clearInterval(pollTimer);
  paintExpired();
  const old = session;
  await deleteMailbox(old);
  localStorage.removeItem(STORE_KEY);
  localStorage.removeItem(STORE_MSGS);
}

// The little inbox status pill: green "auto-refreshing" when polling is healthy,
// amber "reconnecting…" once polls start failing. (onExpire paints its own red
// "expired" state, so never override that.)
function setPollStatus(state) {
  if (expired) return;
  const [dot, label] =
    state === "retry"
      ? ["bg-amber-400", t("reconnecting")]
      : ["bg-emerald-400 dot-live", t("auto_refreshing")];
  el.poll.innerHTML = `<span class="h-1.5 w-1.5 rounded-full ${dot}"></span> ${label}`;
}

function startPolling() {
  clearInterval(pollTimer);
  pollFails = 0;
  setPollStatus("live");
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

/* Don't keep hammering the rate-limited API while the tab is in the background
   (the common case: user switches away to trigger a verification email). Pause
   polling when hidden, then do an immediate catch-up poll the moment they return
   so any mail that arrived while away shows instantly. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(pollTimer);
    pollTimer = null;
  } else if (session && !expired) {
    startPolling();
  }
});

/* ---------- wire up ---------- */
el.copy.addEventListener("click", actCopy);
el.address.addEventListener("click", actCopy);
el.new.addEventListener("click", actNew);
el.refresh.addEventListener("click", actRefresh);
if (el.lang)
  el.lang.addEventListener("click", () =>
    applyLang(LANG === "ar" ? "en" : "ar"),
  );

(async function main() {
  applyLang(LANG); // Arabic-first (or the saved choice) before anything renders
  tickTimer = setInterval(tick, 1000);
  try {
    await resume();
    tick();
    startPolling();
  } catch (e) {
    el.address.textContent = t("error");
    toast(t("create_fail") + e.message);
  }
})();
