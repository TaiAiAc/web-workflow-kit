import { mkdirSync, writeFileSync } from "node:fs"

const dir = "dist/build/mp-weixin"
mkdirSync(dir, { recursive: true })
// 故意的：少了一个右括号，package_size 读 app.json 时会抛异常
writeFileSync(dir + "/app.json", '{ "pages": ["pages/index/index"], "subPackages": [ }')
writeFileSync(dir + "/app.js", 'App({})\n')
writeFileSync(dir + "/project.config.json", '{ "appid": "touristappid", "projectname": "wwk-fixture" }')
console.log("[build] 小程序构建完成（app.json 内容有语法错误）")
