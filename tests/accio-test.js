/* 门店推广 · 封面方案专项测试
 * 覆盖：版块顺序（素材表单在前、文案面板默认收起）、版式库字段完整性、
 *       人群画像、按人群一次给多套、提示词含主标题/亮点/主色/照片、
 *       深链往返与长度上限、方案失效机制、卡片交互、已删功能确实消失。
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

    /* ---- 1. 版块顺序与主次：素材表单在最上面且占满宽度 ---- */
    const page = $('promotionPage');
    const blocks = [...page.children].filter(el => el.matches('.panel, .promotion-footnote'));
    log.layout = {
      order: blocks.map(el => el.className.split(' ').filter(c => c).slice(0, 2).join('.')),
      materialFirst: blocks[0]?.classList.contains('promotion-material'),
      draftHiddenInitially: $('promotionDraftPanel').hidden,
      materialWidth: Math.round(blocks[0].getBoundingClientRect().width),
      pageWidth: Math.round(page.getBoundingClientRect().width),
      contentWidth: Math.round(page.clientWidth - (parseFloat(getComputedStyle(page).paddingLeft) + parseFloat(getComputedStyle(page).paddingRight))),
      footLast: blocks[blocks.length - 1]?.classList.contains('promotion-footnote')
    };

    /* ---- 2. 底部提示框必须是浅灰，不是主面板样式 ---- */
    const foot = document.querySelector('.promotion-footnote');
    const footStyle = getComputedStyle(foot);
    log.footnote = {
      bg: footStyle.backgroundColor,
      isNeutral: /^rgba?\\(0, 0, 0/.test(footStyle.backgroundColor),
      radius: footStyle.borderRadius,
      smallerThanPanel: parseFloat(getComputedStyle(document.querySelector('.promotion-footnote h3')).fontSize) <
                        parseFloat(getComputedStyle(document.querySelector('.promotion-material h3')).fontSize)
    };

    /* ---- 3. 该删掉的东西必须真的没了 ---- */
    log.removed = {
      localTemplates: !$('promotionCoverTemplates'),
      posterStage: !$('promotionPosterStage'),
      generateCoverBtn: !$('promotionCoverGenerate'),
      modelSelect: !$('accioModel'),
      pendingBox: !$('promotionPending'),
      applyBtn: !$('promotionApply'),
      canvaBlock: !document.querySelector('.canva-handoff'),
      canvaUrl: !$('promotionCanvaUrl'),
      coverSubField: !$('promotionCoverSub')
    };

    /* ---- 4. 加号已去掉 ---- */
    log.plusSign = {
      beforeContent: getComputedStyle(document.querySelector('#promotionPage .promo-more > summary'), '::before').content,
      afterContent: getComputedStyle(document.querySelector('#promotionPage .promo-more > summary'), '::after').content
    };

    /* ---- 5. 只留四项封面输入 ---- */
    log.coverInputs = {
      main: !!$('promotionCoverMain'),
      emph: !!$('promotionCoverEmph'),
      color: !!$('promotionCoverColor'),
      photo: !!$('promotionCoverPhoto'),
      swatchCount: document.querySelectorAll('[data-color]').length,
      onlyOnePrimaryButton: [...document.querySelectorAll('#promotionCover .action-row button.primary')].map(b => b.textContent.trim())
    };

    /* ---- 6. 版式库结构完整性 ---- */
    log.layouts = {
      count: POSTER_LAYOUTS.length,
      ids: POSTER_LAYOUTS.map(l => l.id),
      names: POSTER_LAYOUTS.map(l => l.name),
      namesUnique: new Set(POSTER_LAYOUTS.map(l => l.name)).size === POSTER_LAYOUTS.length,
      idsUnique: new Set(POSTER_LAYOUTS.map(l => l.id)).size === POSTER_LAYOUTS.length,
      complete: POSTER_LAYOUTS.every(l =>
        l.id && l.name && l.en && l.tag && l.traits &&
        Array.isArray(l.compose) && l.compose.length >= 3 && l.compose.every(s => String(s).length >= 10) &&
        l.type && l.color && Array.isArray(l.bestFor) && l.bestFor.length > 0 && l.mood && l.source),
      composeCounts: POSTER_LAYOUTS.map(l => l.compose.length)
    };

    /* ---- 7. 人群库完整，推荐版式必须存在 ---- */
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
    log.audienceOptions = {
      count: [...$('accioAudience').options].filter(o => o.value).length,
      defaultMatchesForm: $('accioAudience').value === '大学生'
    };
    log.layoutOptions = {
      count: [...$('accioLayout').options].filter(o => o.value).length,
      hasAuto: [...$('accioLayout').options].some(o => o.value === '')
    };
    log.catalogItems = $('accioLayoutCatalog').querySelectorAll('.accio-catalog-item').length;

    /* ---- 8. 没选产品就点生成：必须拦下，不能凭空编 ---- */
    $('accioMakePrompt').click();
    await sleep(120);
    log.guardNoProduct = {
      planCount: accioState.plans.length,
      cardsHidden: $('accioPlans').hidden,
      status: $('accioStatus').textContent.slice(0, 40)
    };

    /* ---- 9. 选产品 → 自动带出主标题和亮点 ---- */
    const q = $('promotionProductQuery');
    q.value = 'MateBook D 16';
    fire(q, 'input');
    await sleep(520);
    const cands = [...$('promotionProductCandidates').querySelectorAll('button')];
    if (cands.length) cands[0].click();
    await sleep(420);
    const productName = promotion.product?.name || '';
    log.afterProduct = {
      name: productName,
      main: $('promotionCoverMain').value,
      emph: $('promotionCoverEmph').value
    };

    /* ---- 10. 生成文案：面板从隐藏变为显示 ---- */
    $('promotionGenerate').click();
    await sleep(520);
    log.draftPanel = {
      hidden: $('promotionDraftPanel').hidden,
      xhsTitle: $('promotionTitle-xhs').value.slice(0, 60),
      bodyLength: $('promotionBody-xhs').value.length,
      origin: $('promotionOrigin').textContent,
      allThreeEditable: ['xhs','wechat','moments'].every(k => !!$('promotionTitle-' + k) && !!$('promotionBody-' + k))
    };

    /* ---- 11. 大学生 + 自动版式 → 3 套 ---- */
    $('accioAudience').value = '大学生';
    fire($('accioAudience'), 'change');
    await sleep(150);
    $('accioMakePrompt').click();
    await sleep(260);
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
      hasProduct: txt.every(t => t.includes(productName)),
      hasAudience: txt.every(t => t.includes(aud.label)),
      hasVoice: txt.every(t => t.includes(aud.voice)),
      hasAvoid: txt.every(t => t.includes(aud.avoid)),
      hasLayoutName: planStudent.every(p => p.prompt.includes(p.name)),
      hasMain: txt.every(t => t.includes($('promotionCoverMain').value)),
      hasEmph: txt.every(t => t.includes($('promotionCoverEmph').value)),
      hasColor: txt.every(t => /主色指定为/.test(t)),
      forbidFake: txt.every(t => /不出现价格、折扣、库存/.test(t) && /不加英文标语/.test(t)),
      noPlaceholder: txt.every(t => !/undefined|NaN|\\[object Object\\]/.test(t)),
      mainLocked: txt.every(t => /必须原样出现/.test(t))
    };

    /* ---- 12. 主色换成柔黑，提示词里的色名要跟着变 ---- */
    const darkSwatch = [...document.querySelectorAll('[data-color]')].find(b => b.dataset.color.toLowerCase() === '#262626');
    if (darkSwatch) darkSwatch.click();
    await sleep(150);
    $('accioMakePrompt').click();
    await sleep(260);
    log.darkColor = {
      invalidatedThenRebuilt: accioState.plans.length > 0,
      nameInPrompt: accioState.plans.every(p => /主色指定为柔黑/.test(p.prompt)),
      hexInPrompt: accioState.plans.every(p => /#262626/i.test(p.prompt))
    };
    // 换回浅金，后面断言不受影响
    const goldSwatch = [...document.querySelectorAll('[data-color]')].find(b => b.dataset.color.toLowerCase() === '#e8dcc4');
    if (goldSwatch) goldSwatch.click();
    await sleep(120);

    /* ---- 13. 深链：每套都能往返还原，长度在安全线内 ---- */
    $('accioMakePrompt').click();
    await sleep(260);
    log.deepLinks = accioState.plans.map(p => {
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

    /* ---- 14. 卡片：按钮文案必须是「跳转图片生成网站」 ---- */
    log.cards = {
      visible: !$('accioPlans').hidden,
      count: $('accioPlans').querySelectorAll('.accio-plan').length,
      countText: $('accioPlansCount').textContent,
      openLabel: $('accioPlans').querySelector('[data-plan-open]')?.textContent.trim(),
      noStaleOpenBtn: !$('accioOpen'),
      copyButtons: $('accioPlans').querySelectorAll('[data-plan-copy]').length,
      editButtons: $('accioPlans').querySelectorAll('[data-plan-edit]').length
    };

    /* ---- 15. 编辑提示词后，编辑框应打开 ---- */
    const editBtn = $('accioPlans').querySelectorAll('[data-plan-edit]')[1];
    if (editBtn) editBtn.click();
    await sleep(160);
    log.editSwitch = {
      activeIndex: accioState.activeIndex,
      boxOpen: !$('accioPromptBox').hidden && $('accioPromptBox').open,
      editedPromptLength: $('accioPrompt').value.length
    };

    /* ---- 16. 改主标题 → 旧方案作废 ---- */
    const beforeEdit = accioState.plans.length;
    const mainEl = $('promotionCoverMain');
    mainEl.value = '改个标题看看';
    fire(mainEl, 'input');
    await sleep(220);
    log.invalidateOnMain = {
      plansBefore: beforeEdit,
      plansCleared: accioState.plans.length === 0,
      cardsHidden: $('accioPlans').hidden,
      promptCleared: $('accioPrompt').value === '',
      status: $('accioStatus').textContent.slice(0, 30)
    };
    mainEl.value = productName.replace(/（.*$/, '') + '怎么选';
    fire(mainEl, 'input');
    await sleep(150);

    /* ---- 17. 换人群 → 旧方案作废，新人群用自己的版式 ---- */
    $('accioMakePrompt').click();
    await sleep(220);
    const beforeAudience = accioState.plans.map(p => p.layoutId);
    $('accioAudience').value = '工作党';
    fire($('accioAudience'), 'change');
    await sleep(160);
    const audInvalidated = accioState.plans.length === 0;
    $('accioMakePrompt').click();
    await sleep(240);
    log.workerPlans = {
      invalidatedFirst: audInvalidated,
      count: accioState.plans.length,
      layoutIds: accioState.plans.map(p => p.layoutId),
      expected: ACCIO_AUDIENCES['工作党'].layouts,
      distinctFromStudent: !accioState.plans.some(p => beforeAudience.includes(p.layoutId)),
      hasWorkerVoice: accioState.plans.every(p => p.prompt.includes(ACCIO_AUDIENCES['工作党'].voice))
    };

    /* ---- 18. 锁单版式只出 1 套，并先作废旧的 ---- */
    $('accioLayout').value = 'giant';
    fire($('accioLayout'), 'change');
    await sleep(140);
    const layoutInvalidated = accioState.plans.length === 0;
    $('accioMakePrompt').click();
    await sleep(240);
    log.singleLayout = {
      invalidatedFirst: layoutInvalidated,
      count: accioState.plans.length,
      layoutId: accioState.plans[0]?.layoutId,
      hint: $('accioLayoutHint').textContent.slice(0, 24)
    };

    /* ---- 19. 超长提示词必须降级为复制 ---- */
    const longPrompt = '长'.repeat(3000);
    $('accioPrompt').value = longPrompt;
    fire($('accioPrompt'), 'input');
    openAccioPlan(accioState.plans[0]?.index || 1);
    await sleep(160);
    log.tooLong = {
      urlLength: accioDeepLink(longPrompt).length,
      degraded: $('accioStatus').textContent.includes('太长'),
      status: $('accioStatus').textContent.slice(0, 40)
    };

    /* ---- 20. 换产品 → 方案清空 ---- */
    $('accioLayout').value = '';
    fire($('accioLayout'), 'change');
    await sleep(120);
    $('accioMakePrompt').click();
    await sleep(240);
    const beforeProductSwitch = accioState.plans.length;
    const other = knowledgeBase.products.find(p => p.name !== promotion.product?.name);
    setPromotionProduct(other, '测试切换产品');
    await sleep(200);
    log.staleOnProduct = {
      plansBefore: beforeProductSwitch,
      plansCleared: accioState.plans.length === 0,
      cardsHidden: $('accioPlans').hidden,
      promptCleared: $('accioPrompt').value === ''
    };

    /* ---- 21. 检查清单仍在页面底部，未被塞进主面板 ---- */
    log.footnoteContent = {
      shots: !!$('promotionShots'),
      checkboxes: document.querySelectorAll('[data-promotion-check]').length,
      insideOwnBlock: !!document.querySelector('.promotion-footnote #promotionShots')
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
    const overflow = [...document.querySelectorAll('#promotionPage *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1);
    }).map(el => el.tagName + '.' + String(el.className || '').split(' ')[0] + ':' + Math.round(el.getBoundingClientRect().right));
    return { docWidth: doc.clientWidth, scrollWidth: doc.scrollWidth, blockWidth: Math.round(box.width), overflow: overflow.slice(0, 6) };
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');

  const checks = [];
  const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  /* 版块顺序与主次 */
  ok('素材表单在最前面', out.layout.materialFirst, JSON.stringify(out.layout.order));
  ok('素材表单占满整行', out.layout.materialWidth >= out.layout.contentWidth - 2, `${out.layout.materialWidth}/${out.layout.contentWidth}`);
  ok('文案面板初始隐藏', out.layout.draftHiddenInitially, out.layout.draftHiddenInitially);
  ok('拍摄清单在页面最底部', out.layout.footLast, JSON.stringify(out.layout.order));

  /* 底部提示框 */
  ok('底部提示框是浅灰中性色', out.footnote.isNeutral, out.footnote.bg);
  ok('提示框标题字号小于主面板', out.footnote.smallerThanPanel, out.footnote.smallerThanPanel);

  /* 已删除功能 */
  ok('本地 12 套模板已删除', out.removed.localTemplates && out.removed.posterStage && out.removed.generateCoverBtn, JSON.stringify(out.removed));
  ok('推广型号下拉已删除', out.removed.modelSelect, out.removed.modelSelect);
  ok('候选稿区块已删除', out.removed.pendingBox && out.removed.applyBtn, JSON.stringify(out.removed));
  ok('可画交接已删除', out.removed.canvaBlock && out.removed.canvaUrl, JSON.stringify(out.removed));
  ok('副标题字段已删除', out.removed.coverSubField, out.removed.coverSubField);

  /* 加号 */
  ok('折叠标题不再有加号', out.plusSign.beforeContent === 'none', out.plusSign.beforeContent);

  /* 封面输入精简为四项 */
  ok('封面只留主标题/亮点/主色/照片', out.coverInputs.main && out.coverInputs.emph && out.coverInputs.color && out.coverInputs.photo, JSON.stringify(out.coverInputs));
  ok('主色保留 8 个浅色选项', out.coverInputs.swatchCount === 8, `count=${out.coverInputs.swatchCount}`);
  ok('封面只剩「生成方案」一个主按钮', JSON.stringify(out.coverInputs.onlyOnePrimaryButton) === JSON.stringify(['生成方案']), JSON.stringify(out.coverInputs.onlyOnePrimaryButton));

  /* 版式库 */
  ok('版式库共 8 套', out.layouts.count === 8, `count=${out.layouts.count}`);
  ok('版式 id 与名称唯一', out.layouts.idsUnique && out.layouts.namesUnique, JSON.stringify(out.layouts.names));
  ok('每套版式字段完整', out.layouts.complete, JSON.stringify(out.layouts.composeCounts));
  ok('版式库目录列出全部', out.catalogItems === out.layouts.count, `catalog=${out.catalogItems}`);

  /* 人群库 */
  ok('人群库共 6 类', out.audiences.count === 6, JSON.stringify(out.audiences.keys));
  ok('人群字段完整且版式有效', out.audiences.complete, out.audiences.complete);
  ok('人群下拉填充且默认跟随表单', out.audienceOptions.count === out.audiences.count && out.audienceOptions.defaultMatchesForm, JSON.stringify(out.audienceOptions));
  ok('版式下拉 = 自动 + 8 套', out.layoutOptions.count === 8 && out.layoutOptions.hasAuto, `count=${out.layoutOptions.count}`);

  /* 拦空值 */
  ok('没选产品被拦下', out.guardNoProduct.planCount === 0 && out.guardNoProduct.cardsHidden, out.guardNoProduct.status);

  /* 选产品 */
  ok('选产品后自动带出主标题', /怎么选/.test(out.afterProduct.main), out.afterProduct.main);
  ok('选产品后自动带出亮点', out.afterProduct.emph.length > 0, out.afterProduct.emph);

  /* 文案面板 */
  ok('生成文案后面板出现', out.draftPanel.hidden === false, out.draftPanel.hidden);
  ok('三平台文案都可编辑', out.draftPanel.allThreeEditable && out.draftPanel.bodyLength > 100, out.draftPanel.bodyLength);

  /* 多套方案 */
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
  ok('提示词含主标题', out.studentPromptContent.hasMain, out.studentPromptContent.hasMain);
  ok('提示词含亮点', out.studentPromptContent.hasEmph, out.studentPromptContent.hasEmph);
  ok('提示词含主色', out.studentPromptContent.hasColor, out.studentPromptContent.hasColor);
  ok('主标题要求原样出现', out.studentPromptContent.mainLocked, out.studentPromptContent.mainLocked);
  ok('提示词禁编造价格活动', out.studentPromptContent.forbidFake, out.studentPromptContent.forbidFake);
  ok('提示词无占位符残留', out.studentPromptContent.noPlaceholder, out.studentPromptContent.noPlaceholder);

  /* 主色联动 */
  ok('改主色后提示词跟着变', out.darkColor.invalidatedThenRebuilt && out.darkColor.nameInPrompt && out.darkColor.hexInPrompt, JSON.stringify(out.darkColor));

  /* 深链 */
  const dl = out.deepLinks;
  ok('深链条数与方案一致', dl.length === 3, `links=${dl.length}`);
  ok('深链域名路径正确', dl.every(d => d.host === 'www.accio.com' && d.path === '/work/app'), `${dl[0]?.host}${dl[0]?.path}`);
  ok('每套提示词可往返还原', dl.every(d => d.questionOk && d.typeOk), JSON.stringify(dl.map(d => d.questionOk)));
  ok('每套深链长度 ≤ 8000', dl.every(d => d.underLimit), JSON.stringify(dl.map(d => d.length)));

  /* 卡片 */
  ok('方案卡片全部渲染', out.cards.visible && out.cards.count === 3, `cards=${out.cards.count}`);
  ok('按钮文案为跳转图片生成网站', out.cards.openLabel === '跳转图片生成网站', out.cards.openLabel);
  ok('旧的「打开当前这套」按钮已移除', out.cards.noStaleOpenBtn, out.cards.noStaleOpenBtn);
  ok('每张卡还有复制与编辑', out.cards.copyButtons === 3 && out.cards.editButtons === 3, JSON.stringify({ c: out.cards.copyButtons, e: out.cards.editButtons }));
  ok('卡片显示方案总数', /共 3 套方案/.test(out.cards.countText), out.cards.countText);
  ok('编辑按钮打开对应提示词', out.editSwitch.activeIndex === 2 && out.editSwitch.boxOpen && out.editSwitch.editedPromptLength > 100, JSON.stringify(out.editSwitch));

  /* 失效机制 */
  ok('改主标题作废旧方案', out.invalidateOnMain.plansBefore > 0 && out.invalidateOnMain.plansCleared && out.invalidateOnMain.cardsHidden && out.invalidateOnMain.promptCleared, JSON.stringify(out.invalidateOnMain));
  ok('改主标题给出提示', !!out.invalidateOnMain.status, out.invalidateOnMain.status);
  ok('换人群作废旧方案', out.workerPlans.invalidatedFirst, out.workerPlans.invalidatedFirst);
  ok('工作党给 3 套', out.workerPlans.count === 3, `count=${out.workerPlans.count}`);
  ok('工作党用自己的版式', JSON.stringify(out.workerPlans.layoutIds) === JSON.stringify(out.workerPlans.expected), JSON.stringify(out.workerPlans.layoutIds));
  ok('不同人群版式不重复', out.workerPlans.distinctFromStudent, JSON.stringify(out.workerPlans.layoutIds));
  ok('工作党口吻生效', out.workerPlans.hasWorkerVoice, out.workerPlans.hasWorkerVoice);
  ok('锁定版式先作废旧方案', out.singleLayout.invalidatedFirst, out.singleLayout.invalidatedFirst);
  ok('锁版式只出 1 套', out.singleLayout.count === 1 && out.singleLayout.layoutId === 'giant', JSON.stringify(out.singleLayout));
  ok('换产品清空全部方案', out.staleOnProduct.plansBefore > 0 && out.staleOnProduct.plansCleared && out.staleOnProduct.cardsHidden && out.staleOnProduct.promptCleared, JSON.stringify(out.staleOnProduct));

  /* 降级 */
  ok('超长提示词降级复制', out.tooLong.degraded, `${out.tooLong.urlLength} / ${out.tooLong.status}`);

  /* 底部清单 */
  ok('拍摄清单还在且在自己的区块里', out.footnoteContent.shots && out.footnoteContent.checkboxes === 4 && out.footnoteContent.insideOwnBlock, JSON.stringify(out.footnoteContent));

  /* 布局与异常 */
  ok('窄屏无横向溢出', narrow.scrollWidth <= narrow.docWidth + 1, `${narrow.docWidth}/${narrow.scrollWidth}`);
  ok('窄屏区块内无溢出', narrow.overflow.length === 0, JSON.stringify(narrow.overflow));
  ok('无运行时异常', runtimeErrors.length === 0, JSON.stringify(runtimeErrors.slice(0, 3)));

  console.log('\n===== 门店推广 · 封面方案测试 =====');
  checks.forEach(c => console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  → ' + c.detail}`));
  const failed = checks.filter(c => !c.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);

  if (process.env.DUMP) console.log('\n原始数据：\n' + JSON.stringify(out, null, 2));

  child.kill();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); try { child.kill(); } catch {} process.exit(1); });
