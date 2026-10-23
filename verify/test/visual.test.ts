// 视觉验收走真实 CDP：用本机 Edge/Chrome 代替 Electron（同一套 DevTools 协议）。找不到浏览器就跳过。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import YAML from 'yaml'
import { runVisual } from '../lib/visual.ts'
import { verify } from '../verify.ts'

function findBrowser(): string | undefined {
  if (process.env.CHROME_PATH)
    return process.env.CHROME_PATH
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'].flatMap((b) => {
        try {
          return [execFileSync('which', [b], { encoding: 'utf8' }).trim()]
        }
        catch {
          return []
        }
      })
  return candidates.find(c => c && existsSync(c))
}

const browser = findBrowser()
const skip = browser ? false : 'no Chromium-based browser found (set CHROME_PATH)'

const PAGES = {
  good: `<body><script>setTimeout(() => { document.body.innerHTML = '<div id="app"><h1>登录</h1><button>提交</button></div>' }, 500)</script></body>`,
  broken: `<body><p>加载失败</p><script>setTimeout(() => { throw new Error('boom from renderer') }, 50)</script></body>`,
  blank: `<body></body>`,
}

function visualFor(page: keyof typeof PAGES, extra: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wwk-visual-'))
  const html = join(dir, `${page}.html`)
  writeFileSync(html, `<!doctype html><meta charset="utf-8">${PAGES[page]}`)
  const args = ['--headless=new', `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    pathToFileURL(html).href]
  const screenshot = join(dir, 'shot.png')
  return {
    screenshot,
    run: () => runVisual({ exe: browser!, args, timeout_ms: 8000, screenshot, ...extra }, dir, 2000),
  }
}

test('visual: async-rendered page passes and is screenshotted', { skip, timeout: 60000 }, async () => {
  const v = visualFor('good')
  const issues = await v.run()
  assert.deepEqual(issues, [])
  assert.ok(statSync(v.screenshot).size > 1000)
})

test('visual: missing text, forbidden text and renderer exception are reported', { skip, timeout: 60000 }, async () => {
  const v = visualFor('broken', { expect_text: ['登录'], expect_selector: ['#app'], forbid_text: ['加载失败'], timeout_ms: 2500 })
  const codes = (await v.run()).map(i => i.code).sort()
  assert.deepEqual(codes, ['RENDERER_ERROR', 'VISUAL_FORBIDDEN', 'VISUAL_MISSING', 'VISUAL_MISSING'])
})

test('visual: blank window is VISUAL_BLANK', { skip, timeout: 60000 }, async () => {
  const v = visualFor('blank', { timeout_ms: 1500 })
  assert.deepEqual((await v.run()).map(i => i.code), ['VISUAL_BLANK'])
})

test('visual: wired through rules.yaml and verify()', { skip, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wwk-visual-'))
  writeFileSync(join(dir, 'p.html'), `<!doctype html><meta charset="utf-8"><body><div id="app">登录</div></body>`)
  writeFileSync(join(dir, 'rules.yaml'), YAML.stringify({
    project_type: 'electron',
    profiles: { electron: { checks: ['visual'], visual: {
      exe: browser,
      args: ['--headless=new', `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--disable-gpu',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []), pathToFileURL(join(dir, 'p.html')).href],
      expect_text: ['登录', '首页'],
      timeout_ms: 2500,
    } } },
  }))
  const r = await verify({ cwd: dir })
  assert.equal(r.exit_code, 1)
  assert.deepEqual(r.failures.map(f => [f.check, f.code]), [['visual', 'VISUAL_MISSING']])
  assert.ok(statSync(join(dir, '.agent', 'visual.png')).size > 1000) // 默认截图位置
})

test('visual: app that never exposes DevTools is VISUAL_UNAVAILABLE', { timeout: 30000 }, async () => {
  const issues = await runVisual({ exe: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'], timeout_ms: 1500 }, tmpdir(), 500)
  assert.deepEqual(issues.map(i => i.code), ['VISUAL_UNAVAILABLE'])
})
