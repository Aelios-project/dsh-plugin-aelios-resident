# Aelios Resident for DSH

在 DeepSeek Harness 中使用 Resident 原版界面。云端住民继续负责原来的人格、主对话与 Aelios 记忆；本机帮手在普通 DSH 会话中后台运行。

完整权限帮手支持明确授权后的读写文件、执行命令、安装依赖和使用普通 DSH 工具。工作区是任务的起始目录，完整权限不把执行限制在这个目录内。旧版只读授权继续只读；必须停用后重新开启完整权限。ACP 后续再做。

## 使用

1. 安装 DeepSeek Harness `0.2.1-rc.3`，通过插件管理器安装这个目录。插件包名为 `@aelios/dsh-resident`。
2. 打开侧栏「Aelios 住民」，填已有 Resident 的 HTTPS 根地址及网页钥匙。钥匙只保存在 DSH Host 凭据服务，原版页面得到的只是桌面标记。
3. 在原版界面继续聊天、切换住户、看线程和改设置。对话与网站、Telegram、企业微信共享；本机不会创建另一份主对话或长期记忆。
4. 要开启本机帮手，云端先应用配套 Resident 代码 PR，并在原版设置中开启「后台帮忙」。打开 DSH 工具栏「连接与本机帮手」，明确选定住民和本机目录，再点「开启完整本机帮手」。Web 和手机上的目录列表浏览的是运行 DSH 的电脑，不是浏览器所在设备；不依赖原生目录选择弹窗。每个住民最多一台有效设备；每位住民的工作区授权独立。
5. 明确要求住民把本机任务交给电脑后，住民通过既有 `cloud_task` 的 `execution: "desktop"` 发单。本机后台领取，结果交回原主对话。`execution: "local"` 仍表示 Cloudflare Think 线程。
6. 点击任务卡上的「查看 DSH 执行过程」才打开原生 DSH 会话；标题旁「回到住民」返回原界面，草稿在当前浏览器标签页保留。切换页面和关闭视图不会取消任务，要停止请在 DSH 会话中明确停止，或停用设备。

设备停用、网页连接改变或授权失效后，旧帮手的每次工具调用都会被重新校验并拒绝。已经启动的外部进程和已发生的写入不因撤销授权而自动撤回。原生会话仍会显示历史执行过程，但不能继续访问已撤销的目录。网页钥匙、设备 token 和工作区绝对路径不发送进原版页面或云端任务卡。

## 当前边界

- 单个住民仅支持一台有效设备，一次只领一个任务。丢失授权响应时，先在连接设置的设备列表查看／撤销，避免盲目重复注册。
- 任务、会话与设备分别绑定；云端给出的会话 ID 只是提示，打开与复用只认 Host 自己保存的映射。
- 重启、租约过期或执行结果不明时，不会自动重做。保留原会话供检查；未确认的线程不自动继续。结果回传使用持久事件与稳定幂等 ID。
- 完整权限使用 DSH 的普通工具，不再应用旧工作区工具的只读过滤。旧的只读会话仍保留原来的越界、敏感文件和输出限制。完整权限可访问工作区之外的主机资源，授权时界面明确说明这一点。
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

`0.2.1` 还在实际 DSH Host 中以新模块实例完成了隔离验证：普通独立会话仅显示工作区工具；有界文件读取和目录列表成功；全局 Shell 和额外注册的工具被拒绝；撤销合成授权后访问被拒绝。测试没有调用模型，测试会话、preset 和临时插件均已清理。此结果不代表云端发单到真实模型的完整流程已经验收。

若升级后仍看到早期简化面板，应先核对 Host 发布的 Client 模块路径及依赖表；安装版本号不能证明浏览器已拿到新版资源。曾观察到已安装 `0.2.1`，但运行中的模块映射仍指向旧 PoC 目录。只有确认 Host 发布新资源后，刷新页面才能完成界面升级。

原项目与协议说明：[Aelios-resident](https://github.com/Aelios-project/Aelios-resident)。原版 UI 的具体来源记录在发布包的 `ui/SOURCE.json` 中。

## English

This plugin makes DSH a desktop surface for the original Aelios Resident UI. The cloud remains authoritative for personality, the shared main conversation, and Aelios memory. An explicitly registered device can accept `desktop` jobs in independent, ordinary DSH sessions; opening a task is a click-only navigation action, and returning to Resident does not stop execution.

Full-access helpers provide ordinary DSH tools for reading and changing files, commands, dependency installation and local work after an explicit grant. The chosen workspace is its starting directory, not an operating-system boundary. Existing read-only grants stay read-only until the user disables and replaces them with a full-access grant. Grants are scoped to the cloud connection, resident and device and checked on tool execution and cold resume. Revoking a grant cannot undo completed changes or external processes already started. Unknown work is never automatically replayed. ACP and multi-device scheduling are deferred.

Install this directory using the DSH plugin manager, connect an existing Resident, apply the companion cloud code PR, enable background help, and explicitly choose a resident and workspace before enabling a device. Microphone recording, system notifications and Service Workers remain available through the full website. Tests use synthetic credentials and scripted contracts, not a paid model or a browser mock.

## License

AGPL-3.0-only, following Aelios-resident. Vendored Alpine.js retains its MIT license and attribution. The original UI assets and their provenance ship with the plugin.
