import { randomUUID } from 'node:crypto';
import { newAccount, equity, buy, sell, mark, riskCheck, defaultRisk } from './ledger.mjs';
import { SYMBOLS, demoQuote, publicQuote, safeError } from './adapters.mjs';

export const defaultAgents = [
  { id: 'scout', name: 'SCOUT', label: '市场扫描', role: 'scanner', color: 'amber', prompt: '扫描现货交易对，检查报价时效与买卖价差。' },
  { id: 'analyst', name: 'ANALYST', label: '策略分析', role: 'analyst', color: 'blue', prompt: '分析量价、市场动量和不确定性。证据不足时等待。' },
  { id: 'memory', name: 'MEMORY', label: '经验检索', role: 'memory', color: 'violet', prompt: '检索该品种的历史盈亏记录，保留失败案例及其上下文。' },
  { id: 'risk', name: 'RISK', label: '风险控制', role: 'risk', color: 'rose', prompt: '固定代码执行仓位、敞口、亏损、时效与置信度检查。' },
  { id: 'executor', name: 'EXECUTOR', label: '模拟执行', role: 'executor', color: 'green', prompt: '仅通过 PaperBroker 下单；模拟不利滑点和双边手续费。' },
  { id: 'logger', name: 'LOGGER', label: '审计记录', role: 'logger', color: 'slate', prompt: '持久化输入证据、Agent 决策、风控结论和每一笔成交。' }
].map(a => ({ ...a, enabled: true, builtin: true }));

