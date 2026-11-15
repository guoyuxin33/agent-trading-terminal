import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Desk } from '../server/desk.mjs';
import { BinanceMCP, DeepSeek, normalizeQuote } from '../server/adapters.mjs';

function fixture(t, feed = 'demo', analyze) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-desk-test-'));
  const store = new Store(join(dir, 'test.sqlite'));
  store.put('settings', { feed });
  const deepseek = { key: () => 'test-key', analyze: analyze || (async () => ({ action: 'buy', confidence: 90, reason: 'test', risks: [], model: 'mock' })) };
  const binance = new BinanceMCP(store, 'http://127.0.0.1:8787/api/binance/callback');
  const desk = new Desk(store, deepseek, binance);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { desk, store, binance, dir };
}
test('demo journal reconciles and has explicit synthetic provenance', t => {
  const { desk } = fixture(t);
  const a = desk.account;
  assert.equal(a.trades.length, 12);
  assert.ok(Math.abs(a.cash - (a.initialBalance + a.trades.reduce((n, t) => n + t.pnl, 0))) < 1e-7);
  assert.ok(a.trades.every(t => t.source === 'demo' && t.decision.model === 'deterministic-demo'));
  assert.equal(desk.snapshot().liveEnabled, false);
});
test('pause invalidates an in-flight model decision before execution', async t => {
  let release, entered;
  const started = new Promise(r => { entered = r; });
  const model = new Promise(r => { release = r; });
  const { desk } = fixture(t, 'binance', async () => { entered(); return model; });
  desk.quotes.BTCUSDT = { symbol: 'BTCUSDT', ...normalizeQuote({ price: 100 }, 'BTCUSDT', 'mock') };
  desk.running = true;
  const run = desk.runCycle(); await started; desk.pause();
  release({ action: 'buy', confidence: 90, reason: 'test', model: 'mock' }); await run;
  assert.equal(desk.account.positions.length, 0);
});
test('model error cannot silently switch into demo trading', async t => {
  const { desk } = fixture(t, 'binance', async () => { throw new Error('HTTP 401'); });
  desk.quotes.BTCUSDT = normalizeQuote({ price: 100 }, 'BTCUSDT', 'mock');
  desk.running = true; await desk.runCycle();
  assert.equal(desk.account.positions.length, 0); assert.equal(desk.states.analyst.status, 'error');
});
test('credentials are encrypted and excluded from frontend snapshots', t => {
  const { store, desk, dir } = fixture(t);
  const secret = 'sk-test-secret-that-must-not-leak'; store.secret('deepseek', secret);
  assert.equal(store.secret('deepseek'), secret);
  assert.ok(!JSON.stringify(desk.snapshot()).includes(secret));
  assert.ok(!readFileSync(join(dir, 'test.sqlite')).includes(Buffer.from(secret)));
  assert.ok(!JSON.stringify(store.get('secret:deepseek')).includes(secret));
});
test('MCP boundary blocks order, transfer and withdrawal tools', t => {
  const { binance, store } = fixture(t);
  for (const name of ['create_order', 'transfer', 'withdraw', 'execute_trade', 'buy', 'cancel_order']) {
    store.put('settings', { binanceTickerTool: name }); assert.equal(binance.isAllowed(name), false);
  }
  assert.equal(binance.isAllowed('ticker_price'), true);
});
test('switching market environments preserves separate accounts', t => {
  const { desk } = fixture(t), id = desk.account.id;
  desk.cycle = 12; desk.states.analyst.task = '执行演示策略'; desk.states.analyst.runs = 12;
  desk.updateSettings({ feed: 'binance' });
  assert.equal(desk.account.trades.length, 0); assert.equal(desk.account.cash, 10000); assert.notEqual(desk.account.id, id);
  assert.equal(desk.cycle, 0); assert.equal(desk.states.analyst.runs, 0); assert.ok(!desk.states.analyst.task.includes('演示策略'));
  desk.updateSettings({ feed: 'demo' }); assert.equal(desk.account.id, id); assert.equal(desk.account.trades.length, 12);
});
test('custom reviewer veto prevents execution', async t => {
  const { desk } = fixture(t, 'binance', async (q, m, agents) => ({ action: agents[0].id === 'analyst' ? 'buy' : 'hold', confidence: 95, reason: 'review', model: 'mock' }));
  desk.agents.push({ id: 'review', name: 'REVIEW', enabled: true, builtin: false, prompt: 'veto' });
  desk.states.review = { runs: 0 };
  desk.quotes.BTCUSDT = normalizeQuote({ price: 100 }, 'BTCUSDT', 'mock'); desk.running = true;
  await desk.runCycle(); assert.equal(desk.account.positions.length, 0); assert.equal(desk.decisions[0].decision.action, 'hold');
});

test('late market responses cannot contaminate a newly selected account', async t => {
  const { desk, binance } = fixture(t, 'binance');
  let release;
  const response = new Promise(r => { release = r; });
  binance.client = {};
  binance.quote = async symbol => { await response; return normalizeQuote({ price: 100 }, symbol, 'mock'); };
  const refresh = desk.refresh();
  desk.updateSettings({ feed: 'demo' });
  release(); await refresh;
  assert.deepEqual(desk.quotes, {});
  assert.equal(desk.account.source, 'demo');
  assert.equal(desk.account.curve.length, 0);
  await desk.refresh();
  assert.ok(Object.values(desk.quotes).every(q => q.source.includes('合成行情')));
});
