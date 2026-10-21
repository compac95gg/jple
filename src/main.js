const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, safeStorage, dialog, Notification, clipboard, shell, powerSaveBlocker } = require('electron')
const path = require('path')
const fs = require('fs')
const { setupData, currentDb } = require('./data')
const { loadOrCreateCert, saveCert, fingerprint, pinnedFetch } = require('./tls')
const { createUpdater } = require('./updater')

// 이름을 "jple"로 바꿔도 예전 설정과 로그인이 그대로 남도록, 저장 폴더는 예전 이름을 그대로 써요
app.setPath('userData', path.join(app.getPath('appData'), '학교일정위젯'))

// 시험용: --profile=이름 으로 켜면 설정과 로그인을 따로 쓰는 위젯을 하나 더 띄울 수 있어요
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
if (profileArg) app.setPath('userData', `${app.getPath('userData')}-${profileArg.split('=')[1]}`)

// 한 PC에서 위젯은 하나만 띄워요
if (!app.requestSingleInstanceLock()) app.quit()

// 윈도우 알림을 보내려면 이 프로그램의 ID가 등록돼 있어야 해요.
// 설치한 앱은 package.json의 appId를, 개발용 실행은 electron.exe 경로를 써야 알림이 떠요
app.setAppUserModelId(app.isPackaged ? 'kr.school.widget' : process.execPath)

const MIN_W = 640
const MIN_H = 360

// ── 개인 설정: 창 위치와 크기, 배경 진하기 ──
const settingsFile = path.join(app.getPath('userData'), 'settings.json')
const settings = { opacity: 0.8, bounds: { width: 960, height: 560 }, firstRunDone: false }
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))) } catch {}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
}

// ── 자동 실행: 개발 중에는 electron.exe에 앱 폴더를 넘겨야 이 앱이 켜져요 ──
const loginItem = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }
const getAutoStart = () => app.getLoginItemSettings(loginItem).openAtLogin
const setAutoStart = (on) => app.setLoginItemSettings({ ...loginItem, openAtLogin: on })

// ── 바탕화면에 붙이기: 창을 늘 다른 창 아래(HWND_BOTTOM)로 보내요 ──
let sendToBottom = () => {}
try {
  const user32 = require('koffi').load('user32.dll')
  const SetWindowPos = user32.func(
    'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)')
  const HWND_BOTTOM = 1, SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10
  sendToBottom = (win) => SetWindowPos(Number(win.getNativeWindowHandle().readBigUInt64LE(0)),
    HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
} catch (e) {
  console.error('바탕화면 고정 기능을 불러오지 못했어요:', e.message)
}

// 트레이 메뉴의 "완전히 종료"로만 꺼지고, ✕나 Alt+F4는 숨기기만 해요
let quitting = false
app.on('before-quit', () => { quitting = true; localServer?.close() })

let win, tray
// 달력 모드와 주간업무 모드의 창 크기는 따로 기억해요 (PRD 6.3)
let mode = 'month'
let movedByProgram = 0
const boundsKey = () => (mode === 'week' ? 'weekBounds' : 'bounds')

function createWindow() {
  // 모니터 구성이 바뀌어 저장된 위치가 화면 밖이면 위치는 버려요
  const { x, y } = settings.bounds
  const onScreen = x === undefined || screen.getAllDisplays().some(({ workArea: a }) =>
    x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height)
  const bounds = onScreen ? settings.bounds : { width: settings.bounds.width, height: settings.bounds.height }

  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_W, minHeight: MIN_H,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => { win.showInactive(); sendToBottom(win) })
  // 위젯은 늘 다른 프로그램 아래에 있어야 해요. 어떤 이유로 위로 올라와도 1.5초 안에 다시 내려가요
  win.on('show', () => sendToBottom(win))
  win.on('blur', () => sendToBottom(win))
  const bottomTimer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(bottomTimer) // 프로그램을 다시 켜려고 창을 닫은 뒤에는 멈춰요
    if (win.isVisible() && !win.isMinimized()) sendToBottom(win)
  }, 1500)
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide() } })
  // 위젯을 눌러도 다른 창 위로 올라오지 않게 다시 아래로 보내요
  win.on('focus', () => sendToBottom(win))
  // 최소화에서 돌아오면 다시 작업 표시줄에서 빠지고 바탕화면에 붙어요
  win.on('restore', () => { win.setSkipTaskbar(true); sendToBottom(win) })

  let timer
  const remember = () => {
    clearTimeout(timer)
    // 전체화면일 때 크기는 기억하지 않아요 (다시 켜면 원래 크기로)
    // 프로그램이 방금 옮긴 경우(모드 전환)는 기억하지 않아요. 화면 배율 때문에 1픽셀씩 커지는 걸 막아요
    if (Date.now() - movedByProgram < 1000) return
    timer = setTimeout(() => { if (!beforeFull) { settings[boundsKey()] = win.getBounds(); saveSettings() } }, 500)
  }
  win.on('move', remember)
  win.on('resize', remember)
}

