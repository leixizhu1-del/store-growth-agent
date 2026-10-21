// 封面区专项验证 v2（海报模板版）：模板切换、主色、信息卡、设计简报、像素差异、导出
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 9224;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
if (!edge) throw new Error('找不到 Edge');

const pageUrl = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
const profile = path.join(process.env.TEMP || '/tmp', 'cover-test-' + Date.now());

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1000', pageUrl], { stdio: 'ignore' });

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
    await sleep(400);

    $('promotionProductQuery').value = 'MateBook D 16 SE';
    $('promotionProductQuery').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(700);
    log.autoCandidates = document.querySelectorAll('#promotionProductCandidates button').length;
    log.autoMatch = (document.querySelector('#promotionProductMatch')||{}).textContent;
    const cand = document.querySelector('#promotionProductCandidates button');
    if (cand) cand.click();
    await sleep(600);
    log.productConfirmed = promotion.product ? promotion.product.name : null;
    log.defaults = {
      main: $('promotionCoverMain').value,
      emph: $('promotionCoverEmph').value,
      sub: $('promotionCoverSub').value
    };

    // 模板画廊
    const cards = [...document.querySelectorAll('[data-poster-tpl]')];
    log.tplCount = cards.length;
    const listCard = cards.find(b => b.dataset.posterTpl === 'checklist');
    listCard.click();
    await sleep(150);
    log.afterListClick = {
      state: posterState.template,
      activeCard: (document.querySelector('[data-poster-tpl].is-active') || {}).dataset?.posterTpl,
      aria: listCard.getAttribute('aria-checked'),
      activeCount: document.querySelectorAll('[data-poster-tpl].is-active').length
    };

    // 主色
    const colorBtns = [...document.querySelectorAll('[data-color]')];
    log.colorCount = colorBtns.length;
    colorBtns[2].click();
    await sleep(150);
    log.afterColorClick = {
      value: $('promotionCoverColor').value,
      active: (document.querySelector('[data-color].is-active') || {}).dataset?.color,
      activeCount: document.querySelectorAll('[data-color].is-active').length
    };

    // 像素指纹：抽查 4 套，确认版式真的不同
    async function fingerprint(tplId) {
      setPosterTemplate(tplId, true);
      await sleep(90);
      const blob = await posterToBlob();
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = URL.createObjectURL(blob); });
      const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1440;
      cv.getContext('2d').drawImage(img, 0, 0);
      const data = cv.getContext('2d').getImageData(0, 0, 1080, 1440).data;
      let hash = 0, light = 0, dark = 0;
      for (let i = 0; i < data.length; i += 4 * 97) {
        hash = (hash * 31 + data[i] + data[i+1] * 3 + data[i+2] * 7) % 2147483647;
        const lum = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
        if (lum > 200) light++; else dark++;
      }
      URL.revokeObjectURL(img.src);
      return { tpl: tplId, hash, lightRatio: +(light / (light + dark)).toFixed(3) };
    }
    log.render = [];
    for (const t of ['deep', 'paper', 'checklist', 'mono']) log.render.push(await fingerprint(t));
    log.hashesDistinct = new Set(log.render.map(r => r.hash)).size;

    // 产品信息卡
    setPosterTemplate('deep', true);
    const card = buildProductCard();
    log.card = {
      length: card.length,
      hasMain: card.includes($('promotionCoverMain').value),
      hasProduct: card.includes(promotion.product.name),
      hasWarning: card.includes('不要写进图里'),
      hasSource: card.includes(promotion.product.source),
      head: card.slice(0, 46).replace(/\\n/g, ' / ')
    };

    $('promotionCopyProductCard').click();
    await sleep(150);
    log.copyStatus = $('promotionCanvaStatus').textContent.slice(0, 34);

    // 设计简报
    const brief = buildCanvaDesignBrief();
    log.brief = {
      length: brief.length,
      hasSize: brief.includes('1080 × 1440'),
      hasManualNote: brief.includes('不支持网页自动填充'),
      leaksOldTpl: /knowledge|interest|promo 模板/.test(brief),
      tplName: (brief.match(/版式倾向：(.*)/) || [])[1],
      noUndefined: !/undefined|NaN/.test(brief)
    };

    // 生成 + 下载
    $('promotionCoverMain').value = '16 寸大屏，表格不缩行';
    renderPoster();
    await sleep(120);
    await generatePoster();
    await sleep(700);
    log.generated = {
      downloadEnabled: !$('promotionCoverDownload').disabled,
      status: $('promotionCoverStatus').textContent.slice(0, 42),
      hasBlob: !!coverState.blobUrl,
      linksShown: !$('promotionCoverLinks').hidden
    };

    // 空主标题守卫
    const saved = $('promotionCoverMain').value;
    $('promotionCoverMain').value = '';
    await generatePoster();
    await sleep(120);
    log.emptyTitleGuard = $('promotionCoverStatus').textContent.slice(0, 30);
    $('promotionCoverMain').value = saved;
    renderPoster();

    log.detailsDefaultCollapsed = {
      moreOptions: !$('promotionMoreOptions').open,
      coverMore: !$('promotionCoverMore').open
    };
    log.visibleFieldCount = [...document.querySelectorAll('#promotionFields .field')].filter(f => f.offsetParent !== null).length;
    log.totalFieldCount = document.querySelectorAll('#promotionFields .field').length;
    return log;
  })()`);

  out.runtimeErrors = runtimeErrors;
  console.log(JSON.stringify(out, null, 2));
  ws.close(); child.kill();

  const fail = [];
  if (out.tplCount !== 12) fail.push('模板数应为 12，实际 ' + out.tplCount);
  if (out.hashesDistinct !== 4) fail.push('版式像素指纹重复');
  if (out.afterListClick.state !== 'checklist') fail.push('点击模板未切换');
  if (out.afterListClick.activeCount !== 1) fail.push('高亮卡片数不为 1');
  if (out.afterColorClick.activeCount !== 1) fail.push('色板高亮数不为 1');
  if (!out.generated.downloadEnabled || !out.generated.hasBlob) fail.push('生成后下载不可用');
  if (!out.brief.noUndefined) fail.push('设计简报含 undefined/NaN');
  if (out.runtimeErrors.length) fail.push('有运行时异常');
  if (fail.length) { console.error('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log('\nALL PASS');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