export class Desk {
  constructor(store, deepseek, binance) {
    this.store = store; this.deepseek = deepseek; this.binance = binance;
    this.settings = { feed: 'demo', intervalSeconds: 30, deepseekBase: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-flash', binanceClientId: process.env.BINANCE_OAUTH_CLIENT_ID || '', binanceTickerTool: '', ...store.get('settings', {}) };
    this.risk = { ...defaultRisk, ...store.get('risk', {}) };
    this.agents = store.get('agents', defaultAgents);
    this.states = {}; this.agents.forEach(a => { this.states[a.id] = { status: a.enabled ? 'idle' : 'disabled', task: '等待下一轮任务', runs: 0, latencyMs: 0 }; });
    this.account = store.get('account:' + this.settings.feed, newAccount(this.settings.feed));
    this.quotes = {}; this.running = false; this.busy = false; this.refreshing = false; this.tick = 0; this.cycle = 0; this.generation = 0; this.lastCycle = 0; this.lastRefresh = 0; this.marketError = ''; this.nextRun = null; this.activeSymbol = ''; this.startedAt = null;
    this.decisions = store.get('decisions:' + this.account.id, []);
    if (this.settings.feed === 'demo' && !store.get('account:demo')) this.seedDemo();
    this.persist();
  }
  seedDemo() {
    const start = Date.now() - 80 * 60000;
    mark(this.account, {}, new Date(start).toISOString());
    for (let i = 0; i < 12; i++) {
      const symbol = SYMBOLS[i % 3], time = new Date(start + i * 6 * 60000).toISOString();
      const q = { ...demoQuote(symbol, i * 3), time };
      const reason = ['演示案例：量价动量通过规则筛选', '演示案例：价格回踩后的模拟入场', '演示案例：检验固定仓位与退出纪律'][i % 3];
      const decision = { action: 'buy', confidence: 78, reason, risks: ['合成行情，不代表策略表现'], model: 'deterministic-demo', calls: [], usage: { prompt_tokens: 0, completion_tokens: 0 } };
      const p = buy(this.account, { action: 'buy', symbol, notional: equity(this.account) * this.risk.positionPct / 100, reason, decision }, q, this.risk, time);
      const delta = [0.019, -0.011, 0.026, 0.008, -0.013, 0.024][i % 6];
      const closeTime = new Date(start + (i * 6 + 4) * 60000).toISOString();
      const t = sell(this.account, p.id, { price: q.price * (1 + delta), time: closeTime }, delta > 0 ? '演示回放 · 规则止盈' : '演示回放 · 风控退出', closeTime);
      mark(this.account, {}, closeTime);
      this.log('TRADE', 'logger', `${symbol} 模拟平仓 ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} USDT`, { tradeId: t.id, demo: true }, closeTime);
    }
    this.log('SYSTEM', 'logger', '已载入 12 笔合成行情演示交易。演示数据与真实行情模拟账户完全隔离。');
  }
  log(kind, agent, message, extra = {}, time) {
    this.store.audit(kind, { accountId: this.account.id, agent, message, source: this.settings.feed, ...(time ? { time } : {}), ...extra });
    this.onChange?.();
  }
  state(id, status, task) { this.states[id] = { ...(this.states[id] || {}), status, task, updatedAt: new Date().toISOString() }; this.onChange?.(); }
  persist() { this.store.put('account:' + this.settings.feed, this.account); this.store.put('decisions:' + this.account.id, this.decisions); }
  async step(id, task, work) {
    const agent = this.agents.find(a => a.id === id);
    if (!agent?.enabled) throw new Error(`${agent?.name || id} 已停用`);
    const started = Date.now(); this.state(id, 'working', task);
    this.log('AGENT', id, task);
    try {
      if (this.settings.feed === 'demo') await new Promise(r => setTimeout(r, 380));
      const result = await work();
      this.states[id].runs++; this.states[id].latencyMs = Date.now() - started;
      this.state(id, 'idle', task + ' · 已完成'); return result;
    } catch (error) { this.state(id, 'error', safeError(error)); throw error; }
  }
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const account = this.account, feed = this.settings.feed;
    try {
      const quotes = await Promise.all(SYMBOLS.map(symbol => feed === 'demo' ? demoQuote(symbol, this.tick) : this.binance.client ? this.binance.quote(symbol) : publicQuote(symbol)));
      // A source change can happen while network requests are pending.
      if (this.account !== account || this.settings.feed !== feed) return;
      this.quotes = Object.fromEntries(quotes.map(q => [q.symbol, q])); this.tick++; this.lastRefresh = Date.now(); this.marketError = '';
      for (const p of [...this.account.positions]) {
        const q = this.quotes[p.symbol];
        if (q && (q.price <= p.stop || q.price >= p.take)) {
          const t = sell(this.account, p.id, q, q.price <= p.stop ? '固定止损触发' : '固定止盈触发');
          this.log('TRADE', 'executor', `${p.symbol} ${t.exitReason} · 净盈亏 ${t.pnl.toFixed(2)} USDT`, { tradeId: t.id });
        }
      }
      mark(this.account, this.quotes); this.persist(); this.onChange?.();
    } catch (error) {
      if (this.account !== account || this.settings.feed !== feed) return;
      const msg = safeError(error); if (msg !== this.marketError) this.log('ERROR', 'scout', msg);
      this.marketError = msg; this.onChange?.();
    } finally { this.refreshing = false; }
  }
  async runCycle() {
    if (!this.running || this.busy) return;
    this.busy = true; const generation = this.generation; this.lastCycle = Date.now(); this.cycle++;
    const valid = () => { if (!this.running || generation !== this.generation) throw new Error('运行已暂停，此轮决策失效'); };
    try {
      const symbol = SYMBOLS[(this.cycle - 1) % SYMBOLS.length]; this.activeSymbol = symbol;
      const quote = await this.step('scout', '扫描 ' + symbol + ' · 检查数据新鲜度', async () => {
        if (!this.quotes[symbol] || Date.now() - new Date(this.quotes[symbol].time).getTime() > 15000) await this.refresh();
        const q = this.quotes[symbol];
        if (!q || Date.now() - new Date(q.time).getTime() > 30000) throw new Error('行情不可用，停止本轮开仓');
        if ((q.ask - q.bid) / q.price > 0.005) throw new Error('买卖价差超过 0.5%');
        return { ...q };
      });
      valid();
      const memories = await this.step('memory', '检索 ' + symbol + ' 最近成交与失败案例', async () => this.account.trades.filter(t => t.symbol === symbol).slice(-12).map(t => ({ symbol: t.symbol, reason: t.reason, pnl: t.pnl, exitReason: t.exitReason, openedAt: t.openedAt, source: t.source })));
      valid();
      const analysts = this.agents.filter(a => a.id === 'analyst');
      let decision = await this.step('analyst', this.settings.feed === 'demo' ? '执行演示策略 · 合成行情' : 'DeepSeek 分析 ' + symbol, async () => this.settings.feed === 'demo' ? { action: this.cycle % 4 === 0 ? 'hold' : 'buy', confidence: 73 + this.cycle % 15, reason: this.cycle % 4 === 0 ? '演示规则：本轮等待更充分的证据' : '演示规则：价差合格、固定仓位，验证模拟执行链路', risks: ['合成行情，无法用于评估策略收益'], model: 'deterministic-demo', calls: [{ name: 'recall_trades', arguments: { symbol } }], usage: { prompt_tokens: 0, completion_tokens: 0 }, latencyMs: 0 } : await this.deepseek.analyze(quote, memories, analysts));
      valid();
      for (const reviewer of this.agents.filter(a => !a.builtin && a.enabled)) {
        const review = await this.step(reviewer.id, '独立审查 ' + symbol + ' 的候选决策', async () => this.settings.feed === 'demo' ? { action: decision.action, reason: '演示审查已记录：' + reviewer.prompt } : await this.deepseek.analyze(quote, memories, [reviewer]));
        valid();
        decision.reviews = [...(decision.reviews || []), { agent: reviewer.name, ...review }];
        if (review.action === 'hold') { decision.action = 'hold'; decision.reason += '；' + reviewer.name + ': ' + review.reason; }
      }
      const order = { symbol, action: decision.action, notional: equity(this.account, this.quotes) * this.risk.positionPct / 100, reason: decision.reason, decision };
      const check = await this.step('risk', '检查仓位、敞口、日亏损与执行条件', async () => {
        const r = riskCheck(this.account, order, this.quotes, this.risk);
        if (decision.confidence < 70) { r.approved = false; r.reasons.push('置信度低于 70'); }
        return r;
      });
      valid();
      this.log('DECISION', 'risk', `${symbol} · ${check.approved ? '风控通过' : '风控拒绝'}`, { decision, check, quote });
      // Check the fresh quote again at execution time; model latency never makes stale prices executable.
      let trade = null;
      if (check.approved) trade = await this.step('executor', 'PaperBroker 模拟买入 ' + symbol, async () => {
        valid();
        order.notional = Math.min(order.notional, equity(this.account, this.quotes) * this.risk.positionPct / 100);
        const latest = riskCheck(this.account, order, this.quotes, this.risk);
        if (!latest.approved) throw new Error('执行前复核失败：' + latest.reasons.join('；'));
        const p = buy(this.account, order, this.quotes[symbol], this.risk, new Date().toISOString(), this.quotes);
        p.timeline.unshift({ time: quote.time, agent: 'ANALYST', action: 'ANALYZE', text: decision.reason }, { time: check.checkedAt, agent: 'RISK', action: 'APPROVE', text: '仓位、敞口与报价检查通过' });
        p.decision.quote = quote; p.decision.riskCheck = check;
        this.log('TRADE', 'executor', `${symbol} 模拟买入 ${order.notional.toFixed(2)} USDT`, { tradeId: p.id });
        this.persist(); return p;
      });
      else this.state('executor', 'idle', '未执行 · ' + check.reasons.join('；'));
      await this.step('logger', '保存模型结论、风控结果与成交证据', async () => {
        const d = { id: randomUUID(), time: new Date().toISOString(), symbol, decision, check, tradeId: trade?.id || null, quote };
        this.decisions.unshift(d); this.decisions = this.decisions.slice(0, 300);
        this.log(check.approved ? 'ENTER' : 'SKIP', 'logger', `${symbol} · ${check.approved ? decision.reason : check.reasons.join('；')}`, { decisionId: d.id, tradeId: trade?.id });
        this.persist();
      });
    } catch (error) {
      this.log('ERROR', 'head', safeError(error));
    } finally { this.busy = false; this.nextRun = this.running ? this.lastCycle + this.settings.intervalSeconds * 1000 : null; this.onChange?.(); }
  }
  start() {
    if (this.settings.feed !== 'demo' && !this.deepseek.key()) throw new Error('请先在连接设置中配置 DeepSeek API Key');
    if (this.agents.some(a => a.builtin && !a.enabled)) throw new Error('请启用全部内置 Agent 后再启动');
    this.running = true; this.startedAt ||= new Date().toISOString(); this.generation++;
    this.log('SYSTEM', 'head', '模拟交易台已启动 · 所有订单仅使用模拟资金');
    void this.runCycle();
  }
  pause() { this.running = false; this.generation++; this.nextRun = null; this.log('SYSTEM', 'head', '已暂停新开仓；行情与已有模拟持仓风控继续运行'); }
  async closePosition(id) {
    const p = this.account.positions.find(x => x.id === id); if (!p) throw new Error('持仓不存在');
    const t = sell(this.account, id, this.quotes[p.symbol], '用户手动模拟平仓');
    mark(this.account, this.quotes); this.persist(); this.log('TRADE', 'executor', `${t.symbol} 手动模拟平仓 · 净盈亏 ${t.pnl.toFixed(2)}`, { tradeId: t.id }); return t;
  }
  updateSettings(update) {
    if (this.busy) throw new Error('请先暂停并等待当前任务结束，再修改连接');
    this.pause();
    if (update.feed && update.feed !== this.settings.feed) {
      this.persist(); this.settings.feed = update.feed;
      this.account = this.store.get('account:' + update.feed, newAccount(update.feed));
      this.decisions = this.store.get('decisions:' + this.account.id, []); this.quotes = {}; this.lastRefresh = 0;
    }
    this.settings = { ...this.settings, ...update }; this.store.put('settings', this.settings); this.persist();
    this.log('SYSTEM', 'head', '连接设置已保存；演示与真实行情模拟账户独立记账');
  }
  snapshot() {
    const nav = equity(this.account, this.quotes), trades = this.account.trades;
    const wins = trades.filter(t => t.pnl > 0).length;
    const events = this.store.events(600).filter(e => e.accountId === this.account.id).slice(0, 160);
    return { running: this.running, busy: this.busy, mode: 'paper', liveEnabled: false, startedAt: this.startedAt, cycle: this.cycle, activeSymbol: this.activeSymbol, nextRun: this.nextRun, now: new Date().toISOString(), settings: this.settings, risk: this.risk,
      agents: this.agents.map(a => ({ ...a, ...this.states[a.id] })), quotes: Object.values(this.quotes), marketError: this.marketError,
      account: { id: this.account.id, source: this.account.source, cash: this.account.cash, initialBalance: this.account.initialBalance, equity: nav, pnl: nav - this.account.initialBalance, realized: trades.reduce((s, t) => s + t.pnl, 0), fee: [...trades, ...this.account.positions].reduce((s, t) => s + t.fee, 0), wins, losses: trades.length - wins, winRate: trades.length ? wins / trades.length * 100 : 0, maxDrawdown: this.account.maxDrawdown, curve: this.account.curve.slice(-240) },
      positions: this.account.positions.map(p => ({ ...p, mark: this.quotes[p.symbol]?.price ?? p.entry, unrealized: p.quantity * ((this.quotes[p.symbol]?.price ?? p.entry) - p.entry) - p.entryFee })), trades: [...trades].reverse(), decisions: this.decisions.slice(0, 50), events,
      integrations: { deepseek: { configured: !!this.deepseek.key(), model: this.settings.deepseekModel }, binance: { status: this.binance.status, error: this.binance.error, tools: this.binance.tools.map(t => ({ name: t.name, description: t.description, allowed: this.binance.isAllowed(t.name) })), endpoint: 'https://agent.binance.com/mcp/agentic' }, market: { source: this.quotes.BTCUSDT?.source || '等待数据', updatedAt: this.lastRefresh } }
    };
  }
}
