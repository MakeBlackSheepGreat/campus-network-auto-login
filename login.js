#!/usr/bin/env node
// 路由器版校园网自动登录（方案B）
// 流程: headless Chromium(CDP) 打开门户 → 瑞数WAF握手 → 渲染登录表单
//       → 截图验证码 → tesseract OCR → 填表提交 → 校验结果
// 用法:
//   node login.js <wlanuserip>          # 完整登录
//   node login.js <wlanuserip> --dry    # 只测 导航+验证码+OCR，不提交
const WebSocket = require('ws');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

// ===== 示例配置：使用前请替换为实际值 =====
const ACCOUNT = 'SCXY****************'; // 校园网账号（按学校要求带前缀，如 SCXY+手机号）
const PASS = '****************';        // 密码（通常为手机号后六位，按学校实际）
const BASE = 'http://218.200.239.185:8888'; // 校园网 Portal 地址（运营商公开地址，按学校实际）
const PORTAL_PAGE = '/portalserver/scunioncmccgxsd29.jsp'; // 具体门户页面按学校实际
const CDP_PORT = 9222;
const CHROME = '/opt/alpine/usr/lib/chromium/chrome';
const PROFILE = '/tmp/chromeprof';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LD_LIB = '/opt/alpine/usr/lib:/opt/alpine/lib:/opt/alpine/usr/lib/pulseaudio';
const MAX_TRY = 4;
const GLOBAL_TIMEOUT = 190000;

const wlanip = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!wlanip) { console.log('FAIL 缺少 wlanuserip 参数'); process.exit(1); }

// 互斥锁：防止并发实例争抢 CDP
const LOCK = '/tmp/campus_login.lock';
if (fs.existsSync(LOCK)) {
  try { process.kill(parseInt(fs.readFileSync(LOCK, 'utf8'), 10), 0); console.log('SKIP 已有登录实例'); process.exit(0); }
  catch (e) { fs.unlinkSync(LOCK); }
}
fs.writeFileSync(LOCK, String(process.pid));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// 同步 stdout，避免管道缓冲导致日志丢失
if (process.stdout._handle) { try { process.stdout._handle.setBlocking(true); } catch (e) {} }
function slog(...args) {
  const line = args.join(' ') + '\n';
  try { fs.appendFileSync('/tmp/login.log', line); } catch (e) {}
  process.stdout.write(line);
}
function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('json parse fail: ' + d.slice(0, 120))); } });
    }).on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('http timeout')); });
  });
}

// ===== 内存释放/恢复（登录前释放高占用服务的内存，请按实际环境配置） =====
// 内存紧张时 Chromium 无法启动，登录前暂停非必要的常驻服务（如代理类软件）
// 以腾出内存，登录完成后恢复。服务名按实际环境填写，示例默认为空。
const MEM_SERVICES = []; // 示例：[ 'service_a', 'service_b' ] 等 OpenWrt init 服务名

function sh(cmd, timeoutMs) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', cmd], { timeout: timeoutMs || 30000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, out: ((stdout || '') + (stderr || '')).trim() }));
  });
}

// 登录前：暂停 MEM_SERVICES 里的服务 + 释放 page cache，腾出物理内存
async function freeMem() {
  slog('释放内存：暂停高占用服务...');
  let cmd = 'for w in $(pgrep -f watchdog); do kill -9 $w 2>/dev/null; done; ';
  for (const svc of MEM_SERVICES) {
    cmd += `if [ -x /etc/init.d/${svc} ]; then /etc/init.d/${svc} stop >/dev/null 2>&1 & SPID=$!; sleep 15; kill -9 $SPID 2>/dev/null; fi; `;
  }
  cmd += 'sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null; echo done';
  const r = await sh(cmd, 40000);
  slog('  freeMem:', r.out);
  await sleep(1000);
}

