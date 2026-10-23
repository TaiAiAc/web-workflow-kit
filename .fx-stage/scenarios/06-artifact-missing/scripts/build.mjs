import { mkdirSync, writeFileSync } from "node:fs"

// 只产出 js，忘了生成 html 入口
mkdirSync("dist/assets", { recursive: true })
writeFileSync("dist/assets/app.js", 'console.log("vite build output")\n')
console.log("[build] 构建完成（缺少 index.html）")
