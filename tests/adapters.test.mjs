import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeepSeek, jsonFetch } from '../server/adapters.mjs';

async function mockModel(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.setHeader('Content-Type', 'application/json');
    const response = respond(request, requests.length);
    res.statusCode = response.httpStatus || 200;
    res.end(JSON.stringify(response.httpStatus ? response.body : response));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const settings = { deepseekBase: `http://127.0.0.1:${server.address().port}`, deepseekModel: 'mock-model' };
  const model = new DeepSeek({ get: () => settings, secret: () => 'test-key' });
  return { model, requests, base: settings.deepseekBase };
}

function toolResponse(name, input) {
  return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 15, completion_tokens: 8 } };
}

test('DeepSeek HTTP adapter uses a compatible tool mode and returns recalled evidence to the model', async t => {
  const { model, requests } = await mockModel(t, (req, round) => {
    if (req.tool_choice === 'required' && req.thinking?.type !== 'disabled') return { httpStatus: 400, body: { error: { message: 'Thinking mode does not support this tool_choice', type: 'invalid_request_error' } } };
    return round === 1
      ? toolResponse('recall_trades', { symbol: 'BTCUSDT' })
      : toolResponse('submit_decision', { action: 'hold', confidence: 60, reason: '证据不足', risks: ['波动风险'] });
  });
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

test('provider HTTP failures preserve the cause while redacting echoed credentials', async t => {
  const credential = 'test-credential-without-a-standard-prefix';
  const { base } = await mockModel(t, () => ({ httpStatus: 400, body: { error: { type: 'invalid_request_error', message: 'Thinking mode does not support this tool_choice; authorization=' + credential } } }));
  await assert.rejects(jsonFetch(base, { method: 'POST', headers: { Authorization: 'Bearer ' + credential }, body: '{}' }), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /invalid_request_error/);
    assert.match(error.message, /Thinking mode does not support this tool_choice/);
    assert.ok(!error.message.includes(credential));
    return true;
  });
});
