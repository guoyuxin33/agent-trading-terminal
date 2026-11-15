import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeepSeek } from '../server/adapters.mjs';

async function mockModel(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(respond(request, requests.length)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const settings = { deepseekBase: `http://127.0.0.1:${server.address().port}`, deepseekModel: 'mock-model' };
  const model = new DeepSeek({ get: () => settings, secret: () => 'test-key' });
  return { model, requests };
}

function toolResponse(name, input) {
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 15, completion_tokens: 8 } };
}

test('DeepSeek HTTP adapter returns recalled evidence to the model and validates its decision', async t => {
  const { model, requests } = await mockModel(t, (req, round) => round === 1
    ? toolResponse('recall_trades', { symbol: 'BTCUSDT' })
    : toolResponse('submit_decision', { action: 'hold', confidence: 60, reason: '证据不足', risks: ['波动风险'] }));
  const memories = [{ symbol: 'BTCUSDT', pnl: -3, source: 'binance' }];
  const decision = await model.analyze({ symbol: 'BTCUSDT', price: 100 }, memories, []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'mock-model');
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), memories);
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'call-1');
  assert.equal(decision.action, 'hold');
  assert.equal(decision.usage.prompt_tokens, 30);
  assert.deepEqual(decision.calls.map(c => c.name), ['recall_trades', 'submit_decision']);
});

test('DeepSeek HTTP adapter enforces its tool budget and rejects unauthorized operations', async t => {
  const { model, requests } = await mockModel(t, () => toolResponse('recall_trades', { symbol: 'BTCUSDT' }));
  await assert.rejects(model.analyze({ symbol: 'BTCUSDT' }, [], []), /3 轮预算/);
  assert.equal(requests.length, 3);
  const other = await mockModel(t, () => toolResponse('place_order', { symbol: 'BTCUSDT' }));
  await assert.rejects(other.model.analyze({ symbol: 'BTCUSDT' }, [], []), /未授权工具/);
});
