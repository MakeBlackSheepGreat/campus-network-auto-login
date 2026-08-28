// 临时测试：login.js 中 execFile 调用 tesseract 是否会挂起
const { execFile } = require('child_process');
const fs = require('fs');
const img = process.argv[2] || '/tmp/captcha.png';
console.log('测试图:', img, fs.existsSync(img) ? fs.statSync(img).size + ' bytes' : '不存在');
execFile('/usr/bin/tesseract',
  [img, 'stdout', '-l', 'eng', '--psm', '7', '-c', 'tessedit_char_whitelist=0123456789'],
  { timeout: 20000, maxBuffer: 2 * 1024 * 1024, env: Object.assign({}, process.env, { TESSDATA_PREFIX: '/usr/share/tessdata' }) },
  (err, out, se) => {
    console.log('CB err=', err && err.message, '| out=', JSON.stringify(out), '| stderr=', (se || '').slice(0, 120));
    process.exit(0);
  });
setTimeout(() => { console.log('NO_CB_20S 超时无回调'); process.exit(1); }, 20000);
