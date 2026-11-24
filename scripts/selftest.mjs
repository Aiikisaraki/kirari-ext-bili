import { spawn } from 'node:child_process';

const proc = spawn(process.execPath, ['bin/server.cjs'], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
let nextId = 1;
proc.stdout.on('data', (c) => {
  buf += c.toString();
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
proc.stderr.on('data', (c) => process.stderr.write('[sidecar] ' + c));
function call(method, params = null) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
  });
}
function svc(method, args = []) { return call('service.call', { serviceId: 'bili.explore', method, params: { args } }); }

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok, detail }); console.log((ok?'PASS':'FAIL') + ' ' + name + (detail?' :: '+detail:'')); }

try {
  const hello = await call('host.hello');
  check('handshake', hello?.pack === 'com.akisaki.bili.explore', JSON.stringify(hello));

  const login = await svc('loginStatus');
  check('loginStatus', typeof login.loggedIn === 'boolean', JSON.stringify(login));

  const hot = await svc('popular', [{ count: 3 }]);
  check('popular', Array.isArray(hot) && hot.length > 0 && !!hot[0].bvid, hot.length + ' videos');

  const clean = await svc('scrubObservation', [{ topic: 'AI 如何改变生活', myTakeaway: '挺有意思', category: '科技' }]);
  check('scrub clean', clean.ok === true && !clean.text.includes('UP主'), clean.text || clean.reason);

  const dirty = await svc('scrubObservation', [{ topic: '@张三 UP主李四讲了AI', myTakeaway: '我叫王五 QQ 123456' }]);
  check('scrub rejects personal info', dirty.ok === false, JSON.stringify(dirty));

  const safe = await svc('isSafeBiliMemory', ['我今天刷到一个讲AI的视频，觉得挺有意思。']);
  check('safe memory check', safe.safe === true, JSON.stringify(safe));

  // 假名/昵称拦截：不在任何名单里的人称也必须挡住
  const alias1 = await svc('isSafeBiliMemory', ['小樱今天发了个动态']);
  check('alias 小X blocked', alias1.safe === false, JSON.stringify(alias1));
  const alias2 = await svc('isSafeBiliMemory', ['阿明说他喜欢这个视频']);
  check('alias 阿X blocked', alias2.safe === false, JSON.stringify(alias2));
  const socialName = await svc('isSafeBiliMemory', [{ text: '张三今天刷到一个视频', knownPersons: ['张三'] }]);
  check('known person blocked', socialName.safe === false, JSON.stringify(socialName));

  const noDm = await svc('isRelevantComment', [{ comment: '加我微信私聊', topic: 'AI 视频' }]);
  check('comment rejects DM', noDm.relevant === false, JSON.stringify(noDm));

  const relevant = await svc('isRelevantComment', [{ comment: '这个AI讲得挺有意思', topic: 'AI 科技' }]);
  check('comment relevant', relevant.relevant === true, JSON.stringify(relevant));
} catch (e) {
  check('exception', false, e.stack || e.message);
} finally {
  await call('host.dispose').catch(() => {});
  proc.kill();
}
const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