function showWidget() {
  if (win.isMinimized()) win.restore()
  win.showInactive()
  sendToBottom(win)
}

// 다른 사람이 일정을 넣거나 고치거나 지우면 윈도우 알림(화면 오른쪽 아래)을 띄워요. 누르면 위젯이 나타나요
// 개인 설정의 알림 받기(settings.notify)에 따라 골라서 보내요
function notifyEvent(kind, authorName, ev) {
  const prefs = { add: true, change: true, ...settings.notify }
  if (kind === 'add' ? !prefs.add : !prefs.change) return
  if (!Notification.isSupported()) return
  const label = { add: '', update: ' 수정', delete: ' 삭제' }[kind]
  let body = '지워진 일정'
  if (ev.start_date) {
    const [, m, d] = ev.start_date.split('-').map(Number)
    const time = ev.start_time ? ` ${ev.start_time.slice(0, 5)}` : ''
    const place = ev.location ? ` · ${ev.location}` : ''
    body = `${m}월 ${d}일${time}  ${ev.title}${place}`
  }
  const note = new Notification({ title: `${authorName}님 일정${label}`, body, silent: false })
  note.on('click', showWidget)
  note.show()
}

async function createTray() {
  // 시계 옆 아이콘은 프로그램(exe) 아이콘과 같은 그림을 써요. 나중에 exe 아이콘을 바꾸면 함께 바뀌어요
  const icon = await app.getFileIcon(process.execPath, { size: 'small' }).catch(() => nativeImage.createEmpty())
  tray = new Tray(icon)
  tray.setToolTip(`jple v${app.getVersion()}`)
  tray.on('click', showWidget)
  refreshTrayMenu()
}
// 받아 둔 새 버전이 있으면 "지금 업데이트"가 보여요
function refreshTrayMenu() {
  if (!tray) return
  const ready = updater.ready()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '위젯 보이기', click: showWidget },
    ...(ready ? [{ label: `지금 업데이트 (${ready.version})`, click: () => updater.installNow() }] : []),
    { type: 'separator' },
    { label: '완전히 종료', click: () => app.quit() },
  ]))
}

ipcMain.handle('settings:get', () => ({
  opacity: settings.opacity, theme: settings.theme, customColors: settings.customColors, autoStart: getAutoStart(),
  notify: { add: true, change: true, ...settings.notify },
  serverError,
}))
ipcMain.handle('settings:set-notify', (_, value) => { settings.notify = value; saveSettings() })
ipcMain.handle('settings:set-theme', (_, theme, customColors) => {
  settings.theme = theme
  if (customColors) settings.customColors = customColors
  saveSettings()
})
ipcMain.handle('settings:set-opacity', (_, value) => { settings.opacity = value; saveSettings() })
ipcMain.handle('settings:set-auto-start', (_, on) => { setAutoStart(on); return getAutoStart() })
// 관리자가 정한 기본 처음 비밀번호. 이 PC에만 윈도우 계정으로 암호화해서 저장해요.
ipcMain.handle('settings:get-default-password', () => {
  if (!settings.defaultPassword) return ''
  try { return safeStorage.decryptString(Buffer.from(settings.defaultPassword, 'base64')) } catch { return '' }
})
ipcMain.handle('settings:set-default-password', (_, value) => {
  settings.defaultPassword = value ? safeStorage.encryptString(value).toString('base64') : ''
  saveSettings()
})
// ✕ 버튼: 끄지 않고 숨겨요. 시계 옆 아이콘이나 바탕화면 아이콘으로 다시 열어요
ipcMain.on('window:hide', () => win.hide())
ipcMain.handle('app:version', () => app.getVersion())

// ── DB 관리 (앱 쪽): 백업 파일 저장·열기, 연결 바꾸기, 새 DB 준비 자료 복사 ──
const stamp = () => new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16)

// auto가 참이면 묻지 않고 앱 폴더의 backups에 저장해요 (초기화 직전 자동 백업)
ipcMain.handle('db:save-backup', async (_, backup, auto) => {
  const text = JSON.stringify(backup, null, 2)
  if (auto) {
    const dir = path.join(app.getPath('userData'), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `jple_자동백업_${stamp()}.json`)
    fs.writeFileSync(filePath, text)
    return { ok: true, filePath }
  }
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `jple_DB백업_${stamp()}.json`),
    filters: [{ name: 'jple 백업 파일', extensions: ['json'] }],
  })
  if (canceled || !filePath) return { canceled: true }
  fs.writeFileSync(filePath, text)
  return { ok: true, filePath }
})

ipcMain.handle('db:open-backup', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'jple 백업 파일', extensions: ['json'] }], properties: ['openFile'],
  })
  if (canceled || !filePaths?.length) return { canceled: true }
  try {
    return { ok: true, backup: JSON.parse(fs.readFileSync(filePaths[0], 'utf8')), filePath: filePaths[0] }
  } catch {
    return { error: '파일을 읽지 못했어요. jple 백업 파일인지 확인해 주세요.' }
  }
})

