"use strict";
// 发送回执与复核（学 dsh-bili-whale：写操作 --dry → --go → 回读复核）
//
// 铁律：**未确认发送不等于成功**。返回成功码但没拿到实体 ID，不算成功；
// 报错或超时后先核查，禁止换措辞重发（避免重复刷屏）。
const fs = require('fs');
const { stateFile } = require('./paths.cjs');

const FILE = () => stateFile('send-receipts.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf-8')); } catch { return { receipts: [] }; } }
function save(v) { try { fs.writeFileSync(FILE(), JSON.stringify(v, null, 2), { mode: 0o600 }); } catch (e) { console.error('[receipt] 写入失败:', e.message); } }

/** 记录一次发送尝试。status: pending → confirmed | unknown | failed */
function record({ kind, target, text, status, entityId, error }) {
  const v = load();
  const id = 'r' + Date.now() + Math.floor(Math.random() * 1000);
  v.receipts.push({ id, kind, target: String(target||''), text: String(text||'').slice(0,200), status, entityId: entityId ? String(entityId) : null, error: error ? String(error).slice(0,300) : null, at: Date.now() });
  if (v.receipts.length > 300) v.receipts = v.receipts.slice(-300);
  save(v);
  return id;
}

/** 把 pending 标记为确认/未知（回读复核后调用） */
function settle(id, status, entityId) {
  const v = load();
  const r = v.receipts.find(x => x.id === id);
  if (!r) return { ok: false, message: '找不到回执' };
  r.status = status;
  if (entityId) r.entityId = String(entityId);
  r.settledAt = Date.now();
  save(v);
  return { ok: true };
}

/** 未确认的回执（供核查） */
function unconfirmed() {
  return load().receipts.filter(r => r.status === 'pending' || r.status === 'unknown');
}

/** 最近的回执（给模型看自己刚干了什么） */
function recent(n = 10) { return load().receipts.slice(-Math.max(1, n)); }

module.exports = { record, settle, unconfirmed, recent };
