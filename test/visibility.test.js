/* Headless logic tests for the polling lifecycle — no browser needed.
   Loads app.js in a vm sandbox with mail.tm stubbed, then asserts:
     1. polling pauses when the tab is hidden and resumes (with an immediate
        catch-up poll) when it becomes visible again;
     2. the inbox status pill flips to "reconnecting…" after consecutive poll
        failures and back to "auto-refreshing" once a poll succeeds. */
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// --- track intervals by delay so we can tell the 5s poll loop from the 1s tick.
let nextId = 1;
const intervals = new Map(); // id -> delay
let pollFetches = 0;
let failMessages = false; // toggle to simulate the device going offline

// Stable per-id stub elements so the test can observe what app.js renders
// (e.g. the #poll status pill's innerHTML).
const els = {};
const stubEl = () => {
  const t = { style: {}, classList: { add() {}, remove() {} } };
  return new Proxy(t, {
    get(o, p) {
      if (p in o) return o[p];
      if (p === "addEventListener") return () => {};
      if (p === "querySelectorAll") return () => [];
      if (p === "querySelector") return () => null;
      if (p === "innerHTML" || p === "textContent" || p === "className")
        return "";
      return () => {};
    },
    set(o, p, v) {
      o[p] = v;
      return true;
    },
  });
};

let visHandler = null;
const sandbox = {
  console,
  document: {
    hidden: false,
    getElementById: (id) => (els[id] ||= stubEl()),
    addEventListener: (ev, fn) => {
      if (ev === "visibilitychange") visHandler = fn;
    },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  crypto: {
    getRandomValues: (a) => {
      for (let i = 0; i < a.length; i++) a[i] = i;
      return a;
    },
  },
  localStorage: (() => {
    const m = {};
    return {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => (m[k] = String(v)),
      removeItem: (k) => delete m[k],
    };
  })(),
  setTimeout: (fn) => setTimeout(fn, 0), // collapse back-off waits
  clearTimeout,
  setInterval: (fn, delay) => {
    const id = nextId++;
    intervals.set(id, delay);
    return id;
  },
  clearInterval: (id) => intervals.delete(id),
  fetch: async (url) => {
    const ok = (data) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => data,
    });
    if (url.includes("/domains"))
      return ok({
        "hydra:member": [
          { domain: "ex.com", isActive: true, isPrivate: false },
        ],
      });
    if (url.endsWith("/accounts")) return ok({ id: "acc1" });
    if (url.endsWith("/token")) return ok({ token: "tok1" });
    if (url.includes("/messages")) {
      pollFetches++;
      if (failMessages) throw new TypeError("Failed to fetch");
      return ok({ "hydra:member": [] });
    }
    return ok({});
  },
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const pollIntervals = () =>
  [...intervals.values()].filter((d) => d === 5000).length;
const pollPill = () => els.poll.innerHTML;
const flush = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  await flush(); // let main() create the mailbox and start polling

  // --- visibility lifecycle -------------------------------------------------
  assert.ok(visHandler, "visibilitychange handler should be registered");
  assert.strictEqual(pollIntervals(), 1, "polling should be active on load");
  assert.ok(pollFetches >= 1, "should have polled at least once on load");
  assert.match(pollPill(), /auto-refreshing/i, "pill should start as live");

  sandbox.document.hidden = true;
  visHandler();
  await flush();
  assert.strictEqual(pollIntervals(), 0, "polling should pause while hidden");
  const whileHidden = pollFetches;

  sandbox.document.hidden = false;
  visHandler();
  await flush();
  assert.strictEqual(pollIntervals(), 1, "polling should resume when visible");
  assert.ok(pollFetches > whileHidden, "should catch-up poll on return");

  // --- reconnecting indicator ----------------------------------------------
  failMessages = true;
  await sandbox.poll();
  await sandbox.poll(); // 2nd consecutive failure trips the "retry" state
  await flush();
  assert.match(
    pollPill(),
    /reconnecting/i,
    "pill should show reconnecting after repeated poll failures",
  );

  failMessages = false;
  await sandbox.poll(); // a successful poll should clear it
  await flush();
  assert.match(
    pollPill(),
    /auto-refreshing/i,
    "pill should return to live after a successful poll",
  );

  console.log(
    "✅ polling lifecycle OK: visibility pause/resume + reconnect status",
  );
  process.exit(0);
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