// ── 옮기기 파일 (외부 ↔ 로컬): 암호화된 비밀번호가 들어 있어서 파일 전체를 관리자 비밀번호로 잠가요 (AES-256-GCM) ──
const nodeCrypto = require('crypto')
const moveKey = (password, salt) => nodeCrypto.scryptSync(String(password), salt, 32)
ipcMain.handle('move:save', async (_, backup, password) => {
  const salt = nodeCrypto.randomBytes(16)
  const iv = nodeCrypto.randomBytes(12)
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', moveKey(password, salt), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(backup), 'utf8'), cipher.final()])
  const file = {
    app: 'jple', kind: 'jple-move', version: 1, created_at: backup.created_at,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  }
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `jple_옮기기_${stamp()}.jplemove`),
    filters: [{ name: 'jple 옮기기 파일', extensions: ['jplemove'] }],
  })
  if (canceled || !filePath) return { canceled: true }
  fs.writeFileSync(filePath, JSON.stringify(file))
  return { ok: true, filePath }
})
ipcMain.handle('move:open', async (_, password) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'jple 옮기기 파일', extensions: ['jplemove'] }], properties: ['openFile'],
  })
  if (canceled || !filePaths?.length) return { canceled: true }
  let file
  try { file = JSON.parse(fs.readFileSync(filePaths[0], 'utf8')) } catch { file = null }
  if (file?.kind !== 'jple-move') return { error: 'jple 옮기기 파일이 아니에요.' }
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', moveKey(password, Buffer.from(file.salt, 'base64')), Buffer.from(file.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8')
    return { ok: true, backup: JSON.parse(text), filePath: filePaths[0] }
  } catch {
    return { error: '파일 비밀번호가 맞지 않아요. 옮기기 파일을 만들 때 쓴 관리자 비밀번호를 넣어 주세요.' }
  }
})

// DB 관리의 [DB 정보]: 외부 DB인지 로컬 DB인지와 각각의 연결 정보를 보여 줘요 (비밀 정보는 없어요)
ipcMain.handle('db:info', async () => {
  const c = settings.db
  if (!c) return { kind: 'none' }
  if (c.type !== 'local') {
    return {
      kind: 'external', url: c.url, ref: c.url.match(/^https:\/\/([a-z0-9]+)\./)?.[1] ?? '', key: c.key, code: makeCode(c),
    }
  }
  const isServer = Boolean(settings.server?.enabled)
  const host = c.host === '127.0.0.1' ? serverAddress() : c.host
  const port = c.port ?? DEFAULT_PORT
  const net = c.fp ? pinnedFetch(c.fp) : fetch
  const ping = (h, pt) => net(`${c.fp ? 'https' : 'http'}://${h}:${pt}/api/ping`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).catch(() => null)
  // 서버 구성(주 서버, 대기 1·2)과 각각의 상태: 사용 중 / 대기 / 꺼짐
  const first = await ping(c.host, port)
  const list = localServer?.status().servers ?? first?.servers ?? [{ priority: 0, host, port }]
  const servers = await Promise.all(list.map(async (sv) => {
    const r = await ping(sv.host, sv.port)
    return { ...sv, state: !r ? 'off' : r.active === false ? 'standby' : 'active', version: r?.version ?? '' }
  }))
  const running = servers.find((sv) => sv.state === 'active')
  return {
    kind: 'local', isServer, host, port, ips: isServer ? lanAddresses() : [], fp: c.fp ?? '',
    // 주 서버 PC: 연결 코드에 쓸 주소를 관리자가 고를 수 있어요
    canChooseAddress: isServer && settings.server.role !== 'standby', address: isServer ? serverAddress() : '',
    addressChosen: Boolean(settings.server?.address),
    role: isServer ? (settings.server.role === 'standby' ? `대기 서버 ${settings.server.priority}` : '주 서버') : '',
    dbFile: isServer ? serverDbPath() : '', serverVersion: running?.version ?? first?.version ?? '', online: Boolean(running),
    servers, canMakeStandby: isServer && settings.server.role !== 'standby',
    code: makeCode({ type: 'local', host, port, fp: c.fp }),
  }
})

// 연결 코드에 쓸 서버 주소 고르기 (주 서버 PC). 빈 값이면 다시 저절로 골라요
ipcMain.handle('server:set-address', (_, address) => {
  if (!settings.server?.enabled || settings.server.role === 'standby') return { error: '주 서버 PC에서만 정할 수 있어요.' }
  const a = String(address ?? '').trim()
  if (a && !/^[a-zA-Z0-9.-]{1,253}$/.test(a)) return { error: '주소 모양이 맞지 않아요. 예: 192.168.0.20' }
  settings.server.address = a || undefined
  saveSettings()
  return { ok: true, address: serverAddress() }
})

