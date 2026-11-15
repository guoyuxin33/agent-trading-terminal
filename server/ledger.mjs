import { randomUUID } from 'node:crypto';
export const defaultRisk = { positionPct: 8, maxPositions: 3, stopPct: 1.5, takePct: 3, dailyLossPct: 3, feeBps: 10, slippageBps: 5 };
export function newAccount(source = 'demo', initialBalance = 10000) {
  return { id: randomUUID(), source, initialBalance, cash: initialBalance, positions: [], trades: [], curve: [], createdAt: new Date().toISOString(), highWater: initialBalance, maxDrawdown: 0 };
}
export function equity(account, quotes = {}) {
  return account.cash + account.positions.reduce((total, p) => total + p.quantity * (quotes[p.symbol]?.price ?? p.entry), 0);
}
export function riskCheck(account, order, quotes, risk = defaultRisk, now = Date.now()) {
  const reasons = [], q = quotes[order.symbol];
  const nav = equity(account, quotes);
  if (!q || !Number.isFinite(q.price) || q.price <= 0) reasons.push('无有效报价');
  if (q && now - new Date(q.time).getTime() > 30000) reasons.push('报价已过期');
  if (order.action !== 'buy') reasons.push('仅接受现货买入信号');
  if (account.positions.some(p => p.symbol === order.symbol)) reasons.push('已有同币种持仓');
  if (account.positions.length >= risk.maxPositions) reasons.push('达到最大持仓数量');
  if (!Number.isFinite(order.notional) || order.notional < 10) reasons.push('订单金额必须至少为 10 USDT');
  if (order.notional > nav * risk.positionPct / 100 + 0.000001) reasons.push('超过单笔仓位上限');
  if (order.notional * (1 + risk.feeBps / 10000) > account.cash) reasons.push('可用模拟资金不足');
  const today = new Date(now).toISOString().slice(0, 10);
  const pnl = account.trades.filter(t => t.closedAt?.startsWith(today)).reduce((s, t) => s + t.pnl, 0);
  if (pnl <= -account.initialBalance * risk.dailyLossPct / 100) reasons.push('触及当日已实现亏损上限');
  if (nav <= account.initialBalance * (1 - risk.dailyLossPct / 100)) reasons.push('触及账户权益亏损上限');
  return { approved: reasons.length === 0, reasons, nav, checkedAt: new Date(now).toISOString() };
}
export function buy(account, order, quote, risk = defaultRisk, time = new Date().toISOString(), quotes = { [order.symbol]: quote }) {
  if (![order.notional, quote.price].every(x => Number.isFinite(x) && x > 0)) throw new Error('订单价格或金额无效');
  const check = riskCheck(account, order, quotes, risk, new Date(time).getTime());
  if (!check.approved) throw new Error(check.reasons.join('；'));
  const entry = quote.price * (1 + risk.slippageBps / 10000), quantity = order.notional / entry;
  const entryFee = order.notional * risk.feeBps / 10000;
  const p = { id: randomUUID(), accountId: account.id, symbol: order.symbol, side: 'LONG', status: 'open', source: account.source, entry, quantity, notional: order.notional, entryFee, fee: entryFee, stop: entry * (1 - risk.stopPct / 100), take: entry * (1 + risk.takePct / 100), openedAt: time, closedAt: null, exit: null, pnl: null, reason: order.reason, decision: order.decision ?? {}, risk: { ...risk }, fills: [{ side: 'BUY', price: entry, quantity, fee: entryFee, time, venue: 'PaperBroker', slippageBps: risk.slippageBps }], timeline: [{ time, agent: 'EXECUTOR', action: 'BUY', text: order.reason }] };
  account.cash -= order.notional + entryFee;
  account.positions.push(p);
  return p;
}
export function sell(account, id, quote, reason, time = new Date().toISOString()) {
  const p = account.positions.find(x => x.id === id);
  if (!p) throw new Error('持仓不存在或已平仓');
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0 || new Date(time).getTime() - new Date(quote.time).getTime() > 30000) throw new Error('平仓报价无效或已过期');
  const exit = quote.price * (1 - p.risk.slippageBps / 10000), gross = exit * p.quantity, fee = gross * p.risk.feeBps / 10000;
  account.cash += gross - fee;
  p.exit = exit; p.closedAt = time; p.status = 'closed'; p.exitReason = reason; p.fee += fee; p.pnl = gross - p.notional - p.fee;
  p.fills.push({ side: 'SELL', price: exit, quantity: p.quantity, fee, time, venue: 'PaperBroker', slippageBps: p.risk.slippageBps });
  p.timeline.push({ time, agent: 'EXECUTOR', action: 'SELL', text: reason });
  account.positions = account.positions.filter(x => x.id !== id); account.trades.push(p);
  return p;
}
export function mark(account, quotes, time = new Date().toISOString()) {
  const nav = equity(account, quotes);
  account.highWater = Math.max(account.highWater, nav);
  account.maxDrawdown = Math.max(account.maxDrawdown, (account.highWater - nav) / account.highWater * 100);
  account.curve.push({ time, value: nav }); if (account.curve.length > 1500) account.curve.shift();
  return nav;
}
