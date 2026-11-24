"use strict";
// B站发送闸门（学大肥鱼：审核 / 判重 / 冷却 / 额度 / 退避）。状态只存本机扩展包目录。
const fs = require('fs');
const path = require('path');
const STATE_FILE = (dir) => path.join(dir, 'send-guard.json');
const COOLDOWN = { comment: 300000, dynamic: 1800000, dm: 3600000, like: 60000, coin: 300000, favorite: 60000 };
const DAILY_CAP = { comment: 20, dynamic: 3, dm: 10, like: 50, coin: 20, favorite: 50 };
function fresh() { return { sent: {}, lastAt: {}, daily: {}, pending: [], history: [] }; }
function load(dir) { try { const v = JSON.parse(fs.readFileSync(STATE_FILE(dir),'utf-8')); return v && typeof v === 'object' ? v : fresh(); } catch { return fresh(); } }
function save(dir, v) { try { fs.writeFileSync(STATE_FILE(dir), JSON.stringify(v,null,2), {mode:0o600}); } catch(e) { console.error('[bili-guard] 写入失败:', e.message); } }
function dayKey(now) { const d = new Date(now||Date.now()); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
function norm(s) { return String(s||'').replace(/\s+/g,'').slice(0,200); }
function check(dir, kind, payload, opts) {
  opts = opts || {}; const v = load(dir); const now = Date.now();
  const key = norm(kind + ':' + (payload.target || payload.text || payload.id || ''));
  if ((v.sent[key]||0) > 0) return { ok:false, reason:'duplicate', message:'这条已经发过，不重复发' };
  const cd = COOLDOWN[kind] || 60000;
  if (now - (v.lastAt[kind]||0) < cd) return { ok:false, reason:'cooldown', message:kind+' 冷却中，稍后再试' };
  const dk = dayKey(now); const used = (v.daily[dk] && v.daily[dk][kind]) || 0;
  if (used >= (DAILY_CAP[kind]||20)) return { ok:false, reason:'quota', message:kind+' 今日额度已用完，退避不发' };
  if (opts.requireApproval) {
    const p = v.pending.find((x) => x.key === key && (x.status === 'pending' || x.status === 'approved'));
    if (!p) { v.pending.push({ id:'p'+now+Math.floor(Math.random()*1000), key, kind, payload, text:String(payload.text||'').slice(0,200), status:'pending', createdAt:now }); save(dir,v);
      return { ok:false, reason:'need_approval', message:'这条'+kind+'已提交审核，等主人批准后才发' }; }
    if (p.status === 'rejected') return { ok:false, reason:'rejected', message:'主人拒绝了这条'+kind };
    if (p.status !== 'approved') return { ok:false, reason:'pending', message:'这条'+kind+'还在等批准' };
  }
  return { ok:true };
}
function markSent(dir, kind, payload) {
  const v = load(dir); const now = Date.now();
  const key = norm(kind + ':' + (payload.target || payload.text || payload.id || ''));
  v.sent[key] = now; v.lastAt[kind] = now;
  const dk = dayKey(now); v.daily[dk] = v.daily[dk] || {}; v.daily[dk][kind] = (v.daily[dk][kind]||0)+1;
  v.pending = v.pending.filter((p) => p.key !== key);
  v.history.push({ kind, key, at:now, text:String(payload.text||'').slice(0,120) });
  if (v.history.length > 200) v.history = v.history.slice(-200);
  save(dir,v); return { ok:true };
}
function markBlocked(dir, kind, code) {
  const v = load(dir); const now = Date.now(); v.lastAt[kind] = now;
  v.history.push({ kind, blocked:String(code||''), at:now });
  if (v.history.length > 200) v.history = v.history.slice(-200);
  save(dir,v); return { ok:true };
}
function listPending(dir) { return (load(dir).pending||[]).filter((p) => p.status === 'pending'); }
function decide(dir, id, approve) { const v=load(dir); const p=v.pending.find((x)=>x.id===id); if(!p) return {ok:false,message:'找不到这条待审核'}; p.status=approve?'approved':'rejected'; p.decidedAt=Date.now(); save(dir,v); return {ok:true,status:p.status}; }
module.exports = { check, markSent, markBlocked, listPending, decide, COOLDOWN, DAILY_CAP };
