import { mkdirSync, writeFileSync } from "node:fs"

mkdirSync("dist/assets", { recursive: true })
writeFileSync("dist/index.html", '<!doctype html>\n<html lang="zh-CN">\n  <head><meta charset="utf-8" /><title>登录</title></head>\n  <body><div id="app"></div><script src="/assets/app.js"></script></body>\n</html>\n')
writeFileSync("dist/assets/app.js", 'console.log("vite build output")\n')
console.log("[build] 构建完成，产物写入 dist/")
