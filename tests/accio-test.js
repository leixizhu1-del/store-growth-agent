/* Accio 精修海报交接专项测试
 * 覆盖：型号下拉填充、亮点留空自动补充、提示词内容约束、深链格式、按钮状态、与产品选择双向同步
 * 用法：node tests/accio-test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9247;
const pageUrl = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
const profile = path.resolve('outputs/edge-accio-profile');
fs.mkdirSync('outputs', { recursive: true });

const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, pageUrl], { stdio: 'ignore' });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await requestJson(`http://127.0.0.1:${PORT}/json`);
      const t = pages.find(p => p.type === 'page');
      if (t) return new WebSocket(t.webSocketDebuggerUrl);
    } catch (e) {}
    await wait(250);
  }
  throw new Error('CDP unavailable');
}

(async () => {
  const ws = await connect();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const runtimeErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      runtimeErrors.push(d.text + ' ' + (d.exception?.description || ''));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable'); await send('Page.enable');
  await wait(2200);

  const out = await evalJs(`(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const log = {};
    location.hash = '#/promotion';
    await sleep(450);

    /* ---- 1. 下拉是否填充了全部产品 ---- */
    const opts = [...$('accioModel').querySelectorAll('option')].filter(o => o.value);
    log.modelOptions = { count: opts.length, first: opts[0]?.value, last: opts[opts.length-1]?.value, kbCount: knowledgeBase.products.length };
    log.groupCount = $('accioModel').querySelectorAll('optgroup').length;
    log.blankOption = [...$('accioModel').options].some(o => o.value === '');

    /* ---- 2. 未选型号时生成提示词应被拦下 ---- */
    $('accioModel').value = '';
    $('accioMakePrompt').click();
    await sleep(120);
    log.guardEmptyModel = {
      status: $('accioStatus').textContent.slice(0, 30),
      promptLength: $('accioPrompt').value.length,
      copyDisabled: $('accioCopyPrompt').disabled
    };

    /* ---- 3. 选型号：亮点留空，应自动补充 ---- */
    const target = opts.find(o => /MateBook D 16 SE/.test(o.value)) || opts[0];
    $('accioModel').value = target.value;
    $('accioModel').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(600);
    log.afterModelSelect = {
      promotionProduct: promotion.product?.name || null,
      modelHint: $('accioModelHint').textContent.slice(0, 50),
      mainDefault: $('promotionCoverMain').value
    };

    $('accioHighlight').value = '';
    $('accioMakePrompt').click();
    await sleep(200);
    const autoPrompt = $('accioPrompt').value;
    log.autoHighlight = {
      length: autoPrompt.length,
      hint: $('accioHighlightHint').textContent.slice(0, 60),
      hasAuto: /重点覆盖|主打方向/.test(autoPrompt),
      hasProduct: autoPrompt.includes(target.value),
      hasSize: autoPrompt.includes('1080 × 1440'),
      hasPlatform: autoPrompt.includes('小红书'),
      forbidPrice: /不要出现价格、折扣、库存/.test(autoPrompt),
      noPlaceholder: !/undefined|NaN|\\[object Object\\]/.test(autoPrompt),
      buttonsEnabled: !$('accioCopyPrompt').disabled && !$('accioOpen').disabled,
      boxOpen: !$('accioPromptBox').hidden && $('accioPromptBox').open
    };

    /* ---- 4. 自定义亮点应覆盖自动补充 ---- */
    const typed = '图书馆一天不断电，宿舍桌子放得下';
    $('accioHighlight').value = typed;
    $('accioHighlight').dispatchEvent(new Event('input', { bubbles: true }));
    $('accioMakePrompt').click();
    await sleep(200);
    const typedPrompt = $('accioPrompt').value;
    log.typedHighlight = {
      usesTyped: typedPrompt.includes(typed),
      noAutoText: !/重点覆盖：/.test(typedPrompt),
      hint: $('accioHighlightHint').textContent.slice(0, 30)
    };

    /* ---- 5. 深链格式 ---- */
    const deep = accioDeepLink(typedPrompt);
    let parsed = null;
    try {
      const u = new URL(deep);
      const raw = u.searchParams.get('askParams');
      parsed = { host: u.host, path: u.pathname, questionOk: false, typeOk: false, roundTrip: false };
      const obj = JSON.parse(raw);
      parsed.questionOk = obj.question === typedPrompt;
      parsed.typeOk = obj.questionType === 'v1_biz';
      parsed.roundTrip = true;
    } catch (e) { parsed = { error: e.message }; }
    log.deepLink = { length: deep.length, ...parsed };

    /* ---- 6. 改提示词正文后按钮状态联动 ---- */
    $('accioPrompt').value = '';
    $('accioPrompt').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    const emptyDisabled = $('accioCopyPrompt').disabled && $('accioOpen').disabled;
    $('accioPrompt').value = '测试内容';
    $('accioPrompt').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    const filledEnabled = !$('accioCopyPrompt').disabled && !$('accioOpen').disabled;
    log.promptToggle = { emptyDisabled, filledEnabled };

    /* ---- 7. 从左侧产品搜索反选，下拉要跟着变 ---- */
    $('promotionProductQuery').value = 'MateBook Fold';
    $('promotionProductQuery').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(700);
    const cand = document.querySelector('#promotionProductCandidates button');
    if (cand) cand.click();
    await sleep(500);
    log.reverseSync = {
      promotionProduct: promotion.product?.name || null,
      modelSelect: $('accioModel').value,
      matched: promotion.product?.name === $('accioModel').value,
      statusResets: $('accioStatus').textContent.includes('请重新生成提示词')
    };

    /* ---- 8. 换型号后旧提示词必须失效 ---- */
    log.staleReset = {
      promptCleared: $('accioPrompt').value === '',
      buttonsDisabled: $('accioCopyPrompt').disabled
    };

    /* ---- 9. 现有 12 套模板未受影响 ---- */
    log.templatesIntact = {
      count: document.querySelectorAll('[data-poster-tpl]').length,
      hasStage: !!document.querySelector('#promotionPosterStage .poster-root'),
      canvaBlockStillThere: !!document.querySelector('.canva-handoff'),
      copyCardBtn: !!$('promotionCopyProductCard')
    };

    /* ---- 10. 布局不溢出（360 宽） ---- */
    return log;
  })()`);

  /* 移动端窄屏检查 */
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await wait(400);
  const narrow = await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    location.hash = '#/promotion';
    await sleep(400);
    const box = document.getElementById('accioHandoff').getBoundingClientRect();
    const doc = document.documentElement;
    const overflow = [...document.querySelectorAll('#accioHandoff *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1);
    }).map(el => el.tagName + '.' + (el.className || '') .toString().split(' ')[0] + ':' + Math.round(el.getBoundingClientRect().right));
    return { docWidth: doc.clientWidth, scrollWidth: doc.scrollWidth, blockWidth: Math.round(box.width), overflow: overflow.slice(0, 6) };
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');

  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  ok('下拉填充全部产品', out.modelOptions.count === out.modelOptions.kbCount, `下拉 ${out.modelOptions.count} / 知识库 ${out.modelOptions.kbCount}`);
  ok('按分类分组', out.groupCount >= 1, `groups=${out.groupCount}`);
  ok('有空白占位项', out.blankOption, out.blankOption);
  ok('未选型号被拦下', out.guardEmptyModel.promptLength === 0 && out.guardEmptyModel.copyDisabled, out.guardEmptyModel.status);
  ok('选型号同步产品', out.afterModelSelect.promotionProduct === 'MateBook D 16 SE 版', out.afterModelSelect.promotionProduct);
  ok('亮点留空自动补充', out.autoHighlight.hasAuto, `len=${out.autoHighlight.length}`);
  ok('提示词含产品名', out.autoHighlight.hasProduct, out.autoHighlight.hasProduct);
  ok('提示词含尺寸', out.autoHighlight.hasSize, out.autoHighlight.hasSize);
  ok('提示词含平台', out.autoHighlight.hasPlatform, out.autoHighlight.hasPlatform);
  ok('提示词禁编造价格', out.autoHighlight.forbidPrice, out.autoHighlight.forbidPrice);
  ok('无 undefined/NaN', out.autoHighlight.noPlaceholder, out.autoHighlight.noPlaceholder);
  ok('生成后按钮可用', out.autoHighlight.buttonsEnabled, out.autoHighlight.buttonsEnabled);
  ok('自定义亮点覆盖自动', out.typedHighlight.usesTyped && out.typedHighlight.noAutoText, JSON.stringify(out.typedHighlight));
  ok('深链域名正确', out.deepLink.host === 'www.accio.com' && out.deepLink.path === '/work/app', `${out.deepLink.host}${out.deepLink.path}`);
  ok('深链 question 可还原', out.deepLink.questionOk, out.deepLink.questionOk);
  ok('深链类型 v1_biz', out.deepLink.typeOk, out.deepLink.typeOk);
  ok('深链长度安全', out.deepLink.length < 7500, `len=${out.deepLink.length}`);
  ok('清空提示词禁用按钮', out.promptToggle.emptyDisabled, out.promptToggle.emptyDisabled);
  ok('填提示词启用按钮', out.promptToggle.filledEnabled, out.promptToggle.filledEnabled);
  ok('搜索反选同步下拉', out.reverseSync.matched, `${out.reverseSync.promotionProduct} vs ${out.reverseSync.modelSelect}`);
  ok('换型号清空旧提示词', out.staleReset.promptCleared && out.staleReset.buttonsDisabled, JSON.stringify(out.staleReset));
  ok('12 套模板完好', out.templatesIntact.count === 12, `count=${out.templatesIntact.count}`);
  ok('海报舞台正常', out.templatesIntact.hasStage, out.templatesIntact.hasStage);
  ok('可画区块保留', out.templatesIntact.canvaBlockStillThere, out.templatesIntact.canvaBlockStillThere);
  ok('窄屏无横向溢出', narrow.scrollWidth <= narrow.docWidth + 1, `${narrow.docWidth}/${narrow.scrollWidth}`);
  ok('窄屏区块内无溢出元素', narrow.overflow.length === 0, JSON.stringify(narrow.overflow));
  ok('无运行时异常', runtimeErrors.length === 0, JSON.stringify(runtimeErrors.slice(0, 3)));

  console.log('\n===== Accio 交接测试 =====');
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  → ' + c.detail}`));
  const failed = checks.filter(c => !c.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);

  if (process.env.DUMP) console.log('\n原始数据：\n' + JSON.stringify(out, null, 2));

  child.kill();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); try { child.kill(); } catch {} process.exit(1); });
