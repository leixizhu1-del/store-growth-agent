门店增长智能体演示版

运行方式
1. 直接双击 index.html，或用浏览器打开。
2. 在左侧输入客户原话，选择沟通渠道和本次目标。
3. 点击"运行完整链路"，查看客户洞察、内容、报价方案、3分钟脚本与1/3/7天跟进。

替换真实知识库
打开 index.html，找到 knowledgeBase 对象，替换以下数据：
- products：产品名、基础价、适配关键词、产品卖点
- forbidden：合规禁用词
- scenarios：场景卡标签

当前版本说明
- 这是零依赖前端演示版，适合初赛现场快速展示。
- 价格计算为演示逻辑，正式使用时应接入主办方提供的四级价格规则。
- 文案生成基于本地规则匹配，不依赖外部接口，避免现场网络或密钥问题。
- 小红书封面提供 12 套海报模板，图上文字可直接点击修改，导出 1080×1440 PNG。
  无外部依赖、无账号、无费用。
- 想要更好看的效果，可用页面里的「交给 Accio 精修」：选型号、写亮点（可留空，
  留空会按已收录卖点自动补一条），生成提示词后一键打开 Accio，提示词自动带过去，
  生成后还能在对话里继续说改哪里。Accio 需要登录，网页版免下载。

版本说明
- index.html              现役版本（v2，12 套海报模板）
- versions/index.html     版本导航页，可点开查看所有历史版本
- versions/v0-canvas-basic/   v0：Canvas 单版式
- versions/v1-canvas-3tpl/    v1：Canvas 三版式

协作与上传 GitHub
请先读《版本与协作手册.md》，里面有分支规则、GitHub 配置、
提交与推送的区别、冲突处理、回退方法。

改完记得跑测试（需要 Node.js 22+ 和 Edge）
- node tests/browser-test.js     完整回归
- node tests/layout-check.js     布局检查（44 组）
- node tests/cover-test.js       封面专项
- node tests/e2e-test.js         端到端交互
- node tests/accio-test.js       Accio 提示词交接（27 项）
