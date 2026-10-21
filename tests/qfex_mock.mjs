// Offline QFEX mocks: a fake trade/MDS WebSocket and a fake REST fetch, used by the unit tests and the e2e dry run.
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
export const FXQ = (f) => JSON.parse(readFileSync(new URL('./fixtures/' + f, import.meta.url)));
export const ACCT = '0b7c6a7e-1d2f-4c3b-9a8e-5f6d7c8b9a01', USER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
// Shapes below mirror what mainnet returned for a single-account key on 2026-10-21.

// state: { mark, bid, ask, orders[], stops[], authOk, ackStops (echo SL/TP), noStopsSnapshot, entryStatus }
export function fakeWsClass(state, log) {
  return class FakeWS extends EventEmitter {
    constructor(url) { super(); this.url = url; log.push({ open: url }); setTimeout(() => this.emit('open'), 1); }
    reply(m) { setTimeout(() => this.emit('message', Buffer.from(JSON.stringify(m))), 1); }
    send(raw) {
      const m = JSON.parse(raw); log.push({ url: this.url, m });
      if (/mds/.test(this.url)) {
        for (const sym of m.symbols) { this.reply({ type: 'mark_price', symbol: sym, price: String(state.mark) });
          this.reply({ type: 'bbo', symbol: sym, bid: [[String(state.bid), '0.5']], ask: state.ask == null ? [] : [[String(state.ask), '0.2'], ['1', '0']] }); }
        return;
      }
      const p = m.params || {};
      if (m.type === 'auth') return this.reply(state.authOk === false ? { err: { error_code: 'PermissionDenied', message: 'bad hmac' } } : { authenticated: true });
      if (m.type === 'get_user_leverage') return this.reply({ user_leverage_response: [{ id: 'x', symbol: p.symbol, initial_margin: 1, maintenance_margin: 0.5, leverage: String(state.levNow ?? 10) }, { id: 'y', symbol: 'AAPL-USD', leverage: '10' }] });
      if (m.type === 'subscribe') { for (const ch of p.channels) { this.reply({ subscribed: ch });
        if (ch === 'balances' && !state.noBalance) this.reply({ balance_response: { id: state.wsAccount || ACCT, user_id: state.wsUser || USER, deposit: 300, realised_pnl: 0, order_margin: 0, position_margin: 0, unrealised_pnl: 0, net_funding: 0, available_balance: 300, fees: 0 } });
        if (ch === 'stop_orders' && !state.noStopsSnapshot) for (const st of state.stops || []) this.reply({ stop_order_response: st }); } return; }
      if (m.type === 'get_user_orders') return this.reply({ all_orders_response: { orders: state.orders || [], twaps: [] } });
      if (m.type === 'cancel_on_disconnect') return;
      if (m.type === 'add_order') return this.reply({ order_response: { order_id: 'oid-1', symbol: p.symbol, status: state.entryStatus || 'ACK', quantity: p.quantity, price: p.price,
        take_profit: state.ackStops === false ? 0 : p.take_profit, stop_loss: state.ackStops === false ? 0 : p.stop_loss, side: p.side, type: p.order_type,
        time_in_force: p.order_time_in_force, client_order_id: p.client_order_id, quantity_remaining: p.quantity } });
      if (m.type === 'cancel_order') return this.reply({ order_response: { order_id: p.order_id, symbol: p.symbol, status: 'CANCELLED' } });
      if (m.type === 'close_position') return this.reply({ order_response: { order_id: 'close-1', symbol: p.symbol, status: 'FILLED', client_order_id: p.client_order_id } });
      this.reply({ err: { error_code: 'InvalidJSONFormat', message: 'unknown', incoming_message: m } });
    }
    close() { this.closed = true; }
  };
}
// REST: state.allAccountsKey, state.positions, state.balance, state.trades, state.fees, state.foreignReadable, state.leverageEcho, state.equitySeries
export function fakeFetch(state, log) {
  return async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {}, method = init.method || 'GET';
    log.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: h, body: init.body });
    const json = (status, b) => ({ ok: status < 300, status, text: async () => JSON.stringify(b) });
    if (u.pathname === '/refdata') return json(200, FXQ(u.searchParams.get('ticker') === 'AAPL-USD' ? 'qfex_refdata_aapl.json' : 'qfex_refdata_us100.json'));
    if (!h['x-qfex-hmac-signature']) return json(401, { error: 'unauthenticated' });
    const acct = h['x-qfex-requested-account-id'] || null;
    if (acct && acct !== (state.ownAccount || ACCT) && !state.foreignReadable) return json(401, 'invalid HMAC signature');
    if (u.pathname === '/user/subaccounts/balance') return state.allAccountsKey ? json(200, { accounts: [{ account_id: ACCT, equity: 300, available_balance: 300, is_master: false }] }) : json(403, 'insufficient API key permissions');
    if (u.pathname === '/user/account-equity') return json(200, { duration: '1d', interval_minutes: 60, data: (state.equitySeries || [300]).map((v, i) => ({ window_start: new Date(i * 3600e3).toISOString(), value: v })) });
    if (u.pathname === '/user/positions') return json(200, { positions: state.positions || [], balance: state.balance || { available_balance: '300', deposit: '300', realised_pnl: '0', unrealised_pnl: '0', net_funding: '0' } });
    if (u.pathname === '/user/trade') return json(200, { data: state.trades || [], count: (state.trades || []).length });
    if (u.pathname === '/user/fees') return json(200, { fees: state.fees || {} });
    if (u.pathname === '/user/leverage' && method === 'POST') { state.levNow = state.levStuck ?? JSON.parse(init.body).leverage; return json(200, state.leverageEcho === undefined ? { leverage: JSON.parse(init.body).leverage } : state.leverageEcho === null ? {} : { leverage: state.leverageEcho }); }
    return json(404, { error: 'not found' });
  };
}
