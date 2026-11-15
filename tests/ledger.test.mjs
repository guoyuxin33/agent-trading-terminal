import test from 'node:test';
import assert from 'node:assert/strict';
import { newAccount, buy, sell, mark, equity, riskCheck, defaultRisk } from '../server/ledger.mjs';

const quote = (price = 100) => ({ price, time: new Date().toISOString() });
test('round trip reconciles cash, adverse slippage and both fees', () => {
  const a = newAccount(), q = quote(), p = buy(a, { action: 'buy', symbol: 'BTCUSDT', notional: 800, reason: 'test' }, q);
  assert.equal(a.cash, 9199.2);
  assert.equal(p.entry, 100.05);
  assert.ok(Math.abs(equity(a, { BTCUSDT: q }) - (9199.2 + 800 / 100.05 * 100)) < 1e-8);
  const closed = sell(a, p.id, quote(110), 'take');
  const expected = 800 / 100.05 * (110 * .9995) * .999 - 800.8;
  assert.ok(Math.abs(closed.pnl - expected) < 1e-8);
  assert.ok(Math.abs(a.cash - (10000 + closed.pnl)) < 1e-8);
  assert.equal(a.positions.length, 0); assert.equal(a.trades.length, 1);
  assert.throws(() => sell(a, p.id, quote(110), 'duplicate'));
});
test('risk rejects stale quotes, duplicate holdings, oversize and invalid values', () => {
  const a = newAccount(), order = { action: 'buy', symbol: 'BTCUSDT', notional: 800 };
  assert.equal(riskCheck(a, order, { BTCUSDT: quote() }).approved, true);
  assert.equal(riskCheck(a, { ...order, notional: 801 }, { BTCUSDT: quote() }).approved, false);
  assert.equal(riskCheck(a, { ...order, notional: NaN }, { BTCUSDT: quote() }).approved, false);
  assert.equal(riskCheck(a, order, { BTCUSDT: { price: 100, time: new Date(Date.now() - 60000).toISOString() } }).approved, false);
  buy(a, order, quote());
  assert.equal(riskCheck(a, order, { BTCUSDT: quote() }).approved, false);
  assert.throws(() => buy(a, order, quote()));
});
test('loss protection blocks new positions and marks drawdown', () => {
  const a = newAccount(); a.cash = 9600;
  const check = riskCheck(a, { action: 'buy', symbol: 'BTCUSDT', notional: 500 }, { BTCUSDT: quote() });
  assert.equal(check.approved, false); assert.ok(check.reasons.some(x => x.includes('权益')));
  mark(a, {}); assert.equal(a.maxDrawdown, 4);
});
test('gap through stop exits at actual quote, not the stop price', () => {
  const a = newAccount(), p = buy(a, { action: 'buy', symbol: 'BTCUSDT', notional: 800 }, quote());
  const stop = p.stop, trade = sell(a, p.id, quote(70), 'gap stop');
  assert.ok(trade.exit < stop); assert.ok(trade.pnl < -200);
});
test('multi-position sizing uses current marks for the entire account', () => {
  const a = newAccount();
  buy(a, { action: 'buy', symbol: 'BTCUSDT', notional: 800 }, quote(100));
  const quotes = { BTCUSDT: quote(120), ETHUSDT: quote(50) };
  const size = equity(a, quotes) * defaultRisk.positionPct / 100;
  const p = buy(a, { action: 'buy', symbol: 'ETHUSDT', notional: size }, quotes.ETHUSDT, defaultRisk, new Date().toISOString(), quotes);
  assert.ok(p.notional > 800); assert.equal(a.positions.length, 2);
});
