import { valuationCard } from './valuation.js';
// Points tab: per platform the current points week (Berlin time), a live countdown to the next points drop (or the end
// of the epoch / tracking week when no drop time is published), volume / PnL / fees this week and past weeks.
// Data: balances.enc.json -> "points" (written by points.py via balances.py, decrypted in the browser). No network calls.
const BERLIN = 'Europe/Berlin';
export const berlin = (t) => (t == null ? '—' : new Date(t * 1000).toLocaleString('en-GB', { timeZone: BERLIN, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
const money = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? '—' : (Number(x) < 0 ? '-$' : '$') + Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x) === 0 ? '$0.00' : (Number(x) < 0 ? '-$' : '+$') + Math.abs(Number(x)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const kusd = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : Math.abs(x) >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : Math.abs(x) >= 1e3 ? '$' + (x / 1e3).toFixed(1) + 'K' : '$' + Number(x).toFixed(0));
const pts = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(Number(x)) < 10 && Number(x) % 1 ? 6 : 2 }));
const eff = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: Number(x) >= 100 ? 0 : 2 }));
const srcTag = (src) => (src === 'auto' ? ' · auto' : src === 'manual' ? ' · ✍ manual' : '');
// Points cell text for one week: the number (with auto / manual tag), or why there is none. Never shows 0 for "unknown".
export function pointsText(x, p, now = Date.now() / 1000) {
  if (!x) return '—';
  if (p && p.kind === 'rebates') return x.rebates != null ? money(x.rebates) + srcTag(x.rebatesSrc || 'manual') + ' rebates' : 'rebates, not points';
  if (x.points != null) return pts(x.points) + srcTag(x.pointsSrc || 'manual');
  if (p && p.kind === 'not announced' && x.current) return 'no drop announced';
  if (p && p.kind === 'ended' && x.current) return 'no weekly drops (ended)';
  if (x.pointsState === 'pending' || (x.current && x.pointsState !== 'missing')) {
    const due = x.drop != null ? x.drop : null;
    return due != null && due > now ? `pending (drop ${berlin(due)})` : x.current ? 'pending' : 'not entered yet';
  }
  return 'not entered yet';
}
export function lastDropped(p) { return (p.history || []).find((x) => !x.current) || null; }
const cls = (x) => (x == null ? '' : x >= 0 ? 'green' : 'redtxt');

export function fmtCountdown(sec) {
  if (!(sec > 0)) return 'now';
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60), ss = Math.floor(sec % 60);
  const p2 = (n) => String(n).padStart(2, '0');
  return (d ? `${d}d ` : '') + `${p2(hh)}:${p2(mm)}:${p2(ss)}`;
}
// The window that contains `now` (from the published current + upcoming windows; the data may be hours old).
export function liveWindow(p, now) {
  const all = [p.window, ...(p.upcoming || [])].filter(Boolean);
  return all.find((w) => w.start <= now && now < w.end) || all.find((w) => w.end > now) || null;
}
// Countdown target: the next published drop that is still ahead, else the end of the live window.
export function target(p, now) {
  if (p.kind === 'ended') return null; // no more scheduled drops (Extended)
  const all = [p.window, ...(p.upcoming || [])].filter(Boolean);
  if (p.apiNextDrop && p.apiNextDrop > now) return { t: p.apiNextDrop, kind: 'drop' };
  const d = all.map((w) => w.drop).filter((t) => t != null && t > now).sort((a, b) => a - b)[0];
  if (d != null && !(p.endsBy && d > p.endsBy + 86400)) return { t: d, kind: 'drop' };
  const w = liveWindow(p, now);
  return w ? { t: w.end, kind: 'end' } : null;
}
export function targetLabel(p, kind) {
  if (kind === 'drop') return p.dropExact === false ? 'Points credited (Tuesday; time not stated)' : 'Next points drop';
  if (p.kind === 'points') return 'Epoch ends';
  return 'Tracking week ends';
}

let timer = null;
export function startCountdowns(doc = globalThis.document) {
  if (timer) clearInterval(timer);
  const tick = () => {
    const els = doc.querySelectorAll('[data-cd]');
    if (!els.length) { clearInterval(timer); timer = null; return; }
    const now = Date.now() / 1000;
    for (const el of els) el.textContent = fmtCountdown(Number(el.dataset.cd) - now);
  };
  tick(); timer = setInterval(tick, 1000);
}

