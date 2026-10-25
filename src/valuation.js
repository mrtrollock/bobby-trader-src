// Points tab: illustrative airdrop valuation per platform. Inputs: balances.enc.json -> "valuation" (research, encrypted);
// the user's points come from the CURRENT points total in "points" (so new manual entries update the numbers).
// value = FDV x airdrop% x userPoints / totalPoints at TGE. Nothing here implies any token right.
export const FDVS = [250e6, 500e6, 1e9, 2e9, 3e9];
export const fdvLabel = (f) => (f >= 1e9 ? '$' + f / 1e9 + 'B' : '$' + f / 1e6 + 'M');
const usd = (x, d) => (x == null || !Number.isFinite(x) ? '—' : '$' + x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const perPoint = (fdv, pct, total) => (pct > 0 && total > 0 ? (fdv * pct) / total : null);
export function scenarios(v, userPoints, fdvs = FDVS) {
  return fdvs.map((f) => { const pp = perPoint(f, v.airdropPct, v.totalPoints); return { fdv: f, perPoint: pp, user: pp != null && userPoints != null ? pp * userPoints : null }; });
}
// The user's current points total for a platform (season total incl. bonuses / dashboard total), or null.
export function userPointsFor(pointsDoc, id) {
  const p = ((pointsDoc && pointsDoc.platforms) || []).find((x) => x.id === id);
  return p && p.earned && p.earned.points != null ? Number(p.earned.points) : null;
}
const badge = (h, b) => (b ? h('span', { class: 'badge' + (b === 'official' ? ' ok' : ' warn') + (b === 'user assumption' ? ' user' : '') }, b) : null);
const link = (h, url, text) => (url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text || 'source') : null);
const NAME = { extended: '♟️ Extended', variational: '🌀 Variational', arcus: '🏹 Arcus', txflow: '🌊 TxFlow', qfex: '📈 QFEX', entropy: '🤖 Entropy', risex: '⚡ RiseX', metric: '🔷 Metric' };
const ORDER = ['extended', 'variational', 'risex', 'metric', 'arcus', 'txflow', 'qfex', 'entropy'];

export function valuationCard(h, doc) {
  const V = doc && doc.valuation, P = doc && doc.points;
  const card = h('section', { class: 'card', id: 'valcard' }, h('h2', {}, '💰 Valuation (illustrative)'));
  if (!V) { card.append(h('p', { class: 'muted' }, 'No valuation inputs published yet.')); return card; }
  const fdvs = V.fdvs && V.fdvs.length ? V.fdvs : FDVS;
  card.append(h('div', { class: 'small warnbox', id: 'valdisclaimer' }, '⚠️ ' + (V.disclaimer || 'Illustrative only: points carry no guaranteed token rights.') + ' Not a forecast and not financial advice.'),
    h('div', { class: 'small muted' }, `Formula: FDV × airdrop % × your points ÷ total points at TGE. Your points = your current points total on this tab. Research as of ${V.asOf || '—'}.`));
  const byId = Object.fromEntries((V.platforms || []).map((v) => [v.id, v]));
  for (const id of ORDER) {
    const v = byId[id]; if (!v) continue;
    const up = userPointsFor(P, id);
    const sec = h('div', { class: 'dash val', id: 'val-' + id }, h('h3', {}, NAME[id]));
    sec.append(kv(h, [
      ['TGE', [v.tgeStatus || '—', v.tgeDate ? h('div', { class: 'muted' }, v.tgeDate) : null]],
      v.token ? ['Token', v.token] : null,
    ]));
    if (v.warning) sec.append(h('div', { class: 'small warnbox' }, '⚠️ ' + v.warning));
    if (!v.valuable) {
      sec.append(h('p', { class: 'small redtxt cannot' }, v.cannotValue || "no token/points announced: can't value"));
    } else {
      sec.append(kv(h, [
        ['Airdrop %', [`${(v.airdropPct * 100).toFixed(0)}% `, badge(h, v.airdropBadge), ' ', link(h, v.airdropUrl || (v.sources || [])[0]), h('div', { class: 'muted' }, v.airdropPctSource || '')]],
        ['Total points', [Number(v.totalPoints).toLocaleString('en-US') + ' ', badge(h, v.totalPointsBadge), h('div', { class: 'muted' }, v.totalPointsSource || '')]],
        ['Your points', up != null ? up.toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' (current total)' : 'not entered yet'],
      ]));
      const sc = scenarios(v, up, fdvs);
      sec.append(h('div', { class: 'scroll' }, h('table', { class: 'bal valtable', id: 'valtable-' + id },
        h('thead', {}, h('tr', {}, h('th', {}, 'FDV'), ...sc.map((x) => h('th', {}, fdvLabel(x.fdv))))),
        h('tbody', {}, h('tr', {}, h('th', {}, '$ / point'), ...sc.map((x) => h('td', {}, usd(x.perPoint, x.perPoint != null && x.perPoint < 10 ? 4 : 2)))),
          h('tr', {}, h('th', {}, 'Your $'), ...sc.map((x) => h('td', {}, x.user == null ? '—' : usd(x.user, x.user < 100 ? 2 : 0))))))));
    }
    if (v.docNotes && (v.docNotes.items || []).length) sec.append(h('div', { class: 'small docnotes' }, h('b', {}, 'From the official docs '), link(h, v.docNotes.url, '(source)'),
      h('ul', { class: 'small muted valnotes' }, ...v.docNotes.items.map((n) => h('li', {}, n)))));
    const notes = [v.marketReference ? 'Market hint: ' + v.marketReference : null, v.raiseValuation ? 'Funding: ' + v.raiseValuation : null, v.notes || null].filter(Boolean);
    if (notes.length) sec.append(h('ul', { class: 'small muted valnotes' }, ...notes.map((n) => h('li', {}, n))));
    if ((v.sources || []).length) sec.append(h('details', { class: 'small muted' }, h('summary', {}, 'Sources'), h('ul', {}, ...v.sources.map((u) => h('li', {}, link(h, u, u.replace(/^https?:\/\//, '')))))));
    card.append(sec);
  }
  return card;
}
function kv(h, rows) {
  return h('table', { class: 'kv small' }, ...rows.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, ...(Array.isArray(v) ? v : [v])))));
}
