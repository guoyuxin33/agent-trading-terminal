import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { Store } from './store.mjs';
import { DeepSeek, BinanceMCP, safeError } from './adapters.mjs';
import { Desk } from './desk.mjs';
try { loadEnvFile(); } catch { /* Environment file is optional. */ }
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8787);
const store = new Store(resolve(process.env.DATA_DIR || resolve(root, 'data'), 'desk.sqlite'));
const model = new DeepSeek(store), binance = new BinanceMCP(store, `http://127.0.0.1:${port}/api/binance/callback`);
const desk = new Desk(store, model, binance), app = express(), streams = new Set();
app.disable('x-powered-by');
app.use((req, res, next) => {
  // Loopback only, with host and origin checks against DNS rebinding / cross-site writes.
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return res.status(403).json({ error: '仅允许本机访问' });
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, 'http://127.0.0.1:5173', `http://localhost:${port}`, 'http://localhost:5173'].includes(origin)) return res.status(403).json({ error: '来源不被允许' });
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-agent-desk'] !== 'local') return res.status(403).json({ error: '缺少本地操作标识' });
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
});
app.use(express.json({ limit: '48kb' }));
const broadcast = () => { for (const client of streams) client.write('data: ' + JSON.stringify(desk.snapshot()) + '\n\n'); };
let scheduled = false;
desk.onChange = () => { if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; broadcast(); }, 50); };
app.get('/api/state', (req, res) => res.json(desk.snapshot()));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.flushHeaders();
  streams.add(res); res.write('data: ' + JSON.stringify(desk.snapshot()) + '\n\n');
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => { streams.delete(res); clearInterval(heartbeat); });
});
app.post('/api/control', (req, res) => {
  const { action } = z.object({ action: z.enum(['start', 'pause', 'step']) }).parse(req.body);
  if (action === 'pause') desk.pause();
  else if (action === 'start') { if (!desk.running) desk.start(); }
  else { if (!desk.running) desk.start(); else void desk.runCycle(); }
  res.json(desk.snapshot());
});
app.post('/api/positions/:id/close', async (req, res) => res.json(await desk.closePosition(req.params.id)));
app.post('/api/agents', (req, res) => {
  const value = z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{1,23}$/), label: z.string().min(1).max(30), prompt: z.string().min(8).max(2000) }).parse(req.body);
  if (desk.agents.length >= 12) return res.status(400).json({ error: '最多创建 12 个 Agent' });
  const agent = { ...value, name: value.name.toUpperCase(), id: 'custom-' + Date.now(), role: 'reviewer', color: 'violet', enabled: true, builtin: false };
  desk.agents.push(agent); desk.states[agent.id] = { status: 'idle', task: '独立审查候选决策', runs: 0, latencyMs: 0 };
  store.put('agents', desk.agents); desk.log('SYSTEM', 'head', '已创建审查 Agent：' + agent.name); res.json(agent);
});
app.patch('/api/agents/:id', (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body), agent = desk.agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent 不存在' });
  if (desk.busy) return res.status(409).json({ error: '请暂停并等待当前任务完成' });
  if (agent.builtin && desk.running) return res.status(409).json({ error: '请先暂停交易台' });
  agent.enabled = enabled; desk.state(agent.id, enabled ? 'idle' : 'disabled', enabled ? '等待任务' : '已停用'); store.put('agents', desk.agents); res.json(agent);
});
app.post('/api/settings', (req, res) => {
  const value = z.object({ feed: z.enum(['demo', 'binance']), intervalSeconds: z.number().int().min(15).max(3600), deepseekBase: z.enum(['https://api.deepseek.com', 'https://api.deepseek.com/v1']), deepseekModel: z.string().min(2).max(80), deepseekKey: z.string().max(300).optional(), binanceClientId: z.string().max(200), binanceTickerTool: z.string().max(200) }).parse(req.body);
  const { deepseekKey, ...settings } = value;
  desk.updateSettings(settings);
  if (deepseekKey) store.secret('deepseek', deepseekKey);
  res.json({ saved: true });
});
app.post('/api/risk', (req, res) => {
  if (desk.running || desk.busy) return res.status(409).json({ error: '请先暂停并等待当前任务完成' });
  const values = z.object({ positionPct: z.number().min(0.1).max(20), maxPositions: z.number().int().min(1).max(3), stopPct: z.number().min(0.1).max(10), takePct: z.number().min(0.1).max(30), dailyLossPct: z.number().min(0.1).max(10), feeBps: z.number().min(0).max(100), slippageBps: z.number().min(0).max(200) }).parse(req.body);
  desk.risk = values; store.put('risk', values); desk.log('SYSTEM', 'risk', '风控参数已更新；已有持仓保留入场时的止盈止损参数'); res.json(values);
});
app.post('/api/deepseek/test', async (req, res) => res.json(await model.test()));
app.post('/api/binance/connect', async (req, res) => res.json(await binance.connect()));
app.post('/api/binance/disconnect', async (req, res) => { await binance.close(); store.secret('binance_tokens', ''); res.json({ disconnected: true }); });
app.get('/api/binance/callback', async (req, res) => {
  const code = z.string().min(1).parse(req.query.code), state = z.string().min(1).parse(req.query.state);
  await binance.callback(code, state); desk.log('SYSTEM', 'scout', 'Binance MCP OAuth 已连接');
  res.redirect(`http://127.0.0.1:${port}/?binance=connected`);
});
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="agent-desk-journal.json"');
  res.json({ exportedAt: new Date().toISOString(), account: desk.account, decisions: desk.decisions, events: store.events(100000).filter(e => e.accountId === desk.account.id) });
});
const dist = resolve(root, 'dist');
if (existsSync(dist)) { app.use(express.static(dist)); app.get('/{*path}', (req, res) => req.path.startsWith('/api') ? res.status(404).json({ error: '接口不存在' }) : res.sendFile(resolve(dist, 'index.html'))); }
app.use((err, req, res, next) => { res.status(err instanceof z.ZodError ? 400 : 422).json({ error: err instanceof z.ZodError ? '参数无效：' + err.issues.map(i => i.path.join('.') + ' ' + i.message).join('；') : safeError(err) }); });
let timer = setInterval(() => {
  if (Date.now() - desk.lastRefresh > (desk.settings.feed === 'demo' ? 2000 : 5000)) void desk.refresh();
  if (desk.running && !desk.busy && Date.now() - desk.lastCycle >= desk.settings.intervalSeconds * 1000) void desk.runCycle();
}, 1000);
void desk.refresh();
const server = app.listen(port, '127.0.0.1', () => console.log(`Agent Desk ready: http://127.0.0.1:${port} (paper only)`));
const shutdown = async () => { clearInterval(timer); desk.pause(); desk.persist(); await binance.close(); for (const client of streams) client.end(); server.close(); store.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
