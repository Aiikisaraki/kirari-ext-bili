"use strict";
// 评论：两段式 + 回读复核（照 dsh-bili-whale 的 comment 命令）
// dry=true 只预检不发；go 真发；发后回读确认 rpid 存在才算成功。
const receipt = require('../lib/send-receipt.cjs');

/**
 * @param api BiliApi 实例
 * @param args { bvid, text, dry }
 */
async function comment(api, args = {}) {
  const bvid = String(args.bvid || '');
  const text = String(args.text || '').trim();
  if (!bvid) return { ok: false, error: '缺少 bvid' };
  if (!text) return { ok: false, error: '评论内容为空' };
  if (text.length > 200) return { ok: false, error: '评论太长' };

  const info = await api.request('/x/web-interface/view', { bvid });
  if (info.code !== 0) return { ok: false, error: info.message || '取视频信息失败' };
  const aid = info.data.aid;

  // dry：只预检，不发网络写请求
  if (args.dry === true) {
    return { ok: true, dry: true, preview: { aid, bvid, text }, message: '预检通过（未发送）' };
  }

  // 真发：先记 pending 回执
  const rid = receipt.record({ kind: 'comment', target: bvid, text, status: 'pending' });
  try {
    const r = await api.request('/x/v2/reply/add', { oid: aid, type: 1, message: text }, { cache: false });
    if (r.code !== 0) {
      // 明确失败：不算发送成功
      receipt.settle(rid, 'failed', null);
      return { ok: false, error: r.message || ('评论失败 code=' + r.code), receiptId: rid };
    }
    const rpid = r.data && (r.data.rpid || r.data.rpid_str);
    if (!rpid) {
      // 返回成功但没有实体 ID：**不算成功**，标记 unknown 等核查
      receipt.settle(rid, 'unknown');
      return { ok: false, unknown: true, receiptId: rid, message: '返回成功但没有评论 ID，已标记待核查（不要重发）' };
    }
    // 回读复核：确认这条评论真的存在
    const verify = await api.request('/x/v2/reply/main', { type: 1, oid: aid, mode: 3, ps: 20 }, { cache: false });
    const found = (verify.code === 0 && (verify.data.replies || []).some(x => String(x.rpid) === String(rpid)));
    receipt.settle(rid, found ? 'confirmed' : 'unknown', rpid);
    return { ok: true, rpid: String(rpid), verified: found, receiptId: rid, message: found ? '评论已发出并回读确认' : '评论已提交，回读暂未看到（可能延迟，勿重发）' };
  } catch (e) {
    receipt.settle(rid, 'unknown');
    return { ok: false, unknown: true, receiptId: rid, error: e.message, message: '结果未知，已标记待核查（不要换措辞重发）' };
  }
}

module.exports = { comment };
