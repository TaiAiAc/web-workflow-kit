import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { packAsar } from '../lib/asar.ts'
import { globToRegExp, extractLocations } from '../lib/util.ts'
import { verify } from '../verify.ts'

const node = JSON.stringify(process.execPath)

function project(files: Record<string, string | Buffer>, rules: object): string {
  const root = mkdtempSync(join(tmpdir(), 'wwk-verify-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  writeFileSync(join(root, 'rules.yaml'), YAML.stringify(rules))
  return root
}

const codes = (r: { failures: { code: string }[] }) => r.failures.map(f => f.code)

test('web: all green exits 0', async () => {
  const root = project({ 'dist/index.html': '<html/>' }, {
    project_type: 'web',
    commands: { typecheck: { run: `${node} -e "process.exit(0)"` } },
    profiles: { web: { checks: ['typecheck', 'build', 'artifacts'], build: { run: `${node} -e "0"` }, artifacts: { dir: 'dist', required: ['index.html'] } } },
  })
  const r = await verify({ cwd: root })
  assert.equal(r.exit_code, 0)
  assert.deepEqual(r.checks.map(c => c.status), ['pass', 'pass', 'pass'])
})

test('web: collects every failure in one round, skips artifacts after build fail', async () => {
  const root = project({}, {
    project_type: 'web',
    commands: {
      typecheck: { run: `${node} -e "console.error('src/App.vue(12,3): error TS2322: bad'); process.exit(2)"` },
      lint: { run: `${node} -e "process.exit(1)"` },
    },
    profiles: { web: { checks: ['typecheck', 'lint', 'build', 'artifacts'], build: { run: `${node} -e "process.exit(1)"` }, artifacts: { dir: 'dist' } } },
  })
  const r = await verify({ cwd: root })
  assert.equal(r.exit_code, 1)
  assert.deepEqual(codes(r), ['TYPECHECK_FAIL', 'LINT_FAIL', 'BUILD_FAIL'])
  assert.deepEqual(r.failures[0].locations, ['src/App.vue:12:3'])
  assert.equal(r.checks.at(-1)!.status, 'skip')
})

test('timeout becomes CHECK_TIMEOUT', async () => {
  const root = project({}, {
    project_type: 'web',
    profiles: { web: { checks: ['test'], test: { run: `${node} -e "setTimeout(()=>{},10000)"`, timeout_sec: 1 } } },
  })
  const r = await verify({ cwd: root })
  assert.deepEqual(codes(r), ['CHECK_TIMEOUT'])
})

test('bad config exits 2', async () => {
  const root = project({}, { project_type: 'desktop', profiles: {} })
  const r = await verify({ cwd: root })
  assert.equal(r.exit_code, 2)
  assert.deepEqual(codes(r), ['CONFIG_ERROR'])
  const r2 = await verify({ cwd: project({}, { project_type: 'web', profiles: { web: { checks: ['nope'] } } }) })
  assert.equal(r2.exit_code, 2)
})

test('miniprogram: main package size excludes subpackages', async () => {
  const big = Buffer.alloc(3 * 1024)
  const root = project({
    'out/app.json': JSON.stringify({ subPackages: [{ root: 'sub' }] }),
    'out/sub/huge.js': big,
    'out/main.js': Buffer.alloc(1024),
  }, {
    project_type: 'miniprogram',
    profiles: { miniprogram: { checks: ['package_size'], package_size: { dir: 'out', main_max_kb: 2 } } },
  })
  assert.equal((await verify({ cwd: root })).exit_code, 0)
  writeFileSync(join(root, 'rules.yaml'), YAML.stringify({
    project_type: 'miniprogram',
    profiles: { miniprogram: { checks: ['package_size'], package_size: { dir: 'out', main_max_kb: 0.5 } } },
  }))
  assert.deepEqual(codes(await verify({ cwd: root })), ['PACKAGE_TOO_LARGE'])
})

function electronProject(opts: { asarVersion?: string, ymlVersion?: string, badHash?: boolean, smoke?: string } = {}) {
  const installer = Buffer.from('fake installer')
  const sha512 = createHash('sha512').update(opts.badHash ? 'other' : installer).digest('base64')
  const sha256 = createHash('sha256').update(installer).digest('hex')
  return project({
    'package.json': JSON.stringify({ version: '1.2.3' }),
    'dist/win-unpacked/resources/app.asar': packAsar({
      'package.json': JSON.stringify({ version: opts.asarVersion ?? '1.2.3' }),
      'dist/main/index.js': 'console.log(1)',
    }),
    'dist/App-Setup-1.2.3.exe': installer,
    'dist/latest.yml': YAML.stringify({
      version: opts.ymlVersion ?? '1.2.3',
      files: [{ url: 'App-Setup-1.2.3.exe', sha512, size: installer.length }],
      path: 'App-Setup-1.2.3.exe',
      sha512,
    }),
    'dist/SHA256SUMS.txt': `${sha256}  App-Setup-1.2.3.exe\n`,
  }, {
    project_type: 'electron',
    profiles: {
      electron: {
        checks: ['unpacked', 'installer', 'smoke'],
        unpacked: { dir: 'dist/win-unpacked', asar: 'resources/app.asar', asar_required: ['package.json', 'dist/main/index.js'], check_version: true },
        installer: { dir: 'dist', pattern: '*Setup*.exe', latest_yml: 'latest.yml', sha256_file: 'SHA256SUMS.txt' },
        smoke: { exe: process.execPath, args: ['-e', opts.smoke ?? 'setTimeout(()=>{},5000)'], alive_ms: 600 },
      },
    },
  })
}

test('electron: healthy artifacts pass', async () => {
  const r = await verify({ cwd: electronProject() })
  assert.deepEqual(r.failures, [])
  assert.equal(r.exit_code, 0)
})

test('electron: version/hash/smoke failures are reported with codes', async () => {
  const r = await verify({ cwd: electronProject({ asarVersion: '1.2.2', ymlVersion: '1.2.4', badHash: true, smoke: 'process.exit(3)' }) })
  assert.equal(r.exit_code, 1)
  assert.deepEqual(codes(r).sort(), ['HASH_MISMATCH', 'SMOKE_CRASH', 'VERSION_MISMATCH', 'VERSION_MISMATCH'])
})

test('electron: visual is skipped when smoke already failed', async () => {
  const root = project({}, {
    project_type: 'electron',
    profiles: { electron: {
      checks: ['smoke', 'visual'],
      smoke: { exe: process.execPath, args: ['-e', 'process.exit(3)'], alive_ms: 500 },
      visual: { exe: process.execPath },
    } },
  })
  const r = await verify({ cwd: root })
  assert.deepEqual(codes(r), ['SMOKE_CRASH'])
  assert.deepEqual(r.checks.map(c => [c.id, c.status, c.reason]), [['smoke', 'fail', undefined], ['visual', 'skip', 'smoke failed']])
})

test('glob and location helpers', () => {
  assert.ok(globToRegExp('*Setup*.exe').test('App-Setup-1.0.0.exe'))
  assert.ok(!globToRegExp('*.exe').test('sub/a.exe'))
  assert.ok(globToRegExp('**/*.exe').test('sub/a.exe'))
  assert.deepEqual(extractLocations('src/a.ts:3:5 - error\nnode_modules/x/y.js:1:1'), ['src/a.ts:3:5'])
})
