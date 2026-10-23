import { mkdirSync, writeFileSync } from "node:fs"

mkdirSync("public", { recursive: true })
writeFileSync("public/index.html", [
  "<!doctype html>",
  '<html lang="zh-CN">',
  "  <head><meta charset=\"utf-8\" /><title>登录</title></head>",
  '  <body><div id="app"></div></body>',
  "</html>",
  "",
].join("\n"))
console.log("[fix] 已补上缺失的 public/index.html")
