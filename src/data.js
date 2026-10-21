// DB와 주고받는 일은 모두 여기(메인 프로세스)에서 해요.
// 화면(렌더러)은 IPC로 요청만 하고, 로그인 정보는 화면에 넘기지 않아요.
// 연결 종류에 따라 외부 DB(backends/supabase.js) 또는 로컬 서버(backends/local.js)를 써요. 둘은 쓰는 법이 같아요.
const { app, ipcMain, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const { supabaseBackend } = require('./backends/supabase')
const { localBackend } = require('./backends/local')

let db = null
let standbyHooks = {}

// 로그인 세션은 윈도우 계정으로 암호화해서 PC에 저장해요 (safeStorage = DPAPI)
function sessionStorage() {
  const file = path.join(app.getPath('userData'), 'session.bin')
  const read = () => {
    try {
      const raw = fs.readFileSync(file)
      return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString())
    } catch { return {} }
  }
  const write = (obj) => {
    const text = JSON.stringify(obj)
    fs.writeFileSync(file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text)
  }
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) => write({ ...read(), [key]: value }),
    removeItem: (key) => { const all = read(); delete all[key]; write(all) },
  }
}

// 오류 메시지를 사용자가 알아듣는 말로 바꿔요
function friendly(error) {
  const msg = error?.message ?? String(error)
  if (/Invalid login credentials/i.test(msg)) return '아이디나 비밀번호가 맞지 않아요.'
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) return '인터넷 연결을 확인해 주세요.'
  if (/should be different/i.test(msg)) return '지금 비밀번호와 다른 비밀번호를 써 주세요.'
  if (/row-level security|permission denied/i.test(msg)) return '이 일을 할 권한이 없어요.'
  // update/delete 결과가 0줄이면 RLS에 막혔거나 이미 지워진 일정이에요
  if (/coerce the result to a single JSON object/i.test(msg)) return '이 일을 할 권한이 없거나, 이미 지워진 일정이에요.'
  return msg
}

// IPC 처리기에서 오류가 나면 { error } 로 돌려줘요
const handle = (channelName, fn) => ipcMain.handle(channelName, async (_, ...args) => {
  try { return await fn(...args) } catch (e) { return { error: friendly(e) } }
})

// 알림용 기억: 화면에 불러온 일정(지워진 일정의 제목을 알려 주려고), 내가 방금 고치거나 지운 일정
const knownEvents = new Map()
const myRecentChanges = new Map()
const changedByMe = (id) => Date.now() - (myRecentChanges.get(id) ?? 0) < 15000

function startRealtime(notify, eventNotice) {
  db.subscribe(async (kind, row) => {
    // 관리자가 이 PC를 대기 서버로 지정하려고 해요: 이 PC 사용자에게 묻고, 수락하면 대기 서버가 돼요
    // 관리자가 새 버전을 배포했어요: 받아 둬요
    if (kind === 'update_available') return standbyHooks.onUpdateAvailable?.()
    if (kind === 'standby_request') {
      const accept = await standbyHooks.onStandbyRequest?.(row.priority)
      const res = await db.standbyAnswer(Boolean(accept)).catch(() => null)
      if (accept && res?.standby) standbyHooks.onStandby?.(res.standby)
      return
    }
    notify('events:changed')
    if (kind === 'reset' || !eventNotice) return
    // 다른 사람이 일정을 넣거나 고치거나 지우면 화면 오른쪽 아래에 알림을 띄워요 (내가 한 것은 빼요)
    const ev = kind === 'delete' ? (knownEvents.get(row.id) ?? row) : row
    if (kind === 'delete') knownEvents.delete(row.id)
    else knownEvents.set(ev.id, ev)
    if (kind === 'add' ? ev.author_id === await db.myId() : changedByMe(ev.id)) return
    const name = ev.author_id ? (await db.profileName(ev.author_id).catch(() => null)) : null
    eventNotice(kind, name ?? '누군가', ev)
  })
}

// notify(채널): 화면에 "다시 불러와" 신호
// eventNotice(종류 add|update|delete, 작성자 이름, 일정): 다른 사람이 바꾼 일정 알림
// connection: 이 PC에 저장된 연결. { type: 'local', host, port } 또는 { url, key }(외부 Supabase).
//             없으면 처음 설정 화면(연결 코드 넣기, 새 DB 만들기, 이 PC를 서버로)을 띄워요
// pc: { pc_id, pc_name } 이 PC의 이름표 (로컬 DB의 실시간 흐름에 함께 보내요)
// onStandbyRequest(대기 번호) → 수락하면 true, onStandby(대기 서버 설정): 수락 뒤 이 PC를 대기 서버로
// onSignedIn(계정): 로그인돼 있을 때 (업데이트 확인, 관리자 자동 백업), onUpdateAvailable(): 새 버전이 배포됐을 때
function setupData(notify, eventNotice, connection, { pc, onStandbyRequest, onStandby, onSignedIn, onUpdateAvailable } = {}) {
  const storage = sessionStorage()
  standbyHooks = { onStandbyRequest, onStandby, onUpdateAvailable }
  if (connection?.type === 'local' && connection.host) db = localBackend(connection, storage, pc)
  else if (connection?.url && connection?.key) db = supabaseBackend(connection, storage)
  const configured = Boolean(db)

  handle('auth:state', async () => {
    if (!configured) return { configured: false }
    const profile = await db.me()
    if (profile && !profile.is_active) { await db.logout(); return { configured, user: null } }
    if (profile) { startRealtime(notify, eventNotice); onSignedIn?.(profile) }
    return { configured, user: profile, dbType: db.type }
  })

  handle('auth:login', async (loginId, password) => {
    const profile = await db.login(loginId, password)
    if (!profile.is_active) { await db.logout(); return { error: '사용이 중지된 계정이에요. 관리자에게 물어보세요.' } }
    startRealtime(notify, eventNotice)
    onSignedIn?.(profile)
    return { user: profile }
  })

  handle('auth:logout', async () => {
    db.unsubscribe()
    await db.logout()
    return { ok: true }
  })

  handle('auth:change-password', async (password) => {
    if (String(password).length < 8) return { error: '비밀번호는 8자 이상이어야 해요.' }
    return { user: await db.changePassword(password) }
  })

  handle('data:load', () => db.load())

  handle('data:events', async (from, to) => {
    const events = await db.events(from, to)
    events.forEach((ev) => knownEvents.set(ev.id, ev))
    return { events }
  })

  handle('data:save-event', async (ev) => {
    if (ev.id) myRecentChanges.set(ev.id, Date.now())
    await db.saveEvent(ev)
    return { ok: true }
  })

  handle('data:delete-event', async (id) => {
    myRecentChanges.set(id, Date.now())
    await db.deleteEvent(id)
    return { ok: true }
  })

  // 구분 관리 (관리자만 가능)
  handle('category:save', async (cat) => { await db.saveCategory(cat); return { ok: true } })
  handle('category:delete', async (id) => ({ ok: true, ...(await db.deleteCategory(id)) }))

  // 관리자 작업 (외부: Edge Function, 로컬: 서버가 관리자인지 다시 확인해요)
  handle('admin:call', (body) => db.admin(body))
}

// 지금 DB 연결 (업데이트, 자동 백업에서 써요)
const currentDb = () => db

module.exports = { setupData, currentDb }