export function viewPoints(app, { h, doc, refresh }) {
  const P = doc && doc.points;
  const card = h('section', { class: 'card' }, h('h2', {}, '🎯 Points weeks'),
    h('div', { class: 'muted small' }, P ? `Updated ${berlin(P.generated)} (Berlin time) · countdowns are live` : 'Not published yet'));
  app.append(card);
  if (!P) { card.append(h('p', { class: 'muted' }, 'No points data yet. Run tools/publish.sh all on the box.')); return; }
  const now = Date.now() / 1000;
  // summary: one row per platform + total (this points week)
  const rows = P.platforms.map((p) => {
    const tg = target(p, now), c = p.current;
    return h('tr', {}, h('th', {}, p.name),
      h('td', {}, tg ? h('span', { 'data-cd': String(tg.t), class: 'cd' }, fmtCountdown(tg.t - now)) : '—'),
      ...(p.connected ? [h('td', {}, kusd(c && c.volume)), h('td', { class: cls(c && c.pnl) }, signed(c && c.pnl)), h('td', {}, money(c && c.fees))]
        : [h('td', { colspan: '3', class: 'muted' }, 'not connected')]));
  });
  if (P.total) rows.push(h('tr', { class: 'total' }, h('th', {}, 'Total'), h('td', {}, ''), h('td', {}, kusd(P.total.volume)),
    h('td', { class: cls(P.total.pnl) }, signed(P.total.pnl)), h('td', {}, money(P.total.fees))));
  card.append(h('div', { class: 'scroll' }, h('table', { class: 'bal', id: 'ptstable' },
    h('thead', {}, h('tr', {}, ...['', 'Countdown', 'Volume', 'PnL', 'Fees'].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows))),
  h('p', { class: 'muted small' }, 'This points week per platform. PnL = realized PnL minus fees, plus funding where the API reports it. Countdown: next points drop, or the end of the epoch / tracking week when no drop time is published.'));

  // points earned: last finished week, season total (from the private ledger), efficiency, and where the numbers come from
  const er = P.platforms.map((p) => {
    const last = lastDropped(p), e = p.earned || {}, reb = p.kind === 'rebates';
    return h('tr', { id: 'pe-' + p.id }, h('th', {}, p.name),
      h('td', {}, last ? h('span', {}, h('span', { class: 'muted' }, last.label + ': '), pointsText(last, p, now)) : '—'),
      h('td', {}, reb ? (e.rebates != null ? money(e.rebates) + ' rebates' : 'rebates, not points') : e.points != null ? pts(e.points) + (e.totalSrc === 'dashboard' ? ' · ✍ dashboard' : srcTag((e.src || [])[0])) : 'not entered yet'),
      h('td', {}, reb ? '—' : eff(e.ptsPer1k)));
  });
  app.append(h('section', { class: 'card', id: 'ptsearnedcard' }, h('h2', {}, '🏅 Points earned'),
    h('div', { class: 'scroll' }, h('table', { class: 'bal', id: 'ptsearned' },
      h('thead', {}, h('tr', {}, ...['', 'Last week', 'Season', 'Pts/$1K'].map((t) => h('th', {}, t)))), h('tbody', {}, ...er))),
    h('p', { class: 'muted small' }, 'Volume, PnL and fees are read automatically from each platform\'s API. No platform offers a documented API for your points, so points are entered by hand in points_manual.json (✍ manual) and kept per week in the private points ledger; "auto" would mark points read from an official API. "not entered yet" = the week has dropped but no number was entered (it is not 0). Season total = sum of the entered weeks; pts / $1K = season points ÷ volume of those weeks. Points of different platforms are not added up (different programs).')));

  app.append(valuationCard(h, doc));

  for (const p of P.platforms) {
    const tg = target(p, now), w = liveWindow(p, now) || p.window, c = p.current;
    const stale = w && p.window && w.start !== p.window.start;
    const sec = h('section', { class: 'card pts', id: 'pts-' + p.id },
      h('h2', {}, p.name, ' ', h('span', { class: 'badge' + (p.connected ? '' : ' warn') }, p.connected ? (p.status === 'manual' ? 'manual' : p.status === 'error' ? 'error' : 'connected') : 'not connected'),
        p.tracking ? ' ' : null, p.tracking ? h('span', { class: 'badge warn' }, 'tracking only · not farmed') : null),
      h('div', { class: 'small' }, h('b', {}, p.program)),
      h('div', { class: 'small muted' }, p.rule),
      h('div', { class: 'small muted' }, 'Week: ' + p.windowRule),
      kvTable(h, [
        [w && w.n != null ? `${w.label}` : 'Tracking week', w ? `${berlin(w.start)} → ${berlin(w.end)}` : '—'],
        tg ? [targetLabel(p, tg.kind), h('span', {}, berlin(tg.t), ' · in ', h('span', { 'data-cd': String(tg.t), class: 'cd' }, fmtCountdown(tg.t - now)))] : null,
        p.kind === 'rebates' ? ['Rebate payout', 'every 2 weeks (date not published)'] : null,
        p.kind === 'not announced' ? ['Points drop', 'not announced'] : null,
        p.kind === 'ended' ? ['Points drop', 'weekly distributions ended · final distribution after the ongoing competition (date not published)'] : null,
        p.endsNote ? ['Program', p.endsNote] : null,
        ...(p.connected ? [
          ['Volume this week' + (stale ? ' (last week, data not refreshed yet)' : ''), kusd(c && c.volume)],
          ['PnL this week (fees incl.)', h('span', { class: cls(c && c.pnl) }, signed(c && c.pnl))],
          ['Fees this week', money(c && c.fees, 2) + (c && c.funding ? ` · funding ${signed(c.funding)}` : '')],
          c && c.trades != null ? ['Fills', String(c.trades) + (c.makerShare != null ? ` · ${(c.makerShare * 100).toFixed(0)}% maker` : '')] : null,
          [p.kind === 'rebates' ? 'Rebates this week' : 'Points this week', pointsText(c || { current: true, drop: w && w.drop, pointsState: 'pending' }, p, now)],
          p.kind !== 'rebates' && p.earned ? ['Points season total', p.earned.points != null ? `${pts(p.earned.points)} over ${p.earned.weeks} week(s) · ${eff(p.earned.ptsPer1k)} pts / $1K` : 'not entered yet'] : null,
          p.kind === 'rebates' && p.earned && p.earned.rebates != null ? ['Rebates total', money(p.earned.rebates)] : null,
          p.retro ? [p.retro.label || 'Retroactive', p.retro.points != null ? pts(p.retro.points) + ' · ✍ manual' : 'pending'] : null,
        ] : [['Data', 'not connected']]),
      ]),
      p.dataNote ? h('div', { class: 'small muted' }, p.dataNote) : null);
    if (p.profile && (p.profile.items || []).length) sec.append(h('h3', {}, 'Dashboard snapshot' + (p.profile.asOf ? ' · ' + p.profile.asOf : '') + ' · ✍ manual'), kvTable(h, p.profile.items.map(([k, v]) => [k, String(v)])));
    const hist = (p.history || []).filter((x) => !x.current);
    if (hist.length) sec.append(h('h3', {}, 'Past weeks'), h('div', { class: 'scroll' }, h('table', { class: 'bal', id: 'ptshist-' + p.id },
      h('thead', {}, h('tr', {}, ...['Week', 'Volume', 'PnL', 'Fees', p.kind === 'rebates' ? 'Rebates' : 'Points', 'Pts / $1K'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...hist.map((x) => h('tr', {}, h('th', {}, x.n != null ? x.label : berlin(x.start).replace(/, \d\d:\d\d$/, '')), h('td', {}, kusd(x.volume)),
        h('td', { class: cls(x.pnl) }, signed(x.pnl)), h('td', {}, money(x.fees)), h('td', { class: x.points == null && p.kind !== 'rebates' ? 'muted' : '' }, pointsText(x, p, now)), h('td', {}, eff(x.ptsPer1k))))))));
    if ((p.bonus || []).length) sec.append(h('h3', {}, 'Bonus / competitions / off-schedule'), h('div', { class: 'scroll' }, h('table', { class: 'bal', id: 'ptsbonus-' + p.id },
      h('thead', {}, h('tr', {}, ...['Entry', 'Points', 'Note'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...p.bonus.map((b) => h('tr', {}, h('th', {}, b.label), h('td', {}, b.points != null ? pts(b.points) + ' · ✍ manual' : 'not entered yet'), h('td', { class: 'small muted' }, b.date || b.note || '—')))))));
    sec.append(h('div', { class: 'small muted' }, 'Points source: ' + (p.pointsSource || 'manual')));
    sec.append(h('details', { class: 'small muted' }, h('summary', {}, 'Sources' + ((p.unverified || []).length ? ' · unverified: ' + p.unverified.join(', ') : '')),
      h('ul', {}, ...(p.sources || []).map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.label)))),
));
    app.append(sec);
  }
  if (refresh) app.append(h('button', { class: 'btn ghost', onclick: refresh }, 'Refresh'));
  startCountdowns();
}
function kvTable(h, rows) {
  return h('table', { class: 'kv small' }, ...rows.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))));
}
