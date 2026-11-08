# 本地 Harness 组合测试

`pnpm exec vitest run --config vitest.native.config.ts` 将插件与本机最新 Harness 源码组合运行。默认源码目录为 `../deepseek-harness`，可通过 `DSH_SOURCE_DIR` 指定其他检出目录。它使用真实 AgentLoop、steer inbox、子代理管理、问题与审批服务、模型切换和 JSONL 会话；模型响应和 QQ 网络发送由确定性的适配器代替，不需要 API key 或 QQ 账号。

先在 Harness 检出中按其说明安装依赖并准备当前平台的 `node-addon-system` 产物。测试配置读取该仓库 `tsconfig.base.json` 的源码映射与装饰器转换，优先使用其依赖。源码更新后若包目录的依赖链接缺失，还会从它的 pnpm virtual store 只读解析；不会修改 Harness 工作区。

也可把未安装的第三方依赖和官方平台模块放在隔离目录，通过 `DSH_TEST_DEPS_DIR` 指定。默认隔离目录为 `/tmp/qqbot-native-test-deps`。本次 Linux x64 检出的可复现补齐命令为：

```sh
npm install --prefix /tmp/qqbot-native-test-deps --no-save --ignore-scripts --package-lock=false zod@4.4.3 p-limit@7.3.3 rrule@2.8.1 @deepseek-ai/node-addon-system@0.1.2 @deepseek-ai/node-addon-system-linux-x64@0.1.2
pnpm exec vitest run --config vitest.native.config.ts
```

其他平台请使用对应平台的官方 native 包；正常准备好的 Harness 工作区无需该隔离安装。持久化测试使用真实 OS 文件锁，测试临时会话写在系统临时目录，结束后释放根代理和后代再删除。

这些测试验证本机源码 API 的组合行为；公开 QQ 服务的网络、交互按钮外观及移动端送达仍须用测试账号验收。
