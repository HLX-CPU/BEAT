# BEAT 多方协同

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524.14-339933)](https://nodejs.org/)

> **这是 BEAT 的开源源码仓库**，以 MIT 许可证发布。商业安装包、托管服务与技术支持不属于本仓库内容。
> 源码可以独立运行（见下方「从源码运行」）；发现问题请提交 Issue，改动请走 Pull Request。

**Codex、DeepSeek、ZCode、拓展坞＋助手是平等搭档，Claude 是失败时的只读顾问。**一个服务、一个看板、一个 MCP（`beat`）。

Codex 或 DeepSeek 或 ZCode 发起 → 全体同轮并发讨论和分工 → 全体批准同一版本 → 所有搭档按分工同时处理文件、命令和电脑操作 → 发起方核验 → 失败时请 Claude 建议并重新审批返工。模型没有固定先后顺序；共享电脑的具体操作互斥，思考和文件工作继续并行，各方保留自己的操作上下文。

ZCode 搭档默认停用：在看板「设置 → 模型默认值」里勾选启用后参与协作；首次使用需要完成一次 `zcode login zai` 浏览器授权（未登录时点「测试 ZCode 联通」会给出指引）。

同一任务的每位搭档固定使用自己的会话，讨论、执行、评估、返工和继续执行都向该会话追加消息；只有发起新任务才新建会话。API 搭档保存完整工具调用历史及稳定前缀，已收到的讨论记录不重复注入。固定会话不等于输入 token 免费或保证缓存命中。

## 2.2.125 更新要点（2026-10-19）

- **交付不再误判**：方案只登记了部分文件时，自动补齐任务说明/产出引用里点名的文件；同一方案依赖任务重写前序产物不再算越界。
- **失败恢复**：新增 `node src/cli.mjs release <任务号> [--task 小任务]`，核对现有文件后只重新排队被隔离的小任务、不重放已完成写入。
- **文件夹授权**：新增 `node src/cli.mjs folders list | add <目录> | remove <目录>`，与看板「以后允许」写同一份授权记录。
- **轮数与费用透明**：轮数被本机上限或本地控制器调整时返回请求值与实际值；取消且未调用模型时明确「未产生费用」。
- **暂停语义**：暂停的搭档被直接提问/追问时明确报「已手动暂停、未派发、未产生费用」，不静默换人；拓展坞也可暂停/恢复。
- **用量接口**：新增 `node src/cli.mjs usage`；接口不返回金额与上游剩余配额，实际费用以提供方账单为准。
- **接口细节**：非法枚举报错给出可填值；`beat_get` 支持 `fields` 精简返回；`wait_seconds` 派发前校验。

完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## 日常使用

**运行 `node src/cli.mjs open`** 打开看板（发行版里是双击启动脚本）：

- 顶部三张状态卡：Codex / DeepSeek / Claude 是否在线、冷却到几点；可以手动「暂停」某一方（让别人顶上）。
- **发起**：选「难题讨论」或「并行任务」，选发起方（提出问题、最后评估的一方），写清问题或目标。
- 右侧是过程：每次发言谁说的、同意还是有异议、分歧在哪；并行任务还有分工表、各搭档交付报告、每轮评估。
- **快速提问**：直接问某一方，答复自动续上同一会话。
- **设置**：**Claude 顾问连接**和拓展坞接入模型用同一套选项——服务商与名称、站点地址、密钥、「获取这个端点的模型列表」后搜索选模型、默认推理强度（未声明的端点只显示"由接口决定"，不会假装支持）、接口协议与推理协议声明、支持图片输入、启用；「测试 Claude 联通」会先保存再测试。另有 Codex / DeepSeek 的**默认模型**；讨论发言上限、并行最多几轮、冷却时间、卡住多久算卡住（默认 12 分钟）；允许的工作目录。
- 并行任务里，一方卡住会有另一方自动接手，接手记录和根因分析都出现在同一条任务的时间线上。
- **拓展坞（顶部「＋」）**：选服务商（预置了通义千问、Kimi、智谱 GLM、豆包、腾讯混元、MiniMax、硅基流动、零一万物、百川、DeepSeek 官方 API，或自定义 OpenAI 兼容端点）→ 填密钥 → 「获取这个端点的模型列表」→ 搜索并选模型 → 保存后自动测试（列模型、实发一句、试一次工具调用）。
  可以无限追加，同一家也能接多个模型；卡片上的 ⚙ 可修改、测试、上移/下移（只改变卡片显示顺序）、停用或移除。密钥只存在 `secrets.local.json`。
- **附件**：发起/提问卡片里可以拖入图片或文件、在输入框里直接粘贴截图、或点「选择文件」（单个 ≤50MB，最多 20 个）。
- **推理强度**：发起时可分别给 Codex / DeepSeek 选强度；提问时选的强度会记到该会话；「设置」里可改两方的默认模型和默认强度。
- 每轮全体同时提出或审议意见，改动后重新全体批准；安全上限内未获全体本人批准就停止，不强行分工。所有搭档都可以领取文件或电脑任务。

**在 Codex 或 DeepSeek 里直接说**（`setup` 之后重启客户端，出现 beat 工具）：

> 这个问题用 beat_discuss 和 DeepSeek 讨论一下：……

> 用 beat_parallel 和 DeepSeek 分工完成：在 E:\beat\workspaces\demo 里……，验收是……。完成后告诉我评估结论。

在哪个客户端里说，哪一方就是发起方。

**命令行**（`node src/cli.mjs` 查看全部）：

```powershell
node src/cli.mjs discuss "问题" --by codex
node src/cli.mjs parallel "目标" --by deepseek --cwd E:\beat\workspaces\demo
node src/cli.mjs get R1 --wait 120
node src/cli.mjs ask claude "问题"           # 续问加 --session S1
node src/cli.mjs agents pause codex          # 手动让 Codex 下线；resume 恢复
node src/cli.mjs claude-test
```

## 三方是怎么被调用的

| 谁 | 方式 | 说明 |
| --- | --- | --- |
| Codex | 桌面端自带 `codex.exe app-server`（无窗口） | 用你账号当前的模型；对话进 Codex 历史，标题以「BEAT ·」开头；同一任务里讨论和评估在同一个 thread |
| DeepSeek | `DeepSeek Harness.exe` headless（无窗口，答完即退） | 模型/推理强度读取桌面端当前选择；同一任务里的发言在同一个原生会话 |
| Claude | 第三方号池 API（固定流式） | 只读；评估时附上变化文件的内容；密钥只存在 `secrets.local.json` |

对方桌面端**不需要开着**。被拉起执行的子任务里禁止再发起协作（防递归）。并行任务同一时间只跑一条（避免两条任务同时改文件），讨论和问答不排队。

**验收命令**：Codex / DeepSeek 的沙箱里通常不能启动子进程（`node --test` 会报 spawn EPERM），所以双方在分工时商定 `checks`（如 `node --test`），每轮执行后由 BEAT 在沙箱外、工作目录内实际运行，把真实输出交给评估方。这些命令以你的权限运行，看板「设置」里可以关闭。

## 限制模式：默认"严格"，可按任务放开

出厂默认是**严格档**（三个开关都是安全默认），避免普通买家在不理解后果时默认承担过大的权限面。需要装依赖、跑测试或写构建缓存时，在看板「设置 → 高级设置」按任务选择放开；已有任务保留发起时的设置，不会被后续改动悄悄改掉。

| 开关 | 出厂默认（严格） | 按需放开 |
| --- | --- | --- |
| `flow.executorAccess` | **只能读写任务目录**（workspace-write）：装不了依赖、跑不了测试 | 完全访问（danger-full-access）：执行者能装依赖、跑任意命令 |
| `flow.allowAnyWrite` | **越界即失败**：写了任务文件范围外的文件会判失败 | 不强制范围：范围外写入只留痕、不判失败 |
| `flow.quarantineUnknown` | **隔离**：来源不明的改动或未核验的电脑输入隔离成 blocked，等人工确认 | 只留痕继续跑 |

**为什么以前会"干完活却卡住"**（R171 实测）：PyInstaller 打包含法地写出 `.build\cache\…` 等 28 个文件，落在任务声明的文件范围外 → 被判"未知副作用"隔离 → 它的下游任务永远等不到 `passed` → 整轮失败，而产物其实都做好了。

**隔离后怎么继续**：看板任务卡片上会出现「**放行被隔离的小任务（N）**」按钮，点一下就把 blocked 的任务重新排队（`beat_release` 工具同效，会记下谁在什么时候放的行、原隔离原因）。这条通道是必需的——没有它，隔离就等于死局。

**追问可以带附件**：任务跑完后在「在本任务里继续追问」那块，和发起任务一样能**拖入图片/文件/文件夹、粘贴截图**。附件会复制到任务目录的 `.beat-attachments/<任务号>/`（不混进交付物），并随提示词一起送给搭档；图片 Codex 能直接当图片看。

## 谁在计票（模型不能自己宣布通过）

**模型只负责"说出自己选哪一项"，计票、判门槛、判严重反对，全部由 BEAT 的代码做。**

```
每个在场席位回答:  {"votes":[{"id":"risk","option":"…","reason":"…","serious":false}]}
        ↓  （模型只说票，不说结果）
BEAT 代码:  解析 JSON → 把本人票放进 votes[席位] → 归并同义选项 → 数票
            → 某选项得票 ≥ 门槛 且 无严重反对 → 锁定；否则记分歧、进入下一轮或裁决
```

| 规则 | 说明 |
| --- | --- |
| 门槛 | 由代码按在场人数算：**四家 3 票、三家 2 票、两家须一致**（看板改不了，防止把门槛调低好通过） |
| 两关 | ① 每个席位的**初版提纲**本身就当一票（多数情况这关就锁定）；② 只有没谈拢的那几项才进投票轮 |
| 严重反对 | 任一家标记 `serious=true`（安全/资金/不可逆）时，**多数票也锁不住**，必须由提出者本人逐项确认解决 |
| 同义选项 | 有个一次性轻量归并：让一个模型只回答"哪些选项意思相同"，拿到别名表后**仍由代码重算票数** |
| 缺席/代答 | 掉线的席位不参与计票；被他人代答的票会标注、**不计本人票** |
| 一直投不齐 | 最多投 3 轮（看板可改轮数），仍不齐就交裁决；裁决**只能从已列选项里挑**，不能自己写新方案、不能降低验收标准 |

模型**不能**做的事：替别人投票、宣布自己这方通过、改门槛、把严重反对压过去。这些都由代码把关，`src/compact-discussion.mjs` 里有对应的单元测试。

## 附件怎么送到每个搭档手里（两条通道，实测结论）

你上传的每类附件，**所有搭档都能读到**，但走的通道不同：

| 搭档 | 图片 | Excel / Word / PPT / PDF / 压缩包 / 文本 |
| --- | --- | --- |
| **Codex**（原生） | **图片输入**（消息里是 `localImage` 项，不是路径） | 只给路径，**它自己用文件工具打开**（按你的要求保持原样） |
| **DeepSeek**（原生） | 只给路径 + 提示，**它自己用工具读**（CLI 未接受图片入参） | 同上 |
| **拓展坞 API**（glm-5.3 / claude号池）、**Claude** | **图片输入**（base64 随消息发送） | **BEAT 用 `scripts/attach2text.py` 转成文本内联**：Excel→表格、Word→正文+表格、PPT→每页文字、PDF→文本、（压缩包→文件清单） |

实测（本机）：

```
上传 sales.xlsx（北京/120/首季）→ 问 glm-5.3"第一列第二行的城市名"
答复：第一列第二行的城市名：北京；第三列第二行：首季        ✅
```

- 转不出来的文件**如实说明**（"BEAT 无法把这种文件转成文本"），不假装成功。
- 图片只发一次：按会话记账（`seenImages`），同一条会话里不会每一步重复发。
- 转换需要 Python（本机 `~/.dsh` 自带 openpyxl / python-docx / python-pptx / Pillow）；找不到就退回"只给路径"并在正文里注明。

## 执行者的沙箱权限（装依赖、跑测试要靠它）

执行者（Codex / DeepSeek 的原生会话）默认跑在 **`workspace-write`** 沙箱里：**只能在任务目录内读写，不能启动子进程**——所以 `pip install`、`pytest`、`npm install` 这类都会失败（报 `spawn EPERM` / `ENOENT`）。BEAT 自己的验收命令不受影响（它是以你的权限跑的），但**装依赖这件事必须执行者能跑命令**。

看板「设置 → 高级设置 → 执行者的沙箱权限」两个选项：

| 选项 | 效果 | 风险 |
| --- | --- | --- |
| **只能读写任务目录**（默认） | 执行者只能改任务目录里的文件；装不了依赖、跑不了测试 | 低 |
| **完全访问** | 执行者用自己的工具就能装依赖、跑任意命令 | **高**：它能执行任意命令，请只在信任目标时开 |

实测（本机原本没有 pytest）：

```
执行者报告：本机原无 pytest（No module named pytest），且用户 pip 配置里有 install.target=…
           用 PIP_CONFIG_FILE=nul 仅对该次安装绕过配置，装到用户级 site-packages，未修改全局 pip 配置
复核轮：    验收命令 pytest tests/test_beautify.py 原样重跑 = 21 passed in 0.10s，退出码 0
```

- 这是一次**显式放开本机权限**：时间线里会记「执行者按「完全访问」建立会话（可装依赖、可跑命令）」。
- **只影响执行阶段**：讨论、评审、核验仍跑在只读会话里，不能改文件。
- 配置键：`config.json` 的 `flow.executorAccess`（`workspace-write` | `danger-full-access`）。

## 每个任务都有自己的文件夹（文件写在哪里）

**给一个目录发起并行任务后，BEAT 会在里面自动建一个任务目录，交付文件都落在那里，不再直接写在你给的目录根：**

```
<你给的目录>/beat-runs/<日期>/<任务号>/
    src/…            产出（模型按任务目录写相对路径）
    test/…
    package.json
    .beat-control/   框架自己的队列账本、检查证据、检查点（不用管它）
```

- 每个小任务还有自己的子目录（`task-1/`、`task-2/`…），多个任务互不覆盖。
- 规划时 BEAT 会把**真实任务目录**告诉搭档，并要求文件范围与验收命令一律写**相对路径**（如 `node --test test/x.test.mjs`）；万一写了绝对路径，落在任务目录内的会被自动归一成相对路径，落在目录外的会给出可改的报错。
- 任务之间天然隔离：同一天跑 10 个任务就是 10 个文件夹；任务目录已存在且非空时会自动加后缀（`R168-2`），不会混在一起。
- 想看某个任务的产出，直接在 `beat_get` 里读它返回的 `cwd`，或者按上面的规则去 `<你给的目录>\beat-runs\<日期>\<任务号>\` 找。
- **不想要这个行为**：`config.json` 里把 `flow.taskFolder` 设为 `false` 就回到"直接写在你给的目录根"的老行为（创建失败时也会自动退回老行为，不会让任务挂掉）。

## 文件

| 路径 | 内容 |
| --- | --- |
| `src/` | 服务、编排（orchestrator）、顶替（roster）、三方执行端、MCP、命令行。零第三方依赖，Node ≥ 24 |
| `web/index.html` | 看板 |
| `config.example.json` | 配置示例；复制为 `config.json` 后按需修改（省略的键使用内置默认值） |
| `secrets.local.json` | 本地访问令牌、Claude 密钥——**不要外传**，已在 `.gitignore` 中排除 |
| `data/beat.sqlite` | 任务、每一步、会话、事件、三方健康状态 |
| `data/reports/R*.md` | 每个任务的完整记录 |
| `data/logs/` | 每一步的原始事件流、服务日志 |
| `data/backups/` | 接入时对 Codex / DeepSeek 配置做的备份 |

## 给后续「操控电脑助手」的接口（src/dock.mjs）

拓展坞的底层客户端是通用的，电脑助手直接用它做「模型 → 调工具 → 把结果喂回模型」的循环：

```js
import { loadConfig } from './src/config.mjs';
import { chatDock, dockList } from './src/dock.mjs';
const config = loadConfig();
const id = dockList(config).find(d => d.tools === 'supported')?.id;   // 测试时已标出哪些模型能调工具
const messages = [{ role: 'system', content: '你可以操控这台电脑…' }, { role: 'user', content: '打开记事本' }];
const tools = [{ type: 'function', function: { name: 'run_command', description: '…', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } }];
for (;;) {
  const r = await chatDock(config, id, { messages, tools });       // 流式；支持图片（截图）content
  messages.push(r.message);                                         // assistant 消息（含 tool_calls）可直接接回
  if (!r.toolCalls.length) break;
  for (const c of r.toolCalls) messages.push({ role: 'tool', tool_call_id: c.id, content: await runTool(c.name, JSON.parse(c.arguments)) });
}
```

`chatDock` 返回 `{ text, toolCalls, finishReason, usage, model, message }`；错误信息是中文人话（密钥无效 / 限流 / 地址不对…）。

## 从源码运行

需要 **Node.js ≥ 24.14**。项目运行时零第三方依赖，`npm install` 只安装开发用的 eslint。

```powershell
git clone https://github.com/HLX-CPU/BEAT.git
cd BEAT
Copy-Item config.example.json config.json   # 可选；不建也能跑，省略的键使用内置默认值
npm install                                 # 仅开发依赖
node src/cli.mjs start                      # 启动服务
```

看板地址：<http://127.0.0.1:8765>。首次启动会在 `secrets.local.json` 生成访问令牌，请勿提交或外传。

把 BEAT 注册成 Codex / DeepSeek 的 MCP（会先备份原配置，完成后重启两个客户端）：

```powershell
node src/cli.mjs setup
```

## 测试与维护

```powershell
npm test                      # 单元测试（假执行端，不耗额度）
node tests/live-e2e.mjs       # 实机端到端：真跑一次讨论 + 一次并行任务（耗少量额度）
```

- 改了 `src/` 要重启服务：`node src/cli.mjs stop`，下次调用自动拉起。
- 服务重启时，未结束的任务标为「中断」，不自动重跑（可能已经写过文件）。
- DeepSeek 写文件前，BEAT 会给工作目录补上它沙箱需要的本人权限（只限本人拥有的目录，原权限备份在 `data/acl-backups`）。

## 许可证

[MIT](LICENSE) © 2026 HLX-CPU
