# 翻译策略与运行模块更新

## 实现边界

ReadingTime 将应用外壳、翻译策略、翻译执行拆开：

```text
渲染页面 → preload → 主进程（校验请求、读取配置、管理版本）
                         ↓
                 utilityProcess 翻译进程 → 模型接口
                         ↑
           固定 bootstrap + 翻译引擎 + 策略快照
```

- 主进程保留窗口、系统菜单、书架、钥匙串、IPC 和更新管理。
- `src/translation/default-strategy.json` 定义内置提示词、术语、自动查词路由、语境长度和请求超时。
- `src/translation/engine.ts` 执行路由、语境裁剪、查词或翻译。HTTP、SSE、响应解析实现位于 `src/translation/llm.ts`，构建时进入翻译引擎，不在主进程执行。
- `src/translation/worker.ts` 是固定的进程入口。它只接受版本化协议，不对渲染页面暴露密钥或任意代码执行入口。
- `scripts/build-translation-update.mjs` 在开发仓库中检查并生成更新包，独立于正在运行的阅读器。它不修改阅读器的活动版本，也不调用模型、修改模型权重或自动生成代码。

这是后续接入反馈驱动改进执行器的基础。本次没有实现点赞/点踩、LLM 自动修改代码、语义质量自动评测、远程下载、前端资源热更新或整包自动升级。

## 导入策略

1. 复制 `src/translation/default-strategy.json` 到自己的 JSON 文件。
2. 修改 `version`、提示词、`glossary` 或 `routing` 等参数。
3. 在应用的「设置 → 翻译偏好 → 翻译版本」中选择「导入翻译更新」，选择该 JSON。

提示词使用 `{{targetLanguage}}` 占位符；查词提示词可使用 `{{modeInstruction}}` 保留自动识别/强制查词的区别。术语表示例：

```json
[{ "source": "agent", "target": "智能体", "targetLanguage": "简体中文" }]
```

`targetLanguage` 可省略，省略后匹配所有目标语言。只有当前选区命中的术语才加入提示词。路由参数决定候选查词的最大字符数、最大词数和 CJK 字符数；整句仍可由模型返回翻译结果。

策略限制：每侧最多 400 字符语境、请求超时 1–180 秒、最多 500 个术语，每次最多使用 30 个匹配术语。主进程的输入大小和语境上限不受更新包控制。

纯策略 JSON 沿用当前翻译引擎，修改提示词不会意外撤销先前的代码更新。导入后立即切换，不依赖设置窗口的「保存设置」按钮，关闭或取消设置也不会撤销已经完成的更新。

## 生成翻译代码更新包

在独立开发 checkout/worktree 中修改翻译引擎及其依赖，然后运行：

```bash
npm run runtime:pack -- \
  --policy /absolute/path/personal-strategy.json \
  --engine src/translation/engine.ts \
  --version local-engine-2 \
  --out .artifacts/translation-updates/local-engine-2
```

命令会先运行类型检查与单元测试，再把引擎和依赖打成一个 CommonJS 文件。输出目录必须不存在，避免覆盖旧包。Node 内置模块作为外部依赖；其他依赖由构建器打入包内，不应依赖开发仓库中的相对文件或 `node_modules`。

```text
local-engine-2/
  manifest.json   # 格式、协议版本、版本名、文件 SHA-256
  strategy.json
  engine.cjs      # 可选
```

在应用中导入 `manifest.json`。省略 `--engine` 可生成使用内置引擎的策略包；若想保留当前自定义引擎，只导入策略 JSON。

引擎必须导出 `protocolVersion = 1`、`translate(request, onDelta, signal)` 和 `testConnection(config)`，完整类型见 `src/translation/protocol.ts`。`translate` 必须保留结构化查词、流式增量、取消和错误语义；不能改变主进程/preload/页面之间的协议。构建、协议或兼容性检查失败的候选不会被采用。

## 更新与回滚行为

1. 校验策略结构、协议版本、文件类型、大小和摘要。文件名固定，版本目录名由内容摘要生成，不使用包内提供的路径。
2. 将文件复制到应用数据目录下的不可变版本快照，之后不读取原始导入文件。
3. 启动候选 utilityProcess。使用固定的本地模拟服务，检查连接测试、流式增量与最终结果、结构化查词、鉴权错误处理；不使用真实密钥、书籍或付费模型请求。
4. 检查通过后原子保存活动版本记录，再切换新请求。策略更新也使用新工作进程，保持每个请求使用完整的一份策略/引擎快照。
5. 旧请求继续在旧进程执行，完成后回收旧进程；最多等待约 190 秒，避免旧代码无法退出。新代码即使不遵守超时，宿主仍有独立截止时间。
6. 「回滚上一版本」重新检查并切换到上一版本；「恢复内置版本」始终提供基线。版本记录支持重启恢复，加载时重新校验摘要。文件损坏或活动进程退出时尝试上一版本/内置版本，失败请求不自动重放，以免重复计费。

当前翻译结果携带 `runtimeId`（内容摘要或 `builtin`）、`runtimeVersion`、`strategyVersion`，为后续反馈归因预留依据。版本名用于显示，内容摘要用于区分实际代码和策略。

默认保存目录：

```text
~/Library/Application Support/reading-time/translation-runtime/
  active.json
  versions/<content-hash>/
```

支持 `READING_TIME_USER_DATA` 覆盖整个应用数据目录，测试使用独立资料库，不操作真实书架。

## 信任与评估

utilityProcess 提供进程隔离和故障恢复，**不是执行不可信代码的操作系统沙箱**。自定义引擎具有当前用户权限，执行真实翻译时会获得该次请求的模型密钥。只导入可信的本地代码包；SHA-256 检测文件损坏，不验证作者身份。进程不继承 shell 中无关的凭据环境变量，标准输出和错误输出不转发到应用日志。

兼容性检查不是翻译质量评估。后续自动改进执行器应维护独立的真实翻译评估集、旧版本好案例、延迟/成本上限和采用条件；不能只凭本次功能检查宣称译文更好。模型生成的未知代码应先在另外的隔离环境中审查、测试，再生成可信候选包。macOS 钥匙串、菜单、窗口、签名等行为需在 macOS 上验证，普通 Linux 容器不足以覆盖。

## 仍需应用重启的改动

主进程、固定 bootstrap、preload 协议、Electron/原生依赖、签名与系统集成需要重新构建或打包，并按改动重载窗口或重启应用。正式安装版通过用户数据目录加载经过导入的翻译模块，不直接改写 `.app` 或 ASAR。

开发时 React/CSS 仍使用 Vite HMR；主进程监听可使用 `npm run dev -- --watch`，它会重启 Electron，不等同于翻译模块切换。第一次安装这次架构改动需要重启旧应用，后续策略和符合协议的引擎更新不再需要重启阅读窗口。
