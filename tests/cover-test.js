// 封面区专项验证 v3：素材→产品→封面字段→版式方案→提示词→跳转链接
// 对应现版本：本地只生成提示词，出图交给图片生成网站
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
    await sleep(500);

    /* 1. 产品输入不再自动套用默认产品 */
    log.initialProduct = promotion.product ? promotion.product.name : null;
    $('promotionProductQuery').value = 'MateBook D 16 SE';
    $('promotionProductQuery').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(700);
    log.autoCandidates = document.querySelectorAll('#promotionProductCandidates button').length;
    log.autoMatch = ($('promotionProductMatch') || {}).textContent;
    const cand = document.querySelector('#promotionProductCandidates button');
    if (cand) cand.click();
    await sleep(600);
    log.productConfirmed = promotion.product ? promotion.product.name : null;

    /* 2. 封面字段默认值来自产品，不自造价格活动 */
    log.coverDefaults = {
      source: $('promotionCoverSource').textContent.slice(0, 40),
      titleHint: $('promotionCoverTitleHint').textContent.slice(0, 30),
      emphHint: $('promotionCoverEmphHint').textContent.slice(0, 40)
    };

    /* 3. 主色板：黑白灰浅金，只有一个深色 */
    const colorBtns = [...document.querySelectorAll('#promotionCoverSwatches [data-color]')];
    log.colorCount = colorBtns.length;
    log.colorNames = colorBtns.map(b => b.getAttribute('aria-label'));
    log.defaultColor = $('promotionCoverColor').value;
    const lumOf = h => {
      const c = h.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
        .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
    };
    log.darkColorCount = colorBtns.filter(b => lumOf(b.dataset.color) <= .179).length;
    colorBtns[2].click();
    await sleep(150);
    log.afterColorClick = {
      value: $('promotionCoverColor').value,
      active: (document.querySelector('#promotionCoverSwatches [data-color].is-active') || {}).dataset?.color,
      activeCount: document.querySelectorAll('#promotionCoverSwatches [data-color].is-active').length
    };
    colorBtns[0].click();
    await sleep(120);

    /* 4. 版式库：选项齐全且不重复 */
    const layoutOpts = [...$('accioLayout').options].map(o => o.value).filter(Boolean);
    log.layoutOptions = layoutOpts.length;
    log.audienceOptions = Object.keys(ACCIO_AUDIENCES).length;
    log.layoutCatalogRendered = document.querySelectorAll('#accioLayoutCatalog > *').length > 0;

    /* 5. 不填主标题：仍可出方案，但必须提示「建议填一条」 */
    $('promotionCoverMain').value = '';
    $('accioMakePrompt').click();
    await sleep(300);
    log.emptyTitle = { warned: $('accioStatus').textContent.includes('主标题还没填'), plans: document.querySelectorAll('#accioPlans .accio-plan').length };

    /* 6. 填好标题后生成方案 */
    $('promotionCoverMain').value = '16 寸大屏，表格不缩行';
    $('promotionCoverMain').dispatchEvent(new Event('input', { bubbles: true }));
    $('promotionCoverEmph').value = '3:2 高色域屏幕，写作业看表格都够用';
    $('promotionCoverEmph').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    $('accioLayout').value = '';
    $('accioMakePrompt').click();
    await sleep(700);
    const cards = [...document.querySelectorAll('#accioPlans .accio-plan')];
    log.plans = {
      count: cards.length,
      barShown: !$('accioPlansBar').hidden,
      countText: $('accioPlansCount').textContent.slice(0, 40),
      status: $('accioStatus').textContent.slice(0, 44)
    };

    /* 7. 提示词质量：含尺寸、主标题、禁编造约束，无 undefined/NaN */
    const prompt = currentAccioPrompt();
    log.prompt = {
      length: prompt.length,
      hasSize: prompt.includes('1080') && prompt.includes('1440'),
      hasTitle: prompt.includes('16 寸大屏'),
      hasNoFakePrice: /不要|不得|未核实/.test(prompt),
      noUndefined: !/undefined|NaN|null/.test(prompt),
      head: prompt.slice(0, 50).replace(/\\n/g, ' / ')
    };

    /* 8. 锁定版式只出 1 套 */
    const firstLayout = layoutOpts[0];
    $('accioLayout').value = firstLayout;
    $('accioLayout').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    $('accioMakePrompt').click();
    await sleep(600);
    log.lockedLayout = {
      plans: document.querySelectorAll('#accioPlans .accio-plan').length,
      layout: firstLayout,
      hint: $('accioLayoutHint').textContent.slice(0, 34)
    };

    /* 9. 跳转链接是图片生成网站，且带提示词 */
    const firstPlan = accioState.plans[0];
    const link = firstPlan ? accioDeepLink(firstPlan.prompt) : '';
    log.deepLink = firstPlan ? {
      href: link.slice(0, 60),
      isHttp: /^https?:/.test(link),
      carriesPrompt: link.length > 120,
      decodedHasTitle: decodeURIComponent(link).includes('16 寸大屏')
    } : null;

    /* 10. 折叠面板默认收起，可见字段少于总字段 */
    log.details = {
      moreOptionsCollapsed: !$('promotionMoreOptions').open,
      promptBoxCollapsed: !$('accioPromptBox').open
    };
    log.viewFields = [...document.querySelectorAll('#promotionFields .field')].filter(f => f.offsetParent !== null).length;
    log.totalFields = document.querySelectorAll('#promotionFields .field').length;

    return log;
  })()`);

  out.runtimeErrors = runtimeErrors;
  console.log(JSON.stringify(out, null, 2));
  ws.close(); child.kill();

  const fail = [];
  if (out.initialProduct) fail.push('进页面就自动套用了默认产品');
  if (!out.productConfirmed) fail.push('产品候选点击未生效');
  if (out.multiCandidates < 2) fail.push('模糊搜索未出现多个候选：' + out.multiCandidates);
  if (out.productBeforePick) fail.push('多候选时不应自动确认产品');
  if (out.productConfirmed !== 'MateBook D 16 SE 版') fail.push('点选候选后产品未确认：' + out.productConfirmed);
  if (!(out.colorCount >= 7)) fail.push('主色数量不足：' + out.colorCount);
  if (out.defaultColor.toLowerCase() !== '#e8dcc4') fail.push('默认主色不是浅金');
  if (out.darkColorCount !== 1) fail.push('深色数量应为 1，实际 ' + out.darkColorCount);
  if (!['浅金', '纯白', '浅灰', '柔黑'].every(n => out.colorNames.includes(n))) fail.push('缺少黑白灰浅金选项');
  if (out.afterColorClick.activeCount !== 1) fail.push('色板高亮数不为 1');
  if (out.layoutOptions < 4) fail.push('版式选项不足：' + out.layoutOptions);
  if (!out.layoutCatalogRendered) fail.push('版式库目录未渲染');
  if (!out.emptyTitle.warned) fail.push('空主标题缺少提醒');
  if (!out.plans.count) fail.push('生成方案数为 0');
  if (!out.prompt.hasSize) fail.push('提示词缺 1080×1440 尺寸');
  if (!out.prompt.hasTitle) fail.push('提示词未带入主标题');
  if (!out.prompt.hasNoFakePrice) fail.push('提示词缺少「不得编造」约束');
  if (!out.prompt.noUndefined) fail.push('提示词含 undefined/NaN/null');
  if (out.lockedLayout.plans !== 1) fail.push('锁定版式应只出 1 套，实际 ' + out.lockedLayout.plans);
  if (!out.deepLink || !out.deepLink.isHttp) fail.push('跳转链接不是 http(s)');
  if (out.deepLink && !out.deepLink.carriesPrompt) fail.push('跳转链接未携带提示词');
  if (out.deepLink && !out.deepLink.decodedHasTitle) fail.push('跳转链接未带入主标题');
  if (!out.details.moreOptionsCollapsed) fail.push('更多选项默认未收起');
  if (!out.details.promptBoxCollapsed) fail.push('提示词框默认未收起');
  if (out.runtimeErrors.length) fail.push('有运行时异常：' + (out.runtimeErrors[0] || '').slice(0, 70));
  if (fail.length) { console.error('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log('\nALL PASS');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
