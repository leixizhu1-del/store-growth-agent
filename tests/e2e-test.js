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
const downloadDir = path.resolve('outputs/e2e-download');
fs.mkdirSync(downloadDir, { recursive: true });

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
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
  await wait(2400);

  const out = {};

  // 1. 进反馈与交接页，准备一份可归档的执行记录
  out.setup = await evalJs(`(async()=>{
    const $=id=>document.getElementById(id); const s=ms=>new Promise(r=>setTimeout(r,ms));
    location.hash='#/plan-feedback'; await s(600);
    $('handoffOwner').value='晚班 李四';
    $('cardNeed').value='经常出差，重视轻薄与屏幕';
    return {
      panels:[...document.querySelectorAll('[data-page="plan-feedback"] > .panel h3')].map(h=>h.textContent),
      hasCard:!!$('cardPreview'),
      cardRendered:!!$('cardPreview').firstElementChild
    };
  })()`);

  // 2. 真实键盘输入到执行记录（Input.insertText，而不是直接赋值）
  const focusOk = await evalJs(`(()=>{
    const el=document.getElementById('planOutcome');
    el.focus();
    const sel=window.getSelection(); const r=document.createRange();
    r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
    return document.activeElement===el;
  })()`);
  await send('Input.insertText', { text: '客户认可轻薄，价格还差约 800，约周六到店再试一次。' });
  await wait(300);
  out.keyboardEdit = { focused: focusOk, value: await evalJs(`document.getElementById('planOutcome').value`) };

  // 3. 真实点击「保存并归档」
  await evalJs(`document.getElementById('saveOutcomeBtn').click()`);
  await wait(400);
  out.archive = await evalJs(`(()=>({
    status:document.getElementById('outcomeStatus').textContent.slice(0,50),
    savedAt:document.getElementById('outcomeSavedAt').textContent,
    archiveHasOwner:document.getElementById('handoffArchive').textContent.includes('晚班 李四'),
    archiveHasNote:document.getElementById('handoffArchive').textContent.includes('价格还差约 800'),
    persisted:!!localStorage.getItem('pc-agent-handoff')
  }))()`);

  // 4. 刷新后归档仍在（跨会话交接能力）
  await send('Page.reload'); await wait(1600);
  out.afterReload = await evalJs(`(async()=>{
    const s=ms=>new Promise(r=>setTimeout(r,ms));
    location.hash='#/plan-feedback'; await s(700);
    return {
      note:document.getElementById('planOutcome').value.slice(0,20),
      owner:document.getElementById('handoffOwner').value,
      archive:document.getElementById('handoffArchive').textContent.slice(0,40),
      savedAt:document.getElementById('outcomeSavedAt').textContent
    };
  })()`);

  // 5. 真实 file input 上传产品照片（门店推广页）
  const pngPath = path.resolve('tests/fixtures/sample-photo.png');
  await evalJs(`location.hash='#/promotion'`); await wait(700);
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#promotionCoverPhoto' });
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [pngPath] });
  await wait(1200);
  out.upload = await evalJs(`(()=>({
    status:document.getElementById('promotionCoverPhotoStatus').textContent.slice(0,40),
    previewShown:!document.getElementById('promotionCoverPhotoPreview').hidden,
    imgLoaded:(()=>{const i=document.querySelector('#promotionCoverPhotoPreview img');return i?i.naturalWidth>0:false;})()
  }))()`);

  // 6. 真实点击下载 SVG / PNG
  await evalJs(`location.hash='#/plan-feedback'`); await wait(700);
  const before = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir).length : 0;
  await evalJs(`document.getElementById('downloadSvgBtn').click()`);
  await wait(1500);
  await evalJs(`document.getElementById('downloadPngBtn').click()`);
  await wait(2000);
  const files = fs.readdirSync(downloadDir).filter(f => /\.(svg|png)$/i.test(f));
  out.download = {
    files,
    grew: files.length > 0 && fs.readdirSync(downloadDir).length >= before,
    status: await evalJs(`document.getElementById('exportStatus').textContent.slice(0,44)`),
    links: await evalJs(`document.querySelectorAll('#exportLinks a').length`),
    svgHasProduct: files.some(f => /\.svg$/i.test(f)) ? fs.readFileSync(path.join(downloadDir, files.find(f => /\.svg$/i.test(f))), 'utf8').includes('<svg') : false
  };

  // 7. localStorage 不应存图片二进制
  out.storage = await evalJs(`(()=>{
    const keys=Object.keys(localStorage);
    return { keyCount:keys.length, blobishKeys:keys.filter(k=>/blob:|data:image/.test(localStorage.getItem(k)||'')) };
  })()`);

  // 8. 情境题库折叠与筛选
  await evalJs(`location.hash='#/consult'`); await wait(600);
  out.scenario = await evalJs(`(async()=>{
    const s=ms=>new Promise(r=>setTimeout(r,ms));
    const box=document.getElementById('scenarioBankBox');
    const closed=!box.open;
    box.open=true; await s(120);
    const all=document.querySelectorAll('.scenario-item').length;
    const chip=[...document.querySelectorAll('.scenario-chip')].find(c=>c.dataset.scenario==='compat');
    chip.click(); await s(150);
    return {closedByDefault:closed, total:all, compat:document.querySelectorAll('.scenario-item').length, active:document.querySelector('.scenario-chip.is-active').dataset.scenario};
  })()`);

  out.runtimeErrors = errs;
  console.log(JSON.stringify(out, null, 2));

  const fail = [];
  if (out.keyboardEdit.focused !== true) fail.push('执行记录无法聚焦');
  if (!out.keyboardEdit.value.includes('价格还差约 800')) fail.push('键盘输入未写入：' + out.keyboardEdit.value.slice(0, 30));
  if (!out.archive.persisted || !out.archive.archiveHasOwner) fail.push('归档未生效');
  if (!out.afterReload.note.includes('价格还差约')) fail.push('刷新后记录丢失：' + out.afterReload.note);
  if (!out.upload.previewShown || !out.upload.imgLoaded) fail.push('真实上传未生效');
  if (!out.download.files.length) fail.push('下载未产生文件');
  if (!out.download.svgHasProduct) fail.push('下载的 SVG 内容异常');
  if (out.storage.blobishKeys.length) fail.push('图片被写入 localStorage');
  if (!out.scenario.closedByDefault) fail.push('题库默认未折叠');
  if (out.scenario.compat >= out.scenario.total) fail.push('题库分类筛选无效');
  if (errs.length) fail.push('有运行时异常：' + errs[0].slice(0, 80));
  ws.close(); child.kill();
  if (fail.length) { console.error('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log('\nALL PASS');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
