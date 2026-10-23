# 需求：补齐 electron 发布产物

当前 electron 项目 `pnpm exec electronup build` 能过，但门禁在 unpacked / installer 两项失败：

- `dist/win-unpacked/resources/app.asar` 里必须有 `package.json`，且其 version 与项目 `package.json` 一致
- `dist/` 下的安装包文件名必须包含版本号（如 `wwk-electron-fixture-1.0.0.exe`）
- `dist/latest.yml` 的 `version` 与 `package.json` 一致，`files[].sha512` 与安装包真实 sha512（base64）一致

验收以 `node <kit>/web_workflow_kit/assets/verify.mjs --cwd . --json` 退出码为准（0 通过）。
