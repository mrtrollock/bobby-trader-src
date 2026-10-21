// Published (encrypted) positions + Bobby status + all-time deposits cards. Pure DOM builders; `h` is app.js's helper.
const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
const px = (x) => (num(x) == null ? '—' : Number(x).toLocaleString('en-US', { maximumSignificantDigits: 7 }));
const usd = (x) => (num(x) == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const sgn = (x) => (num(x) == null ? '—' : Number(x) === 0 ? '$0.00' : (x < 0 ? '-$' : '+$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cls = (x) => (num(x) == null ? '' : x >= 0 ? 'green' : 'redtxt');
export const berlin = (t) => (t ? new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const PF = { qfex: '📈 QFEX', entropy: '🤖 Entropy', arcus: '🏹 Arcus', txflow: '🌊 TxFlow', variational: '🌀 Variational', extended: '🟣 Extended', risex: '⚡ RiseX' };
const ORDER = ['qfex', 'entropy', 'arcus', 'txflow', 'variational', 'extended', 'risex'];

// The newest positions document: positions.enc.json (every ~5 min) or the copy inside balances.enc.json.
export function latestPositions(data) {
  const a = data && data.positions, b = data && data.balances;
  const fromBal = b && (b.positionsMeta || b.bobby) ? { generated: b.generated, positions: b.positions || [], orders: b.orders || [], platforms: b.positionsMeta || {}, bobby: b.bobby } : null;
  if (a && (!fromBal || (a.generated || 0) >= (fromBal.generated || 0))) return a;
  return fromBal;
}

const STATE_CLASS = { live: 'ok', waiting: 'warn', paused: '', halted: 'warn', stopped: 'warn', manual: '', tracking: '', off: '', unknown: 'warn' };
export function bobbyPills(h, doc) {
  const b = doc && doc.bobby;
  if (!b) return [h('span', { class: 'badge', id: 'bobbystatus', title: 'Bobby status not published yet' }, 'Bobby: no status yet')];
  const rows = (b.platforms || []).filter((r) => r.id !== 'extended' && r.id !== 'variational');
  const age = doc.generated ? Math.round((Date.now() / 1000 - doc.generated) / 60) : null;
  const stale = age != null && age > 30;
  return [h('span', { class: 'badge pills' + (stale ? ' warn' : ''), id: 'bobbystatus', title: (b.platforms || []).map((r) => `${r.label}: ${r.state}${r.detail ? ' (' + r.detail + ')' : ''}`).join('\n') + `\nas of ${berlin(doc.generated)} Berlin` },
    ...rows.map((r, i) => h('span', { class: 'pill ' + (STATE_CLASS[r.state] || '') }, (i ? ' · ' : '') + `${r.label} ${r.state}`)), stale ? ` · ${age} min old` : null)];
}

export function bobbyCard(h, doc) {
  const b = doc && doc.bobby;
  const c = h('section', { class: 'card', id: 'bobbycard' }, h('h2', {}, '🤖 Bobby right now'));
  if (!b) { c.append(h('p', { class: 'muted' }, 'Not published yet.')); return c; }
  c.append(h('table', { class: 'kv' }, h('tbody', {}, ...(b.platforms || []).map((r) => h('tr', {}, h('th', {}, PF[r.id] || r.label),
    h('td', {}, h('span', { class: 'pill ' + (STATE_CLASS[r.state] || '') }, r.state), r.detail ? h('div', { class: 'muted small' }, r.detail) : null))))));
  c.append(h('div', { class: 'muted small' }, `Loop ${b.loopRunning ? 'running' : 'NOT running'} · as of ${berlin(doc.generated)} (Berlin time)`));
  return c;
}

export function publishedPositions(h, doc) {
  const out = [];
  const head = h('section', { class: 'card', id: 'pubpos' }, h('h2', {}, '📊 Open positions'));
  out.push(head);
  if (!doc) { head.append(h('p', { class: 'muted' }, 'No positions published yet. They are published from the box every 5 minutes.')); return out; }
  const pos = doc.positions || [], oo = doc.orders || [];
  const tot = pos.reduce((s, p) => s + (num(p.upnl) || 0), 0);
  head.append(h('div', { class: 'muted small', id: 'posupdated' }, `Last updated ${berlin(doc.generated)} (Berlin time) · ${pos.length} open · uPnL `, h('span', { class: cls(tot) }, sgn(tot))));
  for (const pf of ORDER) {
    const meta = (doc.platforms || {})[pf] || {}, mine = pos.filter((p) => p.pf === pf), ords = oo.filter((o) => o.pf === pf);
    const card = h('section', { class: 'card', id: 'pos-' + pf }, h('h2', {}, PF[pf], ' ', h('span', { class: 'badge' }, mine.length ? `${mine.length} open` : meta.status === 'ok' ? 'flat' : meta.status || 'no data')));
    if (pf === 'risex') card.append(h('div', { class: 'small' }, h('span', { class: 'badge warn' }, 'tracking only · not farmed'), h('span', { class: 'muted' }, ' your own trades, read from the public RiseX API')));
    if (meta.status === 'error') card.append(h('div', { class: 'alert warn' }, 'Could not read: ' + (meta.error || 'error')));
    else if (meta.status === 'manual' || meta.status === 'not connected') card.append(h('p', { class: 'muted small' }, meta.note || meta.status));
    else if (!mine.length) card.append(h('p', { class: 'muted small' }, 'No open positions.'));
    if (mine.length) card.append(h('div', { class: 'scroll' }, h('table', { class: 'bal postable' },
      h('thead', {}, h('tr', {}, ...['Market', 'Side', 'Size', 'Entry', 'Mark', 'uPnL', 'SL', 'TP', 'By'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...mine.map((p) => h('tr', {}, h('th', {}, String(p.market).replace(/-USDC?$/, ''), p.account ? h('div', { class: 'muted small' }, p.account) : null),
        h('td', { class: p.side === 'long' ? 'green' : 'redtxt' }, p.side + (p.leverage ? ` ${p.leverage}×` : '')), h('td', {}, px(p.size)), h('td', {}, px(p.entry)), h('td', {}, px(p.mark)),
        h('td', { class: cls(p.upnl) }, sgn(p.upnl)), h('td', {}, (p.sl || []).length ? p.sl.map(px).join(' / ') : '—'), h('td', {}, (p.tp || []).length ? p.tp.map(px).join(' / ') : '—'),
        h('td', {}, h('span', { class: 'pill ' + (p.by === 'Bobby' ? 'ok' : '') }, p.by || '?'), p.protected ? '' : h('div', { class: 'small redtxt' }, 'no SL/TP'))))))));
    if (ords.length) card.append(h('div', { class: 'muted small' }, h('b', {}, 'Working orders: '),
      ords.map((o) => `${String(o.market).replace(/-USDC?$/, '')} ${o.side} ${o.kind}${o.reduceOnly ? ' (exit)' : ''} ${px(o.size)} @ ${px(o.px ?? o.trig)} · ${o.by}`).join(' | ')));
    out.push(card);
  }
  return out;
}

// Balances tab: one card per platform with all-time deposits / withdrawals / net deposited / balance / all-time PnL.
export function flowCards(h, j) {
  const F = j && j.flows;
  if (!F) return [];
  const plat = Object.fromEntries((j.platforms || []).map((r) => [r.id, r]));
  const kv = (rows) => h('table', { class: 'kv' }, h('tbody', {}, ...rows.map(([k, v, c]) => h('tr', {}, h('th', {}, k), h('td', { class: c || '' }, v)))));
  const cards = (F.rows || []).map((r) => {
    const p = plat[r.id] || {};
    const c = h('section', { class: 'card pfcard', id: 'pf-' + r.id }, h('h2', {}, r.name));
    c.append(kv([
      ['Current balance', usd(r.current)],
      ['Total deposits', r.deposits == null ? (r.net != null ? 'net only' : '—') : usd(r.deposits)],
      ['Total withdrawals', r.withdrawals == null ? (r.net != null ? 'net only' : '—') : usd(r.withdrawals)],
      ['Net deposited', usd(r.net)],
      ['All-time PnL', sgn(r.pnl), cls(r.pnl)],
      ...(p.status === 'ok' ? [[`PnL since ${berlin(p.startT)}`, sgn(p.pnl), cls(p.pnl)]] : []),
    ]));
    if (r.reason) c.append(h('p', { class: 'muted small' }, r.reason));
    if (r.note) c.append(h('p', { class: 'muted small' }, r.note));
    if (p.note) c.append(h('p', { class: 'muted small' }, p.note));
    if (r.src) c.append(h('div', { class: 'muted small' }, 'Source: ' + r.src));
    return c;
  });
  const t = F.total;
  const tc = h('section', { class: 'card pfcard', id: 'pf-total' }, h('h2', {}, 'Σ All platforms'));
  if (!t) tc.append(h('p', { class: 'muted' }, 'No platform with known deposits yet.'));
  else {
    tc.append(kv([['Current balance', usd(t.current)], ['Total deposits', t.deposits == null ? 'partly net only' : usd(t.deposits)],
      ['Total withdrawals', t.withdrawals == null ? 'partly net only' : usd(t.withdrawals)], ['Net deposited', usd(t.net)], ['All-time PnL', sgn(t.pnl), cls(t.pnl)]]));
    tc.append(h('p', { class: 'muted small' }, 'Counts only platforms with known deposits: ' + (t.platforms || []).join(', ') + '.'));
  }
  return [...cards, tc];
}
