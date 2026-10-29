// Airdrop / TGE announcements (announcements.enc.json, written by tools/announce.py). Pure logic + DOM builders; `h` is app.js's helper.
// action = the user must do something (sign / register / claim), usually with a deadline; info = TGE date, allocation, FDV, ...
export const DISMISS_KEY = 'bobby_ann_dismissed_v1';
const PF = { extended: '🟣 Extended', variational: '🌀 Variational', txflow: '🌊 TxFlow', arcus: '🏹 Arcus', risex: '⚡ RiseX', qfex: '📈 QFEX', entropy: '🤖 Entropy', metric: '🔷 Metric', tradexyz: '📊 trade.xyz' };
export const projectLabel = (p) => PF[String(p || '').toLowerCase()] || String(p || '');
const ms = (iso) => { if (!iso) return null; const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
// only plain https links are ever rendered (official sources); anything else is dropped
export const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
export const berlinAt = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function itemsOf(doc) { return Array.isArray(doc) ? doc : (doc && Array.isArray(doc.items) ? doc.items : []); }

// Why an item is not shown in the banner (null = shown).
export function hiddenReason(it, dismissed, now = Date.now()) {
  if (!it || !it.id) return 'invalid';
  if (dismissed && (dismissed instanceof Set ? dismissed.has(it.id) : dismissed.includes(it.id))) return 'dismissed';
  const exp = ms(it.expiresAt); if (exp != null && exp <= now) return 'expired';
  const dl = ms(it.deadline); if (it.severity === 'action' && dl != null && dl <= now) return 'deadline passed';
  return null;
}
// action first (earliest deadline first, no deadline after those), then newest first
export function sortItems(items) {
  const rank = (it) => (it.severity === 'action' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b)
    || (ms(a.deadline) ?? Infinity) - (ms(b.deadline) ?? Infinity)
    || (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0));
}
export const activeItems = (items, dismissed, now = Date.now()) => sortItems(items.filter((it) => !hiddenReason(it, dismissed, now)));

export function fmtLeft(sec) {
  if (sec <= 0) return 'passed';
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60);
  if (d) return `in ${d}d ${hh}h`;
  if (hh) return `in ${hh}h ${mm}m`;
  return `in ${Math.max(1, mm)}m`;
}
export function deadlineText(it, now = Date.now()) {
  const dl = ms(it.deadline); if (dl == null) return null;
  return `Deadline ${berlinAt(dl)} Berlin · ${fmtLeft(Math.floor((dl - now) / 1000))}`;
}

function links(h, it) {
  const u = safeUrl(it.url), c = safeUrl(it.claimUrl);
  return h('span', { class: 'annlinks' },
    u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, 'Official source ↗') : null,
    c ? h('a', { href: c, target: '_blank', rel: 'noopener noreferrer', class: 'claim' }, 'Claim / sign (official) ↗') : null);
}
function row(h, it, now, onDismiss) {
  const dl = deadlineText(it, now), soon = ms(it.deadline) != null && ms(it.deadline) - now < 48 * 3600e3;
  return h('div', { class: 'annitem ' + (it.severity === 'action' ? 'action' : 'info'), 'data-id': it.id },
    h('div', { class: 'annhead' },
      h('span', { class: 'anntag' }, it.severity === 'action' ? '⚠️ Action needed' : 'ℹ️ News'),
      h('span', { class: 'annpf' }, projectLabel(it.project)),
      onDismiss ? h('button', { class: 'anndismiss', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: (e) => { e.stopPropagation(); onDismiss(it.id); } }, '✕') : null),
    h('div', { class: 'anntitle' }, it.title || ''),
    it.text ? h('div', { class: 'anntext' }, it.text) : null,
    dl ? h('div', { class: 'anndl' + (soon ? ' soon' : '') }, '⏰ ' + dl) : null,
    links(h, it));
}

// Sticky banner: the top item + "N more" that expands the rest. Returns null when nothing is active.
export function bannerEl(h, doc, { dismissed = [], now = Date.now(), expanded = false, onDismiss = null, onToggle = null } = {}) {
  const act = activeItems(itemsOf(doc), dismissed, now);
  if (!act.length) return null;
  const top = act[0], rest = act.slice(1);
  return h('div', { class: 'annbanner ' + (top.severity === 'action' ? 'action' : 'info'), id: 'annbanner', role: 'alert' },
    row(h, top, now, onDismiss),
    rest.length ? h('button', { class: 'annmore', id: 'annmore', onclick: () => onToggle && onToggle() },
      expanded ? 'Show less ▲' : `+${rest.length} more announcement${rest.length > 1 ? 's' : ''} ▼`) : null,
    expanded ? rest.map((it) => row(h, it, now, onDismiss)) : null);
}

// Points tab: every item incl. dismissed / expired, with its state and a way to bring a dismissed one back.
export function announcementsCard(h, doc, { dismissed = [], now = Date.now(), onRestore = null } = {}) {
  const all = sortItems(itemsOf(doc).filter((it) => it && it.id));
  const c = h('section', { class: 'card ann', id: 'anncard' }, h('h2', {}, '📣 Announcements'));
  if (!all.length) { c.append(h('p', { class: 'muted small' }, 'No airdrop or TGE news yet. New items appear in the banner at the top of every tab.')); return c; }
  for (const it of all) {
    const why = hiddenReason(it, dismissed, now);
    const r = row(h, it, now, null);
    r.classList.add('inlist');
    r.append(h('div', { class: 'muted small' }, `Added ${ms(it.createdAt) != null ? berlinAt(ms(it.createdAt)) + ' Berlin' : '—'}`,
      why ? ` · ${why}` : ' · showing in the banner',
      why === 'dismissed' && onRestore ? h('button', { class: 'badge lockbtn annrestore', onclick: () => onRestore(it.id) }, 'Show again') : null));
    c.append(r);
  }
  return c;
}

// dismissed ids in localStorage (device-local; ids only, no content)
export function loadDismissed(store = globalThis.localStorage) {
  try { const v = JSON.parse(store.getItem(DISMISS_KEY) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
export function saveDismissed(ids, store = globalThis.localStorage) {
  try { store.setItem(DISMISS_KEY, JSON.stringify([...new Set(ids)].slice(-500))); } catch { /* */ }
}