// 지금 연결과 직원에게 나눠 줄 연결 코드. 서버 PC는 자기 자신(127.0.0.1)이 아니라 내부 주소로 코드를 만들어요
ipcMain.handle('db:get-connection', () => {
  const c = settings.db
  if (!c) return { url: '', code: '' }
  if (c.type === 'local') {
    const host = c.host === '127.0.0.1' ? serverAddress() : c.host
    const local = { type: 'local', host, port: c.port ?? DEFAULT_PORT, fp: c.fp }
    return { local: true, server: Boolean(settings.server?.enabled), url: `로컬 서버 ${host}:${local.port}`, code: makeCode(local) }
  }
  return { url: c.url, code: makeCode(c) }
})

// ── 연결 코드: DB 주소와 공개 키를 한 줄로 묶은 것. 회사 관리자가 직원들에게 나눠 줘요 ──
const CODE_PREFIX = 'jple-연결:'
// 외부: { u: 주소, k: 공개 키 } / 로컬: { t: 'local', h: 서버 PC 주소, p: 포트, f: 서버 인증서 지문 }
function makeCode(conn) {
  const body = conn.type === 'local' ? { t: 'local', h: conn.host, p: conn.port, f: conn.fp } : { u: conn.url, k: conn.key }
  return CODE_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url')
}
function readCode(code) {
  try {
    const body = String(code).trim().replace(CODE_PREFIX, '').replace(/^jple[^:]*:/, '')
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (c.t === 'local') {
      if (!c.h) return null
      // 0.4.0 전에 만든 로컬 코드에는 지문이 없어요 (https가 아니라 지금은 쓸 수 없어요)
      if (!/^[a-f0-9]{64}$/.test(c.f ?? '')) return { old: true }
      return { type: 'local', host: c.h, port: Number(c.p) || DEFAULT_PORT, fp: c.f }
    }
    return c.u && c.k ? { url: c.u, key: c.k } : null
  } catch { return null }
}

// ── 로컬 서버: 이 PC가 서버면 jple과 함께 켜져요 ──
const os = require('os')
const { createServer, DEFAULT_PORT } = require('./server/server')
let localServer = null
let serverError = null
const serverDbPath = () => path.join(app.getPath('userData'), 'jple-server.db')

// 같은 학교 네트워크에서 다른 PC가 이 PC에 접속할 주소 (192.168.x.x 같은 내부 주소)
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address)
    .sort((a, b) => Number(/^(192\.168|10\.|172\.)/.test(b)) - Number(/^(192\.168|10\.|172\.)/.test(a)))
}

// 연결 코드에 쓸 서버 주소: 관리자가 고른 주소, 없으면 저절로 고른 내부 주소
const serverAddress = () => settings.server?.address || lanAddresses()[0] || '127.0.0.1'
const certFile = () => path.join(app.getPath('userData'), 'server-cert.json')

// 주 서버: 우선순위 0, 자기 주소. 대기 서버: 우선순위 1·2, 주 서버 주소와 복제 열쇠
function clusterConfig() {
  if (settings.server.role === 'standby') {
    return {
      priority: settings.server.priority, primary: settings.server.primary, replKey: settings.server.key, pcId: settings.pcId,
      // 관리자가 지정을 해제하면(복제받은 목록에서 빠지면) 대기 서버를 그만둬요
      onRemoved: () => applyStandby(null),
      // 주 서버 주소가 바뀌면 따라가요
      onPrimaryMoved: (addr) => { settings.server.primary = addr; saveSettings() },
    }
  }
  return { priority: 0, selfAddress: serverAddress }
}
async function startLocalServer() {
  const tls = await loadOrCreateCert(certFile())
  localServer = createServer({
    dbPath: serverDbPath(), port: settings.server.port ?? DEFAULT_PORT, version: app.getVersion(), cluster: clusterConfig(),
    tls, updateDir: path.join(app.getPath('userData'), 'server-updates'),
  })
  await localServer.listen()
  // 이 PC의 jple도 서버 인증서 지문을 알아야 해요 (서버를 처음 켤 때, 0.4.0 전에 만든 서버)
  const fp = fingerprint(tls.cert)
  if (settings.db?.type === 'local' && settings.db.fp !== fp) { settings.db.fp = fp; saveSettings() }
  keepAwake(true)
}

// 서버 PC(주·대기)는 절전으로 잠들지 않게 해요 (화면은 꺼져도 돼요)
let awakeId = null
function keepAwake(on) {
  if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension')
  if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null }
}

// ── 매일 자동 백업: 로컬 서버(사용 중인 서버)와 외부 DB(관리자 PC)가 하루 1번, 30개까지 ──
const DAILY_PREFIX = 'jple_매일백업_'
const backupDir = () => path.join(app.getPath('userData'), 'backups')
const today = () => new Date().toLocaleDateString('sv-SE')
const dailyDone = () => fs.existsSync(path.join(backupDir(), `${DAILY_PREFIX}${today()}.json`))
function saveDailyBackup(backup) {
  fs.mkdirSync(backupDir(), { recursive: true })
  fs.writeFileSync(path.join(backupDir(), `${DAILY_PREFIX}${today()}.json`), JSON.stringify(backup, null, 2))
  // 날짜 이름 순으로 오래된 것부터 지워서 30개만 남겨요 (꺼 둔 날이 있어도 개수 기준)
  const files = fs.readdirSync(backupDir()).filter((f) => f.startsWith(DAILY_PREFIX)).sort()
  for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.rmSync(path.join(backupDir(), f), { force: true })
}
async function dailyBackupTick() {
  if (dailyDone()) return
  try {
    if (localServer?.status().active) return saveDailyBackup(localServer.backup())
    // 외부 DB: 관리자로 로그인한 jple만 해요
    const db = currentDb()
    if (db?.type === 'supabase' && signedIn?.is_admin) {
      const res = await db.autoBackup()
      if (res?.backup) saveDailyBackup(res.backup)
    }
  } catch (e) { console.error('매일 백업 실패:', e.message) }
}

