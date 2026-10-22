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

  // 1. 先前置一份客户画像：新版没画像时「反馈与交接」会被守卫挡住，这是设计如此
  out.personaSetup = await evalJs(`(async()=>{
    const $=id=>document.getElementById(id); const s=ms=>new Promise(r=>setTimeout(r,ms));
    location.hash='#/persona'; await s(300);
    $('scene').value='客户经常出差，需要轻薄、屏幕好、手机电脑协同，预算 7000 元左右';
    $('runBtn').click(); await s(200);
    $('savePersonaBtn').click(); await s(200);
    return {ready:personaReady(),role:state.persona?.role||'',need:state.persona?.need||''};
  })()`);

  // 2. 进反馈与交接页，准备一份可归档的执行记录
  out.setup = await evalJs(`(async()=>{
    const $=id=>document.getElementById(id); const s=ms=>new Promise(r=>setTimeout(r,ms));
    location.hash='#/plan-feedback'; await s(600);
    $('handoffOwner').value='晚班 李四';
    return {
      panels:[...document.querySelectorAll('[data-page="plan-feedback"] > .panel h3, [data-page="plan-feedback"] #feedbackBody > .panel h3')].map(h=>h.textContent),
      guardHidden:$('feedbackGuard').hidden,
      bodyShown:!$('feedbackBody').hidden,
      hasCard:!!$('cardPreview'),
      cardRendered:!!$('cardPreview').firstElementChild,
      hasNeedInput:!!$('cardNeed')
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

  // 3. 真实点击「保存并归档」，应追加一条工作留档而不是覆盖
  await evalJs(`document.getElementById('saveOutcomeBtn').click()`);
  await wait(400);
  out.archive = await evalJs(`(()=>({
    status:document.getElementById('outcomeStatus').textContent.slice(0,60),
    savedAt:document.getElementById('outcomeSavedAt').textContent,
    count:state.workLogs.length,
    logHasOwner:document.getElementById('workLog').textContent.includes('晚班 李四'),
    logHasNote:document.getElementById('workLog').textContent.includes('价格还差约 800'),
    logHasPersona:document.getElementById('workLog').textContent.includes('客户是谁'),
    logCountLabel:document.getElementById('workLogCount').textContent,
    persisted:!!localStorage.getItem('pc-agent-worklogs')
  }))()`);

  // 3.1 再存第二条：前一条必须还在（追加不覆盖是这页的核心要求）
  await evalJs(`(()=>{
    document.getElementById('planOutcome').value='第二位客户，先看 5000 出头的机型，下周再联系。';
    document.getElementById('handoffOwner').value='白班 王五';
    document.getElementById('saveOutcomeBtn').click();
  })()`);
  await wait(400);
  out.appendSecond = await evalJs(`(()=>({
    count:state.workLogs.length,
    ownerInStorage:JSON.parse(localStorage.getItem('pc-agent-worklogs')||'[]').map(r=>r.owner),
    firstStillThere:document.getElementById('workLog').textContent.includes('晚班 李四'),
    secondThere:document.getElementById('workLog').textContent.includes('白班 王五')
  }))()`);

  // 4. 刷新后留档仍在（跨会话交接能力），且是两条
  await send('Page.reload'); await wait(1600);
  out.afterReload = await evalJs(`(async()=>{
    const s=ms=>new Promise(r=>setTimeout(r,ms));
    location.hash='#/plan-feedback'; await s(700);
    return {
      note:document.getElementById('planOutcome').value.slice(0,20),
      owner:document.getElementById('handoffOwner').value,
      count:state.workLogs.length,
      logText:document.getElementById('workLog').textContent.slice(0,60),
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

  // 9. 组合折扣行：不到 2 件必须隐藏，到 2 件才出现
  out.discountVisibility = await evalJs(`(async()=>{
    const s=ms=>new Promise(r=>setTimeout(r,ms));
    location.hash='#/quote'; await s(400);
    state.quoteItems=[];state.discount={type:'none',value:0,approved:false,approvalNote:'',until:'',gift:''};renderQuoteItems();
    const empty=document.getElementById('discountBlock').hidden;
    state.quoteItems=[createQuoteItem(knowledgeBase.products[0])];renderQuoteItems();
    const one=document.getElementById('discountBlock').hidden;
    state.quoteItems=[createQuoteItem(knowledgeBase.products[0]),createQuoteItem(knowledgeBase.products[1])];renderQuoteItems();
    const two=document.getElementById('discountBlock').hidden;
    state.quoteItems=[createQuoteItem(knowledgeBase.products[0])];renderQuoteItems();
    const backToOne=document.getElementById('discountBlock').hidden;
    return {empty,one,two,backToOne};
  })()`);

  out.runtimeErrors = errs;
  console.log(JSON.stringify(out, null, 2));

  const fail = [];
  if (!out.personaSetup.ready) fail.push('客户画像未能通过左侧输入栏生成');
  if (!out.setup.guardHidden || !out.setup.bodyShown) fail.push('有画像时守卫没让开');
  if (out.setup.hasNeedInput) fail.push('客户需求摘要输入框应已删除');
  if (!out.keyboardEdit.focused) fail.push('执行记录无法聚焦');
  if (!out.keyboardEdit.value.includes('价格还差约 800')) fail.push('键盘输入未写入：' + out.keyboardEdit.value.slice(0, 30));
  if (!out.archive.persisted || !out.archive.logHasOwner) fail.push('留档未生效');
  if (!out.archive.logHasNote) fail.push('留档里没有执行记录原话');
  if (!out.archive.logHasPersona) fail.push('留档里缺少人群画像段');
  if (out.archive.count !== 1) fail.push('第一条留档数量异常：' + out.archive.count);
  if (out.appendSecond.count !== 2) fail.push('第二次保存没有追加成第二条：' + out.appendSecond.count);
  if (!out.appendSecond.firstStillThere) fail.push('第二次保存把前一条覆盖掉了');
  if (!out.appendSecond.secondThere) fail.push('第二条留档没出现在列表里');
  if (out.afterReload.count !== 2) fail.push('刷新后留档丢失：' + out.afterReload.count);
  if (!out.upload.previewShown || !out.upload.imgLoaded) fail.push('真实上传未生效');
  if (!out.download.files.length) fail.push('下载未产生文件');
  if (!out.download.svgHasProduct) fail.push('下载的 SVG 内容异常');
  if (out.storage.blobishKeys.length) fail.push('图片被写入 localStorage');
  if (!out.scenario.closedByDefault) fail.push('题库默认未折叠');
  if (out.scenario.compat >= out.scenario.total) fail.push('题库分类筛选无效');
  if (out.scenario.total < 30) fail.push('情境题库条数偏少：' + out.scenario.total);
  if (!out.discountVisibility.empty || !out.discountVisibility.one) fail.push('不到 2 件时组合折扣行应隐藏');
  if (out.discountVisibility.two) fail.push('加到 2 件时组合折扣行没出现');
  if (!out.discountVisibility.backToOne) fail.push('退回单件后组合折扣行没重新隐藏');
  if (errs.length) fail.push('有运行时异常：' + errs[0].slice(0, 80));
  ws.close(); child.kill();
  if (fail.length) { console.error('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log('\nALL PASS');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