// 登录结束：恢复被暂停的服务（后台触发，不阻塞退出）
function restoreServices() {
  for (const svc of MEM_SERVICES) {
    try {
      const cp = spawn('/bin/sh', ['-c', `/etc/init.d/${svc} start >/dev/null 2>&1 &`], { detached: true, stdio: 'ignore' });
      cp.unref();
    } catch (e) {}
  }
  slog('已触发服务恢复');
}

// ---------- CDP 客户端 ----------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.onEvent = null; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      if (msg.id && c.pending.has(msg.id)) { c.pending.get(msg.id)(msg); c.pending.delete(msg.id); }
      else if (c.onEvent) c.onEvent(msg);
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }, 8000);
      this.pending.set(id, (msg) => { clearTimeout(t); msg.error ? reject(new Error(method + ' ERR: ' + JSON.stringify(msg.error).slice(0, 200))) : resolve(msg.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception;
      throw new Error('页面JS异常: ' + ((d && d.description) || JSON.stringify(r.exceptionDetails)).slice(0, 300));
    }
    return r.result.value;
  }
}

// ---------- 启动/获取 Chrome ----------
async function ensureChrome() {
  try { await httpGetJson('/json/version'); return; } catch (e) {}
  console.log('启动 headless Chromium...');
  // single-process: 单进程模式，大幅降低内存占用（低内存设备关键）
  const args = ['--headless=new', '--single-process', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-software-rasterizer', '--disable-crash-reporter', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--metrics-recording-only',
    '--js-flags=--max-old-space-size=128', '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + CDP_PORT, '--window-size=1280,720', '--user-agent=' + UA, 'about:blank'];
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { LD_LIBRARY_PATH: LD_LIB }) });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try { await httpGetJson('/json/version'); console.log('CDP 就绪'); return; } catch (e) {}
  }
  throw new Error('Chrome CDP 启动超时');
}

async function getPageWs() {
  const list = await httpGetJson('/json/list');
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('无页面目标');
  return page.webSocketDebuggerUrl;
}

// ---------- OCR ----------
function ocr(psm, chars) {
  return new Promise((resolve) => {
    execFile('/usr/bin/tesseract', ['/tmp/captcha.png', 'stdout', '-l', 'eng', '--psm', psm,
      '-c', 'tessedit_char_whitelist=' + chars],
      { timeout: 20000, maxBuffer: 2 * 1024 * 1024, env: Object.assign({}, process.env, { TESSDATA_PREFIX: '/usr/share/tessdata' }) },
      (err, stdout, stderr) => {
        if (err) console.log('  tesseract err:', (stderr || '').trim().split('\n')[0]);
        const s = (stdout || '').replace(/[^a-zA-Z0-9]/g, '');
        resolve(s);
      });
  });
}

const CHARS_NUM = '0123456789';
const CHARS_MIX = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 多 psm 投票：出现次数最多者胜，平局取靠前（psm7 通常最准）
function vote(results) {
  const counts = {};
  for (const r of results) counts[r] = (counts[r] || 0) + 1;
  let best = results[0] || null, bestC = 0;
  for (const k in counts) if (counts[k] > bestC) { bestC = counts[k]; best = k; }
  return best;
}

