// Display formatting shared by every page.

export function fmt(v, digits = 1) {
  if (v == null) return null;
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: v < 10 ? digits : 0 });
}

export const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const hms = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// "<1 min ago", "12 min ago", "3 h ago", "2 d ago".
export function ageText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1 min ago";
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// A minute as local time ("14:52"), prefixed with the date when it isn't today.
export function minuteLabel(iso, today = new Date()) {
  if (!iso) return "";
  const t = new Date(iso);
  if (isNaN(t)) return String(iso);
  const day = t.toDateString() === today.toDateString() ? "" : t.toLocaleDateString([], { month: "short", day: "numeric" }) + " ";
  return day + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
