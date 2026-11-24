"use strict";
// 路径与目录约定（照 dsh-bili-whale 的 lib/paths 分层）。
const path = require("path");
const fs = require("fs");
const os = require("os");

const PACK_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PACK_DIR, "data");

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} return p; }
function stateFile(name) { ensureDir(DATA_DIR); return path.join(DATA_DIR, name); }

module.exports = { PACK_DIR, DATA_DIR, ensureDir, stateFile };
