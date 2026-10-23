import './style.css'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const desktop = window.wwkDesktop
const isWin = desktop.platform === 'win32'

// macOS 自带的 python3 是 3.9，不够用，直接写 Homebrew 的 3.12（brew install python@3.12）
$('cmd-venv').textContent = isWin
  ? 'python -m venv $env:USERPROFILE\\wwk-venv'
  : desktop.platform === 'darwin' ? 'python3.12 -m venv ~/wwk-venv' : 'python3 -m venv ~/wwk-venv'
$('cmd-install').textContent = `${isWin ? '& $env:USERPROFILE\\wwk-venv\\Scripts\\python.exe' : '~/wwk-venv/bin/python'} -m pip install "web-workflow-kit[all] @ git+https://github.com/TaiAiAc/web-workflow-kit"`

function render(status: BootStatus): void {
  const failed = status.phase === 'error'
  $('starting').hidden = failed
  $('error').hidden = !failed
  if (!failed) {
    $('starting-text').textContent = status.message
    return
  }
  $('error-title').textContent = status.message
  const list = $('failures')
  list.replaceChildren(...(status.failures ?? []).map((f) => {
    const li = document.createElement('li')
    const label = document.createElement('strong')
    label.textContent = f.label
    const err = document.createElement('span')
    err.textContent = f.error
    li.append(label, err)
    return li
  }))
  const log = $('log')
  log.hidden = !status.log
  log.textContent = status.log ?? ''
  setBusy(false)
}

function setBusy(busy: boolean): void {
  for (const id of ['retry', 'choose'])
    $<HTMLButtonElement>(id).disabled = busy
}

$('retry').addEventListener('click', () => {
  setBusy(true)
  void desktop.retry()
})
$('choose').addEventListener('click', () => {
  setBusy(true)
  void desktop.choosePython().finally(() => setBusy(false))
})
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    void desktop.copy($(btn.dataset.copy!).textContent ?? '').then(() => {
      btn.textContent = '已复制'
      setTimeout(() => (btn.textContent = '复制'), 1500)
    })
  })
})

desktop.onStatus(render)
void desktop.getStatus().then(render)
