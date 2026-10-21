// 端到端真实交互：键盘改字、file input 真上传、下载点击
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 9236;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const pageUrl = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
const profile = path.join(process.env.TEMP || '/tmp', 'e2e-' + Date.now());

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1000', pageUrl], { stdio: 'ignore' });

(async () => {
  let ws;
  for (let i = 0; i < 60; i++) {
    try { const p = await requestJson(`http://127.0.0.1:${PORT}/json`); const t = p.find(x => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch (e) {}
    await wait(250);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const errs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await wait(2400);

  const out = {};

  // 1. 选产品
  out.setup = await evalJs(`(async()=>{
    const $=id=>document.getElementById(id); const s=ms=>new Promise(r=>setTimeout(r,ms));
    location.hash='#/promotion'; await s(400);
    $('promotionProductQuery').value='MateBook D 16 SE';
    $('promotionProductQuery').dispatchEvent(new Event('input',{bubbles:true}));
    await s(700);
    const c=document.querySelector('#promotionProductCandidates button'); if(c)c.click();
    await s(600);
    return { product: promotion.product?.name, main: $('promotionCoverMain').value };
  })()`);

  // 2. 真实键盘输入到图内文字（不是直接改 textContent）
  out.keyboardEdit = await evalJs(`(async()=>{
    const s=ms=>new Promise(r=>setTimeout(r,ms));
    const el=document.getElementById('promotionPosterStage').querySelector('[data-field="main"]');
    el.focus();
    const sel=window.getSelection(); const r=document.createRange();
    r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
    await s(120);
    return { focused: document.activeElement===el, selectedText: sel.toString().slice(0,12) };
  })()`);

  // 用 Input.insertText 模拟真实输入
  await send('Input.insertText', { text: '这一台先看三点就够' });
  await wait(350);
  out.afterType = await evalJs(`(()=>{
    const $=id=>document.getElementById(id);
    return {
      form: $('promotionCoverMain').value,
      dom: document.getElementById('promotionPosterStage').querySelector('[data-field="main"]').textContent.trim(),
      downloadDisabled: $('promotionCoverDownload').disabled
    };
  })()`);

  // 3. 真实 file input 上传（DOM.setFileInputFiles）
  const pngPath = path.resolve('tests/fixtures/sample-photo.png');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#promotionCoverPhoto' });
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [pngPath] });
  await wait(1400);
  out.upload = await evalJs(`(async()=>{
    const s=ms=>new Promise(r=>setTimeout(r,ms));
    setPosterTemplate('split', true);
    await s(500);
    const img=document.getElementById('promotionPosterStage').querySelector('.poster-photo');
    return {
      status: document.getElementById('promotionCoverPhotoStatus').textContent.slice(0,44),
      photoUrlSet: !!coverState.photoUrl,
      hasImg: !!img,
      imgLoaded: img?img.naturalWidth>0:false,
      imgSize: img?img.naturalWidth+'x'+img.naturalHeight:''
    };
  })()`);

  // 4. 生成 + 真实触发下载按钮
  out.download = await evalJs(`(async()=>{
    const $=id=>document.getElementById(id); const s=ms=>new Promise(r=>setTimeout(r,ms));
    $('promotionCoverMain').value='16寸大屏，表格不缩行';
    renderPoster(); await s(200);
    await generatePoster(); await s(900);
    const btn=$('promotionCoverDownload');
    const before={disabled:btn.disabled, href:!!$('promotionCoverSaveLink').href};
    let clicked=false;
    btn.click(); await s(200);
    clicked=true;
    return {
      before, clicked,
      status:$('promotionCoverStatus').textContent.slice(0,50),
      linksShown:!$('promotionCoverLinks').hidden
    };
  })()`);

  // 5. 刷新后状态不残留（localStorage 里不该存图片）
  out.storage = await evalJs(`(()=>{
    const keys=Object.keys(localStorage);
    const blobish=keys.filter(k=>/blob:|data:image/.test(localStorage.getItem(k)||''));
    return { keyCount:keys.length, blobishKeys:blobish };
  })()`);

  out.runtimeErrors = errs;
  console.log(JSON.stringify(out, null, 2));

  const fail = [];
  if (!out.keyboardEdit.focused) fail.push('图内文字无法聚焦');
  if (out.afterType.form !== '这一台先看三点就够') fail.push('键盘输入未写回表单：' + out.afterType.form);
  if (!out.upload.photoUrlSet || !out.upload.imgLoaded) fail.push('真实上传未生效');
  if (out.download.before.disabled !== false) fail.push('生成后按钮仍禁用');
  if (out.storage.blobishKeys.length) fail.push('图片被写入 localStorage');
  if (errs.length) fail.push('有运行时异常');
  ws.close(); child.kill();
  if (fail.length) { console.error('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log('\nALL PASS');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