// ── 자동 업데이트 ──
const updater = createUpdater({
  app, dir: path.join(app.getPath('userData'), 'update'), getDb: currentDb,
  notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); refreshTrayMenu() },
  // 받는 동안 시계 옆 아이콘에 마우스를 올리면 진행 정도가 보여요
  progress: (pct, ver) => tray?.setToolTip(pct === null ? `jple v${app.getVersion()}` : `jple v${app.getVersion()} · 새 버전 ${ver} 받는 중 ${pct}%`),
})
let signedIn = null // 지금 로그인한 계정
async function onSignedIn(profile) {
  signedIn = profile
  const info = await updater.check()
  refreshTrayMenu()
  dailyBackupTick()
  // 관리자가 새 버전을 깔았는데 학교에는 아직 예전 버전이면, 배포할지 물어요 (버전마다 한 번만)
  // 위젯은 다른 창 아래에 있어서, 질문 창은 따로 맨 앞에 띄워요
  const mine = app.getVersion()
  if (profile.is_admin && (!info || updater.newer(mine, info.version)) && settings.askedPublishFor !== mine) {
    settings.askedPublishFor = mine
    saveSettings()
    const { response } = await dialog.showMessageBox({
      type: 'question', buttons: ['DB 관리 열기', '나중에'], defaultId: 0, cancelId: 1, title: 'jple 업데이트 배포',
      message: info ? `이 PC의 jple(v${mine})이 학교에 배포된 버전(v${info.version})보다 새것이에요. 다른 PC들도 이 버전으로 올릴까요?`
        : `아직 학교에 배포된 버전이 없어요. 이 PC의 jple(v${mine})을 배포해 두면, 다음 버전부터 모든 PC가 저절로 바뀌어요.`,
      detail: 'DB 관리 → 업데이트 배포에서 이 버전의 설치 파일을 골라 주세요. 나중에 하려면 언제든 DB 관리에서 할 수 있어요.',
    })
    if (response === 0) { showWidget(); win?.webContents.send('ui:open-db') }
  }
}
ipcMain.handle('update:status', async () => ({ ...updater.status(), distributed: (await updater.check())?.version ?? '' }))
ipcMain.handle('update:publish', async (_, adminId, adminPassword) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '배포할 jple 설치 파일 고르기', filters: [{ name: 'jple 설치 파일', extensions: ['exe'] }], properties: ['openFile'],
  })
  if (canceled || !filePaths?.length) return { canceled: true }
  return updater.publish(filePaths[0], adminId, adminPassword)
})

// ── 대기 서버: 관리자가 DB 관리에서 PC를 골라 지정 요청 → 이 PC 사용자가 수락하면 대기 서버가 돼요 ──
async function askStandby(priority) {
  // 위젯은 다른 창 뒤에 있으니, 확인 창은 따로 맨 앞에 띄워요
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['수락', '거절'], defaultId: 0, cancelId: 1, title: 'jple 대기 서버',
    message: `관리자가 이 PC를 대기 서버 ${priority}로 지정하려고 해요. 수락할까요?`,
    detail: '수락하면 이 PC에 일정 DB가 복제되고, 주 서버가 꺼지면 이 PC가 대신 일해요.\n이 PC는 늘 켜 두어야 하고, 윈도우와 함께 jple이 켜져요.\n"액세스 허용" 창이 뜨면 허용을 눌러 주세요.',
  })
  return response === 0
}
function applyStandby(st) {
  const cur = settings.server
  if (cur?.enabled && cur.role !== 'standby') return // 주 서버 PC는 대기 서버가 되지 않아요
  if (st) {
    const same = cur?.enabled && cur.priority === st.priority && cur.key === st.key &&
      cur.primary?.host === st.primary.host && cur.primary?.port === st.primary.port
    if (same) return
    settings.server = { enabled: true, port: DEFAULT_PORT, role: 'standby', priority: st.priority, primary: st.primary, key: st.key }
    saveSettings()
    if (st.tls) saveCert(certFile(), st.tls) // 주 서버와 같은 인증서를 써요
    if (app.isPackaged) setAutoStart(true) // 대기 서버 PC는 윈도우와 함께 켜져야 해요
    localServer?.close()
    startLocalServer().then(() => { serverError = null }, (e) => { serverError = e.message; localServer = null })
    new Notification({ title: 'jple 대기 서버', body: `관리자가 이 PC를 대기 서버 ${st.priority}로 정했어요. 이 PC는 켜 두어 주세요.` }).show()
  } else if (cur?.enabled) {
    settings.server.enabled = false
    saveSettings()
    localServer?.close()
    localServer = null
    keepAwake(false)
    new Notification({ title: 'jple 대기 서버', body: '관리자가 이 PC를 대기 서버에서 뺐어요.' }).show()
  }
}
// 처음 설정의 "이 PC를 서버로 시작": 관리자 비밀번호로 admin 계정과 부서 20개를 만들고, 이 PC를 서버로 정해요
ipcMain.handle('server:start', async (_, adminPassword) => {
  try {
    const srv = createServer({ dbPath: serverDbPath(), port: DEFAULT_PORT, version: app.getVersion() })
    srv.initialize(adminPassword)
    srv.close()
  } catch (e) {
    return { error: e.message }
  }
  settings.server = { enabled: true, port: DEFAULT_PORT, role: 'primary' }
  settings.db = { type: 'local', host: '127.0.0.1', port: DEFAULT_PORT }
  saveSettings()
  if (app.isPackaged) setAutoStart(true) // 서버 PC는 윈도우와 함께 켜져야 해요
  app.relaunch()
  app.exit(0)
})

