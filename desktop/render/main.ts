import './style.css'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const desktop = window.wwkDesktop

function render(status: BootStatus): void {
  const failed = status.phase === 'error'
  $('starting').hidden = failed
  $('error').hidden = !failed
  if (!failed) {
    $('starting-text').textContent = status.message
    return
  }
  $('error-title').textContent = status.message
  const log = $('log')
  log.hidden = !status.log
  log.textContent = status.log ?? ''
  $('copy-log').hidden = !status.log
  $<HTMLButtonElement>('retry').disabled = false
}

$('retry').addEventListener('click', () => {
  $<HTMLButtonElement>('retry').disabled = true
  void desktop.retry()
})
$('copy-log').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement
  void desktop.copy($('log').textContent ?? '').then(() => {
    btn.textContent = '已复制'
    setTimeout(() => (btn.textContent = '复制日志'), 1500)
  })
})

desktop.onStatus(render)
void desktop.getStatus().then(render)
