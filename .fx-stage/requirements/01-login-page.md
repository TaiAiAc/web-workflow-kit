# 需求：手机号验证码登录页

在现有 Vue 3 项目里实现登录页：

- 手机号输入框（11 位数字，输入非法时提示"请输入正确的手机号"）
- 验证码输入框 + "获取验证码"按钮，点击后 60 秒倒计时，倒计时期间按钮禁用
- 提交按钮：调用 `src/api/login.ts` 里的 `submitLogin`
- 失败提示内联展示在表单下方，不弹 toast
- 设计稿：见 designs/login.json（主色 #2F6BFF，圆角 8px，间距 16px）
- 验收：`pnpm exec vue-tsc --noEmit`、`pnpm exec eslint . --max-warnings=0`、`pnpm exec vitest run` 全通过，`dist/index.html` 存在

**不要**修改 `rules.yaml` 和 `agent.config.json`。
