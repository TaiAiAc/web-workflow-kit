// 假的 codex CLI：只认 `exec ... -o <文件> [-m 模型] <prompt> -i <图>...`，把看到的参数写进 -o 文件。
// FAKE_CODEX_FAIL 时报错退出；FAKE_CODEX_PLACEHOLDER 时正文里留一个占位词（校验不过）。
import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
if (process.env.FAKE_CODEX_FAIL) {
  process.stderr.write("model not available\n")
  process.exit(2)
}
const out = args[args.indexOf("-o") + 1]
const firstImage = args.indexOf("-i")
const images = args.filter((_, i) => args[i - 1] === "-i")
const prompt = args[firstImage - 1]
const model = args.includes("-m") ? args[args.indexOf("-m") + 1] : "default"
const sandbox = args[args.indexOf("--sandbox") + 1]
writeFileSync(out, `## 概览\n\nCLI 收到 images=${images.length} sandbox=${sandbox} model=${model} prompt_before_images=${prompt.includes("看图写设计分析")}\n\n## 不确定的地方\n\n${process.env.FAKE_CODEX_PLACEHOLDER ? "待定" : "无"}\n`)
