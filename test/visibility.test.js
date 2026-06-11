/* Headless logic test for the polling lifecycle — no browser needed.
   Loads app.js in a vm sandbox with mail.tm stubbed, then asserts that
   polling pauses when the tab is hidden and resumes (with an immediate
   catch-up poll) when it becomes visible again. */
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// --- track intervals by delay so we can tell the 5s poll loop from the 1s tick.
let nextId = 1;
const intervals = new Map(); // id -> delay
let pollFetches = 0;

const stubEl = () =>
  new Proxy(
    { style: {}, classList: { add() {}, remove() {} } },
    {
      get(t, p) {
        if (p in t) return t[p];
        if (p === "addEventListener") return () => {};
        if (p === "querySelectorAll") return () => [];
        if (p === "querySelector") return () => null;
        if (p === "innerHTML" || p === "textContent" || p === "className")
          return "";
        return () => {};
      },
      set(t, p, v) {
        t[p] = v;
        return true;
      },
    },
  );

let visHandler = null;
const sandbox = {
  console,
  document: {
    hidden: false,
    getElementById: () => stubEl(),
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
      return ok({ "hydra:member": [] });
    }
    return ok({});
  },
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const pollIntervals = () =>
  [...intervals.values()].filter((d) => d === 5000).length;
const flush = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  await flush(); // let main() create the mailbox and start polling

  assert.ok(visHandler, "visibilitychange handler should be registered");
  assert.strictEqual(pollIntervals(), 1, "polling should be active on load");
  const afterLoad = pollFetches;
  assert.ok(afterLoad >= 1, "should have polled at least once on load");

  // Tab goes to background → polling must stop.
  sandbox.document.hidden = true;
  visHandler();
  await flush();
  assert.strictEqual(pollIntervals(), 0, "polling should pause while hidden");
  const whileHidden = pollFetches;

  // Tab returns → polling resumes AND does an immediate catch-up poll.
  sandbox.document.hidden = false;
  visHandler();
  await flush();
  assert.strictEqual(pollIntervals(), 1, "polling should resume when visible");
  assert.ok(
    pollFetches > whileHidden,
    "should catch-up poll immediately on return",
  );

  console.log(
    "✅ visibility polling lifecycle OK (pause on hide, catch-up + resume on show)",
  );
  process.exit(0);
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
