/* Accio 多套方案专项测试
 * 覆盖：版式库字段完整性、人群画像、按人群一次给多套、每套提示词互不相同、
 *       深链往返与长度上限、方案失效机制、卡片交互、原有封面模板不受影响
 * 用法：node tests/accio-test.js        （加 DUMP=1 打印原始数据）
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

    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

    /* ---- 1. 版式库结构完整性 ---- */
    log.layouts = {
      count: POSTER_LAYOUTS.length,
      ids: POSTER_LAYOUTS.map(l => l.id),
      names: POSTER_LAYOUTS.map(l => l.name),
      namesUnique: new Set(POSTER_LAYOUTS.map(l => l.name)).size === POSTER_LAYOUTS.length,
      idsUnique: new Set(POSTER_LAYOUTS.map(l => l.id)).size === POSTER_LAYOUTS.length,
      // 每套都必须有可执行的构图条目，而不是「科技感」这类形容词
      complete: POSTER_LAYOUTS.every(l =>
        l.id && l.name && l.en && l.tag && l.traits &&
        Array.isArray(l.compose) && l.compose.length >= 3 && l.compose.every(s => String(s).length >= 10) &&
        l.type && l.color && Array.isArray(l.bestFor) && l.bestFor.length > 0 && l.mood && l.source),
      composeCounts: POSTER_LAYOUTS.map(l => l.compose.length)
    };

    /* ---- 2. 人群库结构完整性，且推荐版式必须存在 ---- */
    const audKeys = Object.keys(ACCIO_AUDIENCES);
    const layoutIds = new Set(POSTER_LAYOUTS.map(l => l.id));
    log.audiences = {
      count: audKeys.length,
      keys: audKeys,
      complete: audKeys.every(k => {
        const a = ACCIO_AUDIENCES[k];
        return a.label && a.alias && a.hook && a.pain && a.voice && a.avoid &&
          Array.isArray(a.layouts) && a.layouts.length >= 3 && a.layouts.every(id => layoutIds.has(id));
      })
    };

    /* ---- 3. 下拉填充 ---- */
    const opts = [...$('accioModel').querySelectorAll('option')].filter(o => o.value);
    log.modelOptions = {
      count: opts.length,
      kbCount: knowledgeBase.products.length,
      groupCount: $('accioModel').querySelectorAll('optgroup').length,
      blankOption: [...$('accioModel').options].some(o => o.value === '')
    };
    log.audienceOptions = {
      count: [...$('accioAudience').options].filter(o => o.value).length,
      labels: [...$('accioAudience').options].filter(o => o.value).map(o => o.textContent)
    };
    log.layoutOptions = {
      count: [...$('accioLayout').options].filter(o => o.value).length,
      hasAuto: [...$('accioLayout').options].some(o => o.value === '')
    };
    log.catalogItems = $('accioLayoutCatalog').querySelectorAll('.accio-catalog-item').length;

    /* ---- 4. 未选型号点生成：必须被拦下，不能凭空编造 ---- */
    $('accioModel').value = '';
    $('accioMakePrompt').click();
    await sleep(120);
    log.guardEmptyModel = {
      status: $('accioStatus').textContent.slice(0, 40),
      planCount: accioState.plans.length,
      cardsHidden: $('accioPlans').hidden
    };

    /* ---- 5. 选型号 + 大学生 + 自动版式 ---- */
    const target = opts.find(o => /MateBook D 16 SE/.test(o.value)) || opts[0];
    $('accioModel').value = target.value;
    fire($('accioModel'), 'change');
    await sleep(600);
    log.afterModelSelect = { promotionProduct: promotion.product?.name || null };

    $('accioAudience').value = '大学生';
    fire($('accioAudience'), 'change');
    $('accioHighlight').value = '';
    $('accioMakePrompt').click();
    await sleep(220);

    const planStudent = accioState.plans.map(p => ({ index: p.index, id: p.layoutId, name: p.layoutName, prompt: p.prompt }));
    log.studentPlans = {
      count: planStudent.length,
      layoutIds: planStudent.map(p => p.id),
      expected: ACCIO_AUDIENCES['大学生'].layouts,
      distinctLayouts: new Set(planStudent.map(p => p.id)).size === planStudent.length,
      distinctPrompts: new Set(planStudent.map(p => p.prompt)).size === planStudent.length,
      lengths: planStudent.map(p => p.prompt.length)
    };

    const aud = ACCIO_AUDIENCES['大学生'];
    const txt = planStudent.map(p => p.prompt);
    log.studentPromptContent = {
      hasSetup: txt.every(t => t.includes('1080×1440') && t.includes('小红书')),
      hasProduct: txt.every(t => t.includes(target.value)),
      hasAudience: txt.every(t => t.includes(aud.label)),
      hasVoice: txt.every(t => t.includes(aud.voice)),
      hasAvoid: txt.every(t => t.includes(aud.avoid)),
      hasLayoutName: planStudent.every(p => p.prompt.includes(p.name)),
      forbidFake: txt.every(t => /不出现价格、折扣、库存/.test(t) && /不加英文标语/.test(t)),
      noPlaceholder: txt.every(t => !/undefined|NaN|\\[object Object\\]/.test(t)),
      autoHighlight: /重点覆盖|主打方向/.test(txt[0])
    };

    /* ---- 6. 深链：每套都要能还原，且长度在安全线内 ---- */
    log.deepLinks = planStudent.map(p => {
      const url = accioDeepLink(p.prompt);
      let host = '', path = '', questionOk = false, typeOk = false;
      try {
        const u = new URL(url);
        host = u.host; path = u.pathname;
        const obj = JSON.parse(u.searchParams.get('askParams'));
        questionOk = obj.question === p.prompt;
        typeOk = obj.questionType === 'v1_biz';
      } catch (e) {}
      return { index: p.index, length: url.length, host, path, questionOk, typeOk, underLimit: url.length <= 8000 };
    });

    /* ---- 7. 卡片渲染与计数文案 ---- */
    log.cards = {
      visible: !$('accioPlans').hidden,
      barVisible: !$('accioPlansBar').hidden,
      count: $('accioPlans').querySelectorAll('.accio-plan').length,
      countText: $('accioPlansCount').textContent,
      openButtons: $('accioPlans').querySelectorAll('[data-plan-open]').length,
      copyButtons: $('accioPlans').querySelectorAll('[data-plan-copy]').length,
      editButtons: $('accioPlans').querySelectorAll('[data-plan-edit]').length,
      firstActive: $('accioPlans').querySelector('.accio-plan')?.classList.contains('is-active'),
      openEnabled: !$('accioOpen').disabled
    };

    /* ---- 8. 点「编辑提示词」应切到那一套并打开编辑框 ---- */
    const thirdEdit = $('accioPlans').querySelectorAll('[data-plan-edit]')[2];
    if (thirdEdit) thirdEdit.click();
    await sleep(160);
    log.editSwitch = {
      activeIndex: accioState.activeIndex,
      promptMatchesThird: $('accioPrompt').value === planStudent[2].prompt,
      boxOpen: !$('accioPromptBox').hidden && $('accioPromptBox').open,
      statusHasIndex: $('accioStatus').textContent.includes('第 3 套')
    };

    /* ---- 9. 换人群：旧方案必须全部作废 ---- */
    $('accioAudience').value = '工作党';
    fire($('accioAudience'), 'change');
    await sleep(150);
    log.invalidateOnAudience = {
      plansCleared: accioState.plans.length === 0,
      cardsHidden: $('accioPlans').hidden,
      barHidden: $('accioPlansBar').hidden,
      promptCleared: $('accioPrompt').value === '',
      openDisabled: $('accioOpen').disabled,
      statusHint: $('accioStatus').textContent.slice(0, 30)
    };

    /* ---- 10. 工作党 → 该人群自己的三套版式 ---- */
    $('accioMakePrompt').click();
    await sleep(220);
    log.workerPlans = {
      count: accioState.plans.length,
      layoutIds: accioState.plans.map(p => p.layoutId),
      expected: ACCIO_AUDIENCES['工作党'].layouts,
      distinctFromStudent: !accioState.plans.some(p => planStudent.some(s => s.id === p.layoutId)),
      promptHasWorkerVoice: accioState.plans.every(p => p.prompt.includes(ACCIO_AUDIENCES['工作党'].voice))
    };

    /* ---- 11. 锁定单版式：只出一套 ---- */
    $('accioLayout').value = 'industrial';
    fire($('accioLayout'), 'change');
    await sleep(120);
    const lockInvalidated = accioState.plans.length === 0;
    $('accioMakePrompt').click();
    await sleep(200);
    log.singleLayout = {
      invalidatedFirst: lockInvalidated,
      count: accioState.plans.length,
      layoutId: accioState.plans[0]?.layoutId,
      hint: $('accioLayoutHint').textContent.slice(0, 20)
    };

    /* ---- 12. 提示词过长时必须降级复制 ---- */
    accioState.activeIndex = 1;
    const longPrompt = '长'.repeat(3000);
    $('accioPrompt').value = longPrompt;
    fire($('accioPrompt'), 'input');
    const longUrl = accioDeepLink(longPrompt).length;
    openAccioPlan(1);
    await sleep(150);
    log.tooLongFallback = {
      urlLength: longUrl,
      status: $('accioStatus').textContent.slice(0, 40),
      degraded: $('accioStatus').textContent.includes('太长')
    };

    /* ---- 13. 提示词正文改空后「打开」必须禁用 ---- */
    $('accioPrompt').value = '';
    fire($('accioPrompt'), 'input');
    await sleep(120);
    const emptyDisabled = $('accioOpen').disabled;
    $('accioPrompt').value = '测试内容';
    fire($('accioPrompt'), 'input');
    await sleep(120);
    log.promptToggle = { emptyDisabled, filledEnabled: !$('accioOpen').disabled };

    /* ---- 14. 换型号：方案和卡片一起清空 ---- */
    $('accioLayout').value = '';
    fire($('accioLayout'), 'change');
    $('accioMakePrompt').click();
    await sleep(200);
    const beforeSwitch = accioState.plans.length;
    const other = opts.find(o => !/MateBook D 16 SE/.test(o.value));
    $('accioModel').value = other.value;
    fire($('accioModel'), 'change');
    await sleep(500);
    log.staleOnModel = {
      plansBefore: beforeSwitch,
      plansCleared: accioState.plans.length === 0,
      cardsHidden: $('accioPlans').hidden,
      promptCleared: $('accioPrompt').value === '',
      openDisabled: $('accioOpen').disabled
    };

    /* ---- 15. 原有本地封面模板必须完好 ---- */
    log.templatesIntact = {
      count: document.querySelectorAll('[data-poster-tpl]').length,
      hasStage: !!document.querySelector('#promotionPosterStage .poster-root'),
      canvaBlock: !!document.querySelector('.canva-handoff'),
      copyCardBtn: !!$('promotionCopyProductCard')
    };

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
    }).map(el => el.tagName + '.' + String(el.className || '').split(' ')[0] + ':' + Math.round(el.getBoundingClientRect().right));
    return { docWidth: doc.clientWidth, scrollWidth: doc.scrollWidth, blockWidth: Math.round(box.width), overflow: overflow.slice(0, 6) };
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');

  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  /* 版式库 */
  ok('版式库共 8 套', out.layouts.count === 8, `count=${out.layouts.count}`);
  ok('版式 id 与名称唯一', out.layouts.idsUnique && out.layouts.namesUnique, JSON.stringify(out.layouts.names));
  ok('每套版式字段完整', out.layouts.complete, JSON.stringify(out.layouts.composeCounts));
  ok('版式库目录列出全部', out.catalogItems === out.layouts.count, `catalog=${out.catalogItems}`);

  /* 人群库 */
  ok('人群库共 6 类', out.audiences.count === 6, JSON.stringify(out.audiences.keys));
  ok('人群字段完整且版式有效', out.audiences.complete, out.audiences.complete);
  ok('人群下拉填充', out.audienceOptions.count === out.audiences.count, `${out.audienceOptions.count} 项`);

  /* 下拉 */
  ok('型号下拉填满知识库', out.modelOptions.count === out.modelOptions.kbCount, `${out.modelOptions.count}/${out.modelOptions.kbCount}`);
  ok('型号按分类分组', out.modelOptions.groupCount >= 1, `groups=${out.modelOptions.groupCount}`);
  ok('版式下拉 = 自动 + 8 套', out.layoutOptions.count === 8 && out.layoutOptions.hasAuto, `count=${out.layoutOptions.count}`);

  /* 拦空值 */
  ok('未选型号被拦下', out.guardEmptyModel.planCount === 0 && out.guardEmptyModel.cardsHidden, out.guardEmptyModel.status);

  /* 多套方案 */
  ok('选型号同步产品', out.afterModelSelect.promotionProduct === 'MateBook D 16 SE 版', out.afterModelSelect.promotionProduct);
  ok('大学生一次给 3 套', out.studentPlans.count === 3, `count=${out.studentPlans.count}`);
  ok('按人群配版式', JSON.stringify(out.studentPlans.layoutIds) === JSON.stringify(out.studentPlans.expected), JSON.stringify(out.studentPlans.layoutIds));
  ok('3 套版式互不相同', out.studentPlans.distinctLayouts, JSON.stringify(out.studentPlans.layoutIds));
  ok('3 套提示词互不相同', out.studentPlans.distinctPrompts, JSON.stringify(out.studentPlans.lengths));

  /* 提示词内容 */
  ok('提示词含尺寸与平台', out.studentPromptContent.hasSetup, out.studentPromptContent.hasSetup);
  ok('提示词含产品名', out.studentPromptContent.hasProduct, out.studentPromptContent.hasProduct);
  ok('提示词含人群标签', out.studentPromptContent.hasAudience, out.studentPromptContent.hasAudience);
  ok('提示词含人群口吻', out.studentPromptContent.hasVoice, out.studentPromptContent.hasVoice);
  ok('提示词含人群禁忌', out.studentPromptContent.hasAvoid, out.studentPromptContent.hasAvoid);
  ok('提示词含自身版式名', out.studentPromptContent.hasLayoutName, out.studentPromptContent.hasLayoutName);
  ok('提示词禁编造价格活动', out.studentPromptContent.forbidFake, out.studentPromptContent.forbidFake);
  ok('提示词无占位符残留', out.studentPromptContent.noPlaceholder, out.studentPromptContent.noPlaceholder);
  ok('亮点留空自动补充', out.studentPromptContent.autoHighlight, out.studentPromptContent.autoHighlight);

  /* 深链 */
  const dl = out.deepLinks;
  ok('深链条数与方案一致', dl.length === 3, `links=${dl.length}`);
  ok('深链域名路径正确', dl.every(d => d.host === 'www.accio.com' && d.path === '/work/app'), `${dl[0]?.host}${dl[0]?.path}`);
  ok('每套提示词可往返还原', dl.every(d => d.questionOk && d.typeOk), JSON.stringify(dl.map(d => d.questionOk)));
  ok('每套深链长度 ≤ 8000', dl.every(d => d.underLimit), JSON.stringify(dl.map(d => d.length)));

  /* 卡片交互 */
  ok('方案卡片全部渲染', out.cards.visible && out.cards.count === 3, `cards=${out.cards.count}`);
  ok('每张卡三个按钮', out.cards.openButtons === 3 && out.cards.copyButtons === 3 && out.cards.editButtons === 3, JSON.stringify({ o: out.cards.openButtons, c: out.cards.copyButtons, e: out.cards.editButtons }));
  ok('卡片显示方案总数', /共 3 套方案/.test(out.cards.countText), out.cards.countText);
  ok('首套默认选中', out.cards.firstActive && out.cards.openEnabled, `${out.cards.firstActive}/${out.cards.openEnabled}`);
  ok('编辑按钮切到对应套', out.editSwitch.activeIndex === 3 && out.editSwitch.promptMatchesThird && out.editSwitch.boxOpen, JSON.stringify(out.editSwitch));

  /* 失效机制 */
  ok('换人群作废旧方案', out.invalidateOnAudience.plansCleared && out.invalidateOnAudience.cardsHidden && out.invalidateOnAudience.promptCleared, JSON.stringify(out.invalidateOnAudience));
  ok('换人群后清空方案栏', out.invalidateOnAudience.barHidden && out.invalidateOnAudience.openDisabled, JSON.stringify(out.invalidateOnAudience));
  ok('换人群给出提示', !!out.invalidateOnAudience.statusHint, out.invalidateOnAudience.statusHint);

  /* 不同人群不同结果 */
  ok('工作党给 3 套', out.workerPlans.count === 3, `count=${out.workerPlans.count}`);
  ok('工作党用自己的版式', JSON.stringify(out.workerPlans.layoutIds) === JSON.stringify(out.workerPlans.expected), JSON.stringify(out.workerPlans.layoutIds));
  ok('不同人群版式不重复', out.workerPlans.distinctFromStudent, JSON.stringify(out.workerPlans.layoutIds));
  ok('工作党口吻生效', out.workerPlans.promptHasWorkerVoice, out.workerPlans.promptHasWorkerVoice);

  /* 单版式 */
  ok('锁定版式先作废旧方案', out.singleLayout.invalidatedFirst, out.singleLayout.invalidatedFirst);
  ok('锁版式只出 1 套', out.singleLayout.count === 1 && out.singleLayout.layoutId === 'industrial', JSON.stringify(out.singleLayout));

  /* 降级与联动 */
  ok('超长提示词降级复制', out.tooLongFallback.degraded, `${out.tooLongFallback.urlLength} / ${out.tooLongFallback.status}`);
  ok('清空提示词禁用打开', out.promptToggle.emptyDisabled, out.promptToggle.emptyDisabled);
  ok('填入提示词启用打开', out.promptToggle.filledEnabled, out.promptToggle.filledEnabled);
  ok('换型号清空全部方案', out.staleOnModel.plansBefore > 0 && out.staleOnModel.plansCleared && out.staleOnModel.cardsHidden, JSON.stringify(out.staleOnModel));
  ok('换型号清空提示词', out.staleOnModel.promptCleared && out.staleOnModel.openDisabled, JSON.stringify(out.staleOnModel));

  /* 原有功能 */
  ok('12 套本地模板完好', out.templatesIntact.count === 12, `count=${out.templatesIntact.count}`);
  ok('海报舞台正常', out.templatesIntact.hasStage, out.templatesIntact.hasStage);
  ok('可画区块保留', out.templatesIntact.canvaBlock && out.templatesIntact.copyCardBtn, out.templatesIntact.canvaBlock);

  /* 布局与异常 */
  ok('窄屏无横向溢出', narrow.scrollWidth <= narrow.docWidth + 1, `${narrow.docWidth}/${narrow.scrollWidth}`);
  ok('窄屏区块内无溢出', narrow.overflow.length === 0, JSON.stringify(narrow.overflow));
  ok('无运行时异常', runtimeErrors.length === 0, JSON.stringify(runtimeErrors.slice(0, 3)));

  console.log('\n===== Accio 多套方案测试 =====');
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  → ' + c.detail}`));
  const failed = checks.filter(c => !c.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);

  if (process.env.DUMP) console.log('\n原始数据：\n' + JSON.stringify(out, null, 2));

  child.kill();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); try { child.kill(); } catch {} process.exit(1); });