// 抓验证码: 直接用页面 img 元素绘制（不 fetch，避免触发服务器刷新验证码）
async function grabCaptcha(cdp) {
  const out = await cdp.eval(`(async () => {
    const img = document.getElementById('randomimage');
    if (!img || !img.complete || !img.naturalWidth) return null;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = 6;
    const c = document.createElement('canvas');
    c.width = w * scale; c.height = h * scale;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    // 保存原始放大图（调试用）：返回给 Node 端写文件
    const origB64 = c.toDataURL('image/png').split(',')[1];
    // 灰度 + 二值化 + 中值滤波/去噪（去噪点、不膨胀避免 5→8）
    try {
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const px = id.data;
      const w = c.width, h = c.height;
      const n = w * h;
      const gray = new Float32Array(n);
      let sum = 0;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const g = 0.3 * px[j] + 0.6 * px[j + 1] + 0.1 * px[j + 2];
        gray[i] = g; sum += g;
      }
      const avg = sum / n;
      const th = avg * 0.88; // 偏暗阈值：深色字符 → 黑
      const bin = new Uint8Array(n); // 1=黑
      for (let i = 0; i < n; i++) bin[i] = gray[i] < th ? 1 : 0;
      // 3x3 邻域去噪：孤立黑点（黑邻居≤2）置白；不膨胀（避免 5 的开口被填成 8）
      const out = new Uint8Array(bin);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!bin[y * w + x]) continue;
          let black = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              black += bin[(y + dy) * w + (x + dx)];
            }
          }
          if (black <= 2) out[y * w + x] = 0; // 孤立噪点
        }
      }
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = out[i] ? 0 : 255;
        px[j] = px[j + 1] = px[j + 2] = v;
      }
      ctx.putImageData(id, 0, 0);
    } catch (e) {}
    return { orig: origB64, proc: c.toDataURL('image/png').split(',')[1] };
  })()`);
  if (!out) return 'fail';
  fs.writeFileSync('/tmp/captcha_orig.png', Buffer.from(out.orig, 'base64'));
  fs.writeFileSync('/tmp/captcha.png', Buffer.from(out.proc, 'base64'));
  return 'canvas';
}

async function captchaToCode(cdp) {
  const how = await grabCaptcha(cdp);
  const size = fs.statSync('/tmp/captcha.png').size;
  console.log('验证码图:', how, size, 'bytes');
  // 数字优先：运营商验证码多为纯数字，纯数字集对 1/l、0/O 更稳
  const num = [];
  for (const psm of ['7', '8', '13']) {
    console.log('  OCR num psm' + psm + ' 开始...');
    const s = await ocr(psm, CHARS_NUM);
    console.log('  num psm' + psm + ' ->', JSON.stringify(s));
    if (s && s.length >= 4) num.push(s.slice(0, 4));
  }
  const vNum = vote(num);
  if (vNum && vNum.length === 4) { console.log('采用纯数字识别:', vNum); return vNum; }
  // 回退：字母+数字混合
  const mix = [];
  for (const psm of ['7', '8', '13']) {
    console.log('  OCR mix psm' + psm + ' 开始...');
    const s = await ocr(psm, CHARS_MIX);
    console.log('  mix psm' + psm + ' ->', JSON.stringify(s));
    if (s && s.length >= 4) mix.push(s.slice(0, 4));
  }
  const vMix = vote(mix);
  console.log('采用混合识别:', vMix || vNum);
  return vMix || vNum || null;
}

// ---------- 页面流程 ----------
async function waitEval(cdp, expr, tries = 40, gap = 500) {
  for (let i = 0; i < tries; i++) {
    try { if (await cdp.eval(expr)) return true; } catch (e) {}
    await sleep(gap);
  }
  return false;
}

