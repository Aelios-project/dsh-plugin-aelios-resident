# Aelios Resident for DSH

在 DeepSeek Harness 中使用 Resident 原版界面。云端住民继续负责原来的人格、主对话与 Aelios 记忆；本机帮手在普通 DSH 会话中后台运行。

这是原生 DSH 接入的第一阶段。ACP 后续再做。当前本机能力明确限制为选定工作区的只读列目录与读文字文件，不执行命令、不改文件、不再派生智能体。

## 使用

1. 安装 DeepSeek Harness `0.2.1-rc.3`，通过插件管理器安装这个目录。插件包名为 `@aelios/dsh-resident`。
2. 打开侧栏「Aelios 住民」，填已有 Resident 的 HTTPS 根地址及网页钥匙。钥匙只保存在 DSH Host 凭据服务，原版页面得到的只是桌面标记。
3. 在原版界面继续聊天、切换住户、看线程和改设置。对话与网站、Telegram、企业微信共享；本机不会创建另一份主对话或长期记忆。
4. 要开启本机帮手，云端先应用配套 Resident 代码 PR，并在原版设置中开启「后台帮忙」。打开 DSH 工具栏「连接与本机帮手」，明确选定住民和本机目录，再点「开启只读帮手」。每个住民最多一台有效设备；每位住民的工作区授权独立。
5. 明确要求住民把只读任务交给本机后，住民通过既有 `cloud_task` 的 `execution: "desktop"` 发单。本机后台领取，结果交回原主对话。`execution: "local"` 仍表示 Cloudflare Think 线程。
6. 点击任务卡上的「查看 DSH 执行过程」才打开原生 DSH 会话；标题旁「回到住民」返回原界面，草稿在当前浏览器标签页保留。切换页面和关闭视图不会取消任务，要停止请在 DSH 会话中明确停止，或停用设备。

设备停用、网页连接改变或授权失效后，旧帮手的每次文件访问都会被重新校验并拒绝。原生会话仍会显示历史执行过程，但不能继续访问已撤销的目录。网页钥匙、设备 token 和工作区绝对路径不发送进原版页面或云端任务卡。

## 当前边界

- 单个住民仅支持一台有效设备，一次只领一个任务。丢失授权响应时，先在连接设置的设备列表查看／撤销，避免盲目重复注册。
- 任务、会话与设备分别绑定；云端给出的会话 ID 只是提示，打开与复用只认 Host 自己保存的映射。
- 重启、租约过期或执行结果不明时，不会自动重做。保留原会话供检查；未确认的线程不自动继续。结果回传使用持久事件与稳定幂等 ID。
- 工作区工具拒绝越界路径、私密配置文件、符号链接逃逸与硬链接，限制文件和输出大小，并遮蔽常见凭据。它不是面向恶意并发改动文件系统的操作系统级隔离保证。
- 原版界面由 React 管理的隔离 iframe 承载。语音录制、系统通知及 Service Worker 请使用完整网页。外部链接由工具栏提供明确的打开入口；HTML 文件预览保持隔离。
- 插件不会自动连接个人住民、注册设备、选取工作区或发送真实聊天消息。安装和单元测试不等于已经完成真实模型／浏览器全流程验收。

## 开发与验证

Node.js 22+，无运行时第三方依赖，无安装脚本。插件通过 DSH 自带的 React、服务和 Slot 扩展界面，不替换整个应用根节点。

```sh
npm test
RESIDENT_SOURCE=/path/to/Aelios-resident npm run sync-ui
npm pack --dry-run
```

`sync-ui` 复制原仓库明确列出的前端资源，保留 Alpine MIT 许可，并记录上游提交与每个资源的 SHA-256。它不包含云端执行脚本或 Service Worker。重新同步后，应检查资源差异及桌面接缝。

测试覆盖选定目录边界、冷恢复权限、独立原生会话的调度契约、真实 HTTP 重定向拒绝、事件回传、重启不重做及设备重新配对隔离。Host 合同夹具没有伪装成实际模型调用；原版页面文档检查没有伪装成浏览器渲染验收。

原项目与协议说明：[Aelios-resident](https://github.com/wusaki0723/Aelios-resident)。原版 UI 的具体来源记录在发布包的 `ui/SOURCE.json` 中。

## English

This plugin makes DSH a desktop surface for the original Aelios Resident UI. The cloud remains authoritative for personality, the shared main conversation, and Aelios memory. An explicitly registered device can accept `desktop` jobs in independent, ordinary DSH sessions; opening a task is a click-only navigation action, and returning to Resident does not stop execution.

The initial helper can only list and read text in a separately selected workspace. It cannot write files, execute commands, or delegate. Grants are scoped to the cloud connection, resident and device, rechecked on every read and cold resume, and never inherited from the initiating coding session. Unknown work is never automatically replayed. ACP, broader execution and multi-device scheduling are deferred.

Install this directory using the DSH plugin manager, connect an existing Resident, apply the companion cloud code PR, enable background help, and explicitly choose a resident and workspace before enabling a device. Microphone recording, system notifications and Service Workers remain available through the full website. Tests use synthetic credentials and scripted contracts, not a paid model or a browser mock.

## License

AGPL-3.0-only, following Aelios-resident. Vendored Alpine.js retains its MIT license and attribution. The original UI assets and their provenance ship with the plugin.
