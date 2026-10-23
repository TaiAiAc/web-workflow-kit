import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

// 干净构建：先删产物，再从 public/ 拷入口页
rmSync("dist", { recursive: true, force: true })
if (!existsSync("public/index.html")) {
  console.log("public/index.html(1,1): error: entry html is missing")
  console.log("error during build: missing entry html")
  process.exit(1)
}
mkdirSync("dist", { recursive: true })
copyFileSync("public/index.html", "dist/index.html")
writeFileSync("dist/assets.js", 'console.log("bundle")\n')
console.log("[build] 构建完成")
