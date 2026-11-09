// Tiny localStorage wrapper — all user data stays on this machine.
(function () {
  const NS = 'sakinah.';
  window.Store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(NS + key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch {}
    },
    del(key) {
      try { localStorage.removeItem(NS + key); } catch {}
    },
  };
})();
