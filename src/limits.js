// Balances tab: weekly + daily loss caps per platform (balances.enc.json -> "limits", written by limits.py).
const berlin = (t) => (t == null ? '—' : new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
const usd = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : (Number(x) < 0 ? '-$' : '$') + Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cap = (x) => (x == null ? '—' : '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 }));
export function statusText(r) {
  if (r.status === 'halted') return `⛔ Halted until ${berlin(r.haltedUntil)} (${r.haltScope === 'daily' ? 'daily cap' : r.haltScope === 'weekly' ? 'weekly cap' : r.haltScope})`;
  if (r.status === 'ok') return '✅ OK';
  if (r.status === 'manual') return '✋ Manual (reference cap)';
  if (r.status === 'over cap') return '⛔ Over the reference cap';
  if (r.status === 'not connected') return '⚪ Not connected';
  if (r.status === 'error') return '⚠️ Error';
  return '⚪ No data';
}
const level = (p) => (p == null ? '' : p >= 0.8 ? ' red' : p >= 0.5 ? ' warn' : '');
function bar(h, pct) { const f = h('div', { class: 'fill' + level(pct) }); f.style.width = Math.round((pct || 0) * 100) + '%'; return h('div', { class: 'bar' }, f); } // CSSOM: allowed by the CSP
export function limitsCard(h, doc) {
  const L = doc && doc.limits;
  const card = h('section', { class: 'card', id: 'limitscard' }, h('h2', {}, '🛑 Loss caps'));
  if (!L) { card.append(h('p', { class: 'muted' }, 'No loss-cap data yet.')); return card; }
  card.append(h('div', { class: 'muted small' }, `Week resets Monday 00:00 UTC (next: ${berlin(L.weekResets)} Berlin) · day resets 00:00 UTC (next: ${berlin(L.dayResets)} Berlin)`));
  for (const r of L.platforms || []) {
    const daily = r.dailyCap != null
      ? [h('div', { class: 'small' }, h('b', {}, 'Daily: '), `${usd(r.dailyUsed)} used of ${cap(r.dailyCap)} · ${usd(r.dailyRemaining)} left`, h('span', { class: 'muted' }, ` (${r.dailyRule})`)), bar(h, r.dailyPct)]
      : [h('div', { class: 'small' }, h('b', {}, 'Daily: '), `cap ${r.dailyRule || 'not set'}` + (r.dailyUsed != null ? ` · lost today ${usd(r.dailyUsed)}` : ''))];
    card.append(h('div', { class: 'dash lim', id: 'lim-' + r.id },
      h('div', { class: 'limhead' }, h('b', {}, r.name), ' ', h('span', { class: 'badge' + (r.mode === 'manual' ? ' warn' : '') }, r.mode === 'manual' ? 'manual' : 'Bobby'),
        ' ', h('span', { class: 'small limstatus' + (/halted|over/.test(r.status) ? ' redtxt' : r.status === 'ok' ? ' green' : '') }, statusText(r))),
      h('div', { class: 'small' }, h('b', {}, 'Weekly: '), `${usd(r.weeklyUsed)} used of ${cap(r.weeklyCap)} · ${usd(r.weeklyRemaining)} left` + (r.weekPnl != null ? ` (week PnL ${usd(r.weekPnl)})` : '')),
      bar(h, r.weeklyPct), ...daily,
      h('div', { class: 'small' }, h('b', {}, 'Per trade: '), r.maxTradeLoss != null ? `max loss ${usd(r.maxTradeLoss)} now` : 'max loss —', h('span', { class: 'muted' }, ` (${r.maxTradeRule || '—'})`)),
      r.note ? h('div', { class: 'small muted' }, r.note) : null));
  }
  card.append(h('p', { class: 'muted small' }, L.rules + ' TxFlow and Variational are traded by hand: their $50/week is a reference, Bobby does not enforce it.'));
  return card;
}