async function main() {
  // 全局超时保护：避免内存压力下无限挂起
  const guard = setTimeout(() => { console.log('GLOBAL_TIMEOUT_' + GLOBAL_TIMEOUT / 1000 + 's'); finish(9); }, GLOBAL_TIMEOUT);
  await freeMem(); // 释放内存，否则低内存下 Chromium 无法启动
  await ensureChrome();
  const cdp = await Cdp.connect(await getPageWs());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.onEvent = (msg) => {
    if (msg.method === 'Page.javascriptDialogOpening') {
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  };

  const portalUrl = BASE + PORTAL_PAGE + '?wlanuserip=' + wlanip + '&wlanacname=';
  console.log('打开门户:', portalUrl);
  await cdp.send('Page.navigate', { url: portalUrl });

  // 等 frameset 里的 unionautologin iframe
  let iframeUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const src = await cdp.eval(`(() => { const f = document.querySelector('frame'); return f ? f.src : null; })()`);
      if (src && src.indexOf('unionautologin') >= 0) { iframeUrl = src; break; }
    } catch (e) {}
  }
  if (!iframeUrl) throw new Error('获取登录 iframe 失败（瑞数WAF可能未通过）');
  console.log('登录iframe:', iframeUrl);

  await cdp.send('Page.navigate', { url: iframeUrl });
  if (!(await waitEval(cdp, `!!document.getElementById('randomimage')`))) throw new Error('登录表单未渲染');

  const reloadForm = async () => {
    await sleep(500);
    await cdp.send('Page.navigate', { url: iframeUrl });
    await waitEval(cdp, `!!document.getElementById('randomimage')`);
  };

  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    console.log('--- 第', attempt, '次尝试 ---');
    const code = await captchaToCode(cdp);
    if (!code) { console.log('OCR 未识别出4位，刷新验证码重试'); await reloadForm(); continue; }
    console.log('识别验证码:', code);
    if (DRY) { console.log('DRY 模式，不提交'); return 0; }

    const filled = await cdp.eval(`(() => {
      const u = document.getElementById('username'); if (u) u.value = ${JSON.stringify(ACCOUNT)};
      // 两个密码字段都要填：passwordIn_1(name=password) 是服务器读取的主字段
      const p1 = document.getElementById('passwordIn_1'); if (p1) p1.value = ${JSON.stringify(PASS)};
      const p2 = document.getElementById('pwd'); if (p2) p2.value = ${JSON.stringify(PASS)};
      const s = document.getElementById('ps'); if (s) s.value = ${JSON.stringify(code)};
      const f = document.getElementById('inputForm'); if (f) { f.submit(); return 'submitted'; }
      return 'noform';
    })()`);
    console.log('提交:', filled);

    // 等结果
    let outcome = 'timeout';
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const txt = await cdp.eval(`(function(){ const f = document.querySelector('frame'); let s = ''; try { if (f && f.contentDocument && f.contentDocument.body) s = f.contentDocument.body.innerText; } catch(e) {} s += document.body ? document.body.innerText : ''; s += '|TITLE:' + document.title; return s; })()`);
        const t2 = txt.replace(/\s+/g, '');
        slog('  resp[' + i + ']:', t2.slice(0, 200));
        if (/尊敬的用户|已经在线|注销|登录成功|在线.*\d{2}:\d{2}/.test(t2)) { outcome = 'ok'; break; }
        if (/验证码错误|验证码不正确|验证码.*错误|验证码输入/.test(t2)) { outcome = 'captcha'; break; }
        if (/密码错误|密码不正确|密码不对|账号.*错误|用户名.*错误/.test(t2)) { outcome = 'fail'; break; }
        // 登录失败页：frame 详细文本加载较慢（约2s），等若干轮再判定为账号/密码错误
        if (/登录失败/.test(t2) && i >= 10) { outcome = 'fail'; break; }
      } catch (e) { slog('  eval异常:', e.message); }
    }
    console.log('结果:', outcome);
    if (outcome === 'ok') { console.log('LOGIN_OK'); return 0; }
    if (outcome === 'fail') { console.log('LOGIN_FAIL 账号或密码错误'); return 3; }
    await reloadForm();
  }
  console.log('LOGIN_FAIL 尝试次数用尽');
  return 2;
}

// 所有路径显式退出：CDP WebSocket 保持打开会导致事件循环不结束、进程挂起
// 同时清理 Chromium 与互斥锁，避免内存紧张的 OpenWrt 常驻浏览器进程
function finish(code) {
  try { fs.unlinkSync(LOCK); } catch (e) {}
  restoreServices(); // 恢复被暂停的服务
  try { execFile('killall', ['-9', 'chromium'], () => { process.exit(code); }); } catch (e) {}
  setTimeout(() => process.exit(code), 3000);
}
main().then(finish)
      .catch((e) => { console.log('LOGIN_FAIL', e.message); finish(1); });