ipcMain.handle('server:info', () => {
  if (!settings.server?.enabled) return { enabled: false }
  const port = settings.server.port ?? DEFAULT_PORT
  const ips = lanAddresses()
  return { enabled: true, port, ips, running: Boolean(localServer), code: makeCode({ type: 'local', host: serverAddress(), port, fp: settings.db?.fp }) }
})
ipcMain.handle('db:make-code', (_, conn) => makeCode(conn))
ipcMain.handle('app:copy-text', (_, text) => { clipboard.writeText(String(text)) })
ipcMain.handle('db:read-code', (_, code) => readCode(code))

// 연결을 바꾸면 앱을 다시 켜서 새 DB로 접속해요. 빈 값이면 연결을 지우고 처음 설정 화면으로 가요
ipcMain.handle('db:set-connection', (_, conn) => {
  if (conn?.type === 'local' && conn.host) settings.db = { type: 'local', host: String(conn.host).trim(), port: Number(conn.port) || DEFAULT_PORT, fp: conn.fp }
  else settings.db = conn?.url && conn?.key ? { url: conn.url.trim(), key: conn.key.trim() } : undefined
  // 다른 곳에 연결하면 이 PC는 더 이상 서버가 아니에요 (서버 DB 파일은 그대로 남겨 둬요)
  if (settings.server?.enabled && !(settings.db?.type === 'local' && settings.db.host === '127.0.0.1')) settings.server.enabled = false
  saveSettings()
  app.relaunch()
  app.exit(0)
})

// 새 DB 만들 때 필요한 표 만들기 SQL과 관리자 함수 코드를 클립보드에 복사해요
ipcMain.handle('db:copy-setup', (_, which) => {
  const file = which === 'sql' ? ['supabase', 'schema.sql'] : ['supabase', 'functions', 'admin-users', 'index.ts']
  clipboard.writeText(fs.readFileSync(path.join(app.getAppPath(), ...file), 'utf8'))
  return { ok: true }
})
ipcMain.handle('db:open-site', (_, url) => shell.openExternal(url || 'https://supabase.com/dashboard'))

