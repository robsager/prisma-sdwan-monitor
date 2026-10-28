// JSON calls to this server. Mutating calls carry the header the server requires (it blocks
// cross-site requests without it).

export async function api(method, path, body, { signal } = {}) {
  const opts = { method, headers: { "X-Requested-With": "sdwan-dashboard" }, signal };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((json && json.error) || `${res.status} ${res.statusText}`);
  return json;
}

export const tenantPath = (tsg, rest = "") => `/api/tenants/${encodeURIComponent(tsg)}${rest}`;

// localStorage that never throws (private windows, blocked storage).
export const prefs = {
  get(key, fallback = null) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* ignore */ }
  },
};

// A poller that runs fn every `ms` while the tab is visible, one call at a time. Stopped, it stays
// stopped even if a call was in flight; now() and start() restart it.
export function poller(fn, ms) {
  let timer = null, busy = false, running = false;
  const run = async () => {
    clearTimeout(timer);
    running = true;
    if (document.hidden) return; // resumed by visibilitychange
    if (!busy) {
      busy = true;
      try { await fn(); } finally { busy = false; }
    }
    if (running) timer = setTimeout(run, ms);
  };
  return {
    start(delay = ms) { clearTimeout(timer); running = true; timer = setTimeout(run, delay); },
    now: run,
    stop() { clearTimeout(timer); timer = null; running = false; },
  };
}