// ── 새 DB 만들기 마법사: 단계마다 제대로 됐는지 프로그램이 직접 확인해요 ──
ipcMain.handle('db:wizard-check', async (_, step, opts = {}) => {
  const { url, key, password } = opts
  const base = String(url || '').trim().replace(/\/+$/, '')
  const headers = { apikey: key, Authorization: `Bearer ${key}` }
  const get = (p) => fetch(`${base}${p}`, { headers })
  try {
    // 로컬 연결 코드: 서버 PC의 jple 서버가 답하는지 확인해요
    if (step === 'local') {
      const res = await pinnedFetch(opts.fp)(`https://${opts.host}:${opts.port}/api/ping`, { signal: AbortSignal.timeout(4000) })
      const body = await res.json().catch(() => ({}))
      if (body.app !== 'jple') return { error: '그 주소에 jple 서버가 없어요.' }
      return body.ready ? { ok: true } : { error: '서버 준비가 아직 끝나지 않았어요.' }
    }
    if (step === 'url') {
      if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base)) return { error: '주소는 https://영문숫자.supabase.co 모양이어야 해요.' }
      const res = await fetch(`${base}/rest/v1/`)
      return res.status === 404 ? { error: '이 주소의 프로젝트를 찾지 못했어요. 주소를 다시 확인해 주세요.' } : { ok: true }
    }
    if (step === 'key') {
      const res = await get('/rest/v1/categories?select=id&limit=1')
      if (res.status === 401 || res.status === 403) return { error: '공개 키가 맞지 않아요. Publishable key(sb_publishable_…)를 복사해 주세요.' }
      return { ok: true }
    }
    if (step === 'sql') {
      const res = await get('/rest/v1/categories?select=id')
      if (res.status === 404) return { error: '아직 표가 없어요. SQL Editor에 붙여 넣고 Run을 눌러 주세요.' }
      const rows = await res.json().catch(() => [])
      return Array.isArray(rows) ? { ok: true, count: rows.length } : { error: '표를 확인하지 못했어요. SQL을 다시 실행해 주세요.' }
    }
    if (step === 'function') {
      const res = await fetch(`${base}/functions/v1/admin-users`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
      const text = await res.text()
      if (res.status === 404) return { error: '관리자 함수가 아직 없어요. 이름을 admin-users로 해서 Deploy해 주세요.' }
      if (text.includes('로그인이 필요해요')) return { ok: true }
      if (/jwt|authorization/i.test(text)) return { error: '함수 설정에서 "Verify JWT"(JWT 확인)를 꺼 주세요.' }
      return { error: `함수가 예상과 다르게 답했어요 (${res.status}). 코드를 다시 붙여 넣어 주세요.` }
    }
    if (step === 'admin') {
      const res = await fetch(`${base}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com', password }),
      })
      if (res.ok) return { ok: true }
      const body = await res.json().catch(() => ({}))
      if (/confirm/i.test(body.msg ?? body.error_description ?? '')) return { error: '계정을 만들 때 "Auto Confirm User"를 체크해야 해요. 지우고 다시 만들어 주세요.' }
      return { error: '로그인이 안 돼요. admin@example.com 계정이 있는지, 비밀번호가 맞는지 확인해 주세요.' }
    }
  } catch {
    return { error: step === 'local' ? '서버 PC에 연결하지 못했어요. 서버 PC가 켜져 있고 같은 네트워크인지 확인해 주세요.' : '연결하지 못했어요. 인터넷 연결과 주소를 확인해 주세요.' }
  }
  return { error: '알 수 없는 단계예요.' }
})

// 위쪽 바 버튼: 전체화면(다시 누르면 원래 크기), 축소(시계 옆 아이콘으로 다시 열기), 맨 아래로
let beforeFull = null
ipcMain.handle('window:action', (_, action) => {
  if (action === 'full') {
    if (beforeFull) { win.setBounds(beforeFull); beforeFull = null }
    else { beforeFull = win.getBounds(); win.setBounds(screen.getDisplayMatching(beforeFull).workArea) }
    sendToBottom(win)
    return { full: Boolean(beforeFull) }
  }
  // 최소화하는 동안만 작업 표시줄에 나타나서, 거기서 눌러 다시 열 수 있어요
  if (action === 'hide') { win.setSkipTaskbar(false); win.minimize() }
  return {}
})

// 모드를 바꾸면 그 모드에서 마지막으로 두었던 위치와 크기로 창을 옮겨요.
// 처음 바꿀 때(저장된 값이 없을 때)만 지금 위치에서 크기만 바꿔요
ipcMain.handle('window:set-mode', (_, next) => {
  if (next === mode) return
  mode = next
  movedByProgram = Date.now()
  const saved = settings[boundsKey()]
  const { x, y } = win.getBounds()
  const onScreen = saved?.x !== undefined && screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x >= a.x && saved.y >= a.y && saved.x < a.x + a.width && saved.y < a.y + a.height)
  win.setBounds(onScreen ? saved : { x, y, width: saved?.width ?? 1240, height: saved?.height ?? 720 })
  saveSettings()
})

// ── 계정 목록 엑셀: 받기와 올리기 (관리자 설정) ──
const ACCOUNT_HEADER = ['이름', '아이디', '부서명', '관리자(Y/N)', '비밀번호(새로 만들거나 초기화할 때만)']

// categories: 부서명 목록. 엑셀에서 부서명과 관리자 칸을 목록으로 고를 수 있게 해요
ipcMain.handle('accounts:export', async (_, rows, categories = [], fileName = '계정목록.xlsx') => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), fileName),
    filters: [{ name: '엑셀 파일', extensions: ['xlsx'] }],
  })
  if (canceled || !filePath) return { canceled: true }
  const ExcelJS = require('exceljs')
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('계정')
  sheet.addRow(ACCOUNT_HEADER).font = { bold: true }
  rows.forEach((r) => sheet.addRow([r.name, r.login_id, r.category, r.is_admin ? 'Y' : 'N', '']))
  // 부서명 목록은 숨긴 시트에 두고, 부서명 칸(C)과 관리자 칸(D)에 고르기 목록을 붙여요 (500줄까지)
  const list = book.addWorksheet('부서목록', { state: 'hidden' })
  categories.forEach((name) => list.addRow([name]))
  for (let r = 2; r <= 500; r++) {
    if (categories.length) {
      sheet.getCell(r, 3).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`부서목록!$A$1:$A$${categories.length}`],
        showErrorMessage: true, errorTitle: '부서명', error: '목록에 있는 부서명을 골라 주세요.',
      }
    }
    sheet.getCell(r, 4).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Y,N"'] }
    // 관리자가 아닌 사람이 대부분이라, 빈 줄의 관리자 칸은 미리 N으로 채워 둬요
    if (r > rows.length + 1) sheet.getCell(r, 4).value = 'N'
  }
  sheet.columns.forEach((col, i) => { col.width = [12, 16, 16, 12, 34][i] })
  await book.xlsx.writeFile(filePath)
  return { ok: true, filePath }
})

// 올린 엑셀을 읽어서 줄마다 { name, login_id, category, is_admin, password } 로 돌려줘요
ipcMain.handle('accounts:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: '엑셀 파일', extensions: ['xlsx'] }], properties: ['openFile'],
  })
  if (canceled || !filePaths?.length) return { canceled: true }
  const ExcelJS = require('exceljs')
  const book = new ExcelJS.Workbook()
  await book.xlsx.readFile(filePaths[0])
  const sheet = book.worksheets[0]
  const text = (cell) => {
    const v = cell.value
    if (v == null) return ''
    if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((t) => t.text).join('') : ''))
    return String(v)
  }
  const rows = []
  sheet.eachRow((row, i) => {
    if (i === 1) return
    const [name, loginId, category, isAdmin, password] = [1, 2, 3, 4, 5].map((c) => text(row.getCell(c)).trim())
    if (!name && !loginId) return
    rows.push({ row: i, name, login_id: loginId.toLowerCase(), category, is_admin: /^(y|yes|o|예|관리자|true|1)$/i.test(isAdmin), password })
  })
  return { ok: true, rows }
})

// 주간업무 표를 엑셀 파일로 저장해요 (PRD 8장)
ipcMain.handle('export:week', async (_, { title, fileName, header, rows }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), fileName),
    filters: [{ name: '엑셀 파일', extensions: ['xlsx'] }],
  })
  if (canceled || !filePath) return { canceled: true }

  const ExcelJS = require('exceljs')
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('주간업무', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  })
  sheet.mergeCells(1, 1, 1, header.length)
  Object.assign(sheet.getCell(1, 1), { value: title })
  sheet.getCell(1, 1).font = { bold: true, size: 14 }
  sheet.getCell(1, 1).alignment = { horizontal: 'center' }
  sheet.addRow(header).font = { bold: true }
  rows.forEach((row) => sheet.addRow(row))
  sheet.columns.forEach((col, i) => { col.width = i === 0 ? 14 : 26 })
  const thin = { style: 'thin' }
  for (let r = 2; r <= rows.length + 2; r++) {
    sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { top: thin, left: thin, bottom: thin, right: thin }
      cell.alignment = { wrapText: true, vertical: 'top' }
    })
  }
  await book.xlsx.writeFile(filePath)
  return { ok: true, filePath }
})
ipcMain.on('window:resize', (_, w, h) =>
  win.setSize(Math.max(MIN_W, Math.round(w)), Math.max(MIN_H, Math.round(h))))

app.on('second-instance', showWidget)

app.whenReady().then(async () => {
  // 받아 둔 새 버전이 있으면 먼저 설치해요 (설치가 끝나면 새 jple이 저절로 켜져요)
  if (await updater.applyPendingAtStartup().catch(() => false)) return
  // 설치 후 처음 켤 때 자동 실행을 켜 둬요 (PRD 10장). 개발 중에는 켜지 않아요.
  if (!settings.firstRunDone) {
    if (app.isPackaged) setAutoStart(true)
    settings.firstRunDone = true
    saveSettings()
  }
  // 연결 코드 방식 전에 설치해서 쓰던 PC(로그인 기록이 있는 PC)는 그때의 DB 연결을 그대로 이어 줘요
  const legacy = require('./config').legacy
  if (legacy && !settings.db && fs.existsSync(path.join(app.getPath('userData'), 'session.bin'))) {
    settings.db = { ...legacy }
    saveSettings()
  }
  // 이 PC가 로컬 서버면 서버부터 켜요. 포트가 막혀 있으면 화면에 알려요
  if (settings.server?.enabled) {
    await startLocalServer().catch((e) => { serverError = e.message })
  }
  // 이 PC의 이름표 (서버에 "이 PC 켜져 있어요"를 알릴 때 써요)
  if (!settings.pcId) { settings.pcId = require('crypto').randomBytes(16).toString('hex'); saveSettings() }
  setupData((channel) => win?.webContents.send(channel), notifyEvent, settings.db, {
    pc: { pc_id: settings.pcId, pc_name: os.hostname() }, onStandbyRequest: askStandby, onStandby: applyStandby,
    onSignedIn, onUpdateAvailable: () => updater.check().then(refreshTrayMenu),
  })
  // 6시간마다 새 버전을 확인하고, 1시간마다 오늘 백업을 했는지 봐요 (작은 확인 한 번씩이에요)
  setInterval(() => { if (signedIn) updater.check().then(refreshTrayMenu) }, 6 * 60 * 60 * 1000)
  setInterval(dailyBackupTick, 60 * 60 * 1000)
  setTimeout(dailyBackupTick, 60 * 1000)
  createWindow()
  createTray()
})
