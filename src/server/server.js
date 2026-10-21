// jple 로컬 서버: 서버 PC의 jple 안에서 돌아가는 작은 DB 서버예요.
// - DB: SQLite (Electron에 들어 있는 node:sqlite, 따로 설치할 것 없음, 저작권 제약 없음)
// - 통신: HTTPS(JSON, 스스로 만든 인증서 + 연결 코드의 지문으로 확인) + 실시간 반영은 SSE(서버가 보내는 알림 흐름)
// - 권한: Supabase의 RLS와 같은 규칙을 여기서 직접 검사해요
//   (모두 일정 보기, 일정은 자기 이름으로만 입력, 고치기·지우기는 작성자와 관리자, 부서와 계정 관리는 관리자)
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DatabaseSync } = require('node:sqlite')
const bcrypt = require('bcryptjs')
const { fingerprint, pinnedFetch } = require('../tls')

const SESSION_DAYS = 90 // 이 기간 동안 한 번도 안 쓰면 로그인이 풀려요
const LOCK_TRIES = 5 // 비밀번호를 이만큼 연속으로 틀리면
const LOCK_MINUTES = 5 // 이 시간 동안 그 아이디를 막아요
const TICK_MS = 10000 // 서버끼리 안부를 묻는 간격 (3번 연속 대답이 없으면 대기 서버가 넘겨받아요)

const DEFAULT_PORT = 47820
const DEFAULT_CATEGORIES = [
  ['교무운영', '#4E79A7'], ['교육과정', '#F28E2B'], ['교육연구부', '#E15759'], ['입학홍보', '#76B7B2'],
  ['정보생활지원', '#59A14F'], ['스마트팜과', '#EDC948'], ['바이오식품과', '#B07AA1'], ['직업교육부', '#FF9DA7'],
  ['진로상담부', '#9C755F'], ['현장실습취업부', '#1F77B4'], ['동물자원연구센터', '#2CA02C'], ['반려동물과', '#D62728'],
  ['학생생활안전부', '#9467BD'], ['건강생활부', '#8C564B'], ['행정실', '#E377C2'], ['교감', '#17BECF'],
  ['교장', '#BCBD22'], ['복무', '#7F7F7F'], ['방과후', '#AEC7E8'], ['진행업무', '#FFBB78'],
]

// 대기 서버로 복제하는 표 (넣는 순서대로. 지울 때는 거꾸로)
const REPLICATED = ['categories', 'profiles', 'events', 'sessions', 'standbys', 'app_update']

class Fail extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4E79A7',
      sort_order INTEGER NOT NULL DEFAULT 0, is_hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      default_category_id INTEGER REFERENCES categories(id), is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id),
      start_date TEXT NOT NULL, end_date TEXT NOT NULL, start_time TEXT, end_time TEXT, location TEXT, memo TEXT,
      repeat TEXT NOT NULL DEFAULT 'none', repeat_until TEXT, author_id TEXT NOT NULL REFERENCES profiles(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS events_dates ON events (start_date, end_date);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0, repl_key TEXT NOT NULL);
    INSERT OR IGNORE INTO meta (id, version, repl_key) VALUES (1, 0, lower(hex(randomblob(24))));
    CREATE TABLE IF NOT EXISTS standbys (priority INTEGER PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS app_update (
      id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, sha512 TEXT NOT NULL, size INTEGER NOT NULL,
      file_name TEXT NOT NULL, uploaded_at TEXT NOT NULL DEFAULT (datetime('now')));
  `)
  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name)
  if (!sessionCols.includes('last_used')) db.exec("ALTER TABLE sessions ADD COLUMN last_used TEXT NOT NULL DEFAULT ''")
  const cols = db.prepare('PRAGMA table_info(standbys)').all().map((c) => c.name)
  if (!cols.includes('pc_id')) db.exec('ALTER TABLE standbys ADD COLUMN pc_id TEXT')
  if (!cols.includes('pc_name')) db.exec('ALTER TABLE standbys ADD COLUMN pc_name TEXT')
  const metaCols = db.prepare('PRAGMA table_info(meta)').all().map((c) => c.name)
  if (!metaCols.includes('stamp')) db.exec("ALTER TABLE meta ADD COLUMN stamp TEXT NOT NULL DEFAULT ''")
  for (const table of REPLICATED) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`DROP TRIGGER IF EXISTS bump_${table}_${op};
               CREATE TRIGGER bump_${table}_${op} AFTER ${op} ON ${table}
               BEGIN UPDATE meta SET version = version + 1, stamp = lower(hex(randomblob(8))) WHERE id = 1; END;`)
    }
  }
  return db
}

// ── 바깥으로 내보내는 모양 (Supabase와 같은 모양으로 맞춰서 화면 코드를 그대로 써요) ──
const bool = (v) => Boolean(v)
const publicProfile = (p) => p && ({
  id: p.id, login_id: p.login_id, name: p.name, default_category_id: p.default_category_id,
  is_admin: bool(p.is_admin), is_active: bool(p.is_active), must_change_password: bool(p.must_change_password),
})
const publicCategory = (c) => ({ ...c, is_hidden: bool(c.is_hidden) })

// tls: { key, cert } 있으면 https, 없으면 http(시험용). 서버끼리도 같은 인증서 지문으로 확인해요
// updateDir: 관리자가 배포한 설치 파일을 두는 폴더
// cluster: { priority(0=주 서버, 1·2=대기 서버), primary: {host, port}, replKey, pcId, selfAddress(), onRemoved(), onPrimaryMoved({host, port}) }
function createServer({ dbPath, port = DEFAULT_PORT, version = '', cluster = {}, tls = null, updateDir = null }) {
  const db = openDb(dbPath)
  const q = (sql) => db.prepare(sql)
  const streams = new Map() // 실시간 흐름 → { pc_id, name, host, login }
  const me = cluster.priority ?? 0
  const scheme = tls ? 'https' : 'http'
  const peerFetchRaw = tls ? pinnedFetch(fingerprint(tls.cert)) : fetch
  // 주 서버 주소: 주 서버는 관리자가 고른 자기 주소, 대기 서버는 주 서버가 안부를 물어 올 때 그 주소를 따라가요
  let primaryAddr = cluster.primary ?? { host: '127.0.0.1', port }
  const primaryNow = () => (me === 0 && cluster.selfAddress ? { host: cluster.selfAddress(), port } : primaryAddr)
  if (cluster.replKey) q('UPDATE meta SET repl_key = ? WHERE id = 1').run(cluster.replKey)
  // 사용 중(active)인 서버만 일정을 받아요. 대기 서버는 복제만 하다가, 주 서버가 꺼지면 사용 중이 돼요
  // 주 서버 PC 자신은 대기 서버 후보 목록에서 빼요
  const selfHosts = () => cluster.selfHosts ?? [primaryNow().host, '127.0.0.1']
  // 비밀번호 틀린 횟수 (아이디별, 서버 메모리에만)
  const failures = new Map()
  const pending = new Map() // 대기 서버 지정 요청을 보낸 PC → 대기 번호 (그 PC 사용자가 수락하기 전)
  let active = false
  let downTicks = 0
  const reports = new Map() // 나에게 물어 온 다른 서버: 대기 번호 → { host, port, version, seen }
  let loopTimer = null
  const meta = () => q('SELECT version, stamp, repl_key FROM meta WHERE id = 1').get()

  const count = (table) => q(`SELECT count(*) AS n FROM ${table}`).get().n
  const isEmpty = () => count('profiles') === 0

  // 처음 서버를 시작할 때: 부서 20개와 관리자(admin) 계정을 만들어요
  function initialize(adminPassword) {
    if (!isEmpty()) return
    if (String(adminPassword).length < 8) throw new Fail('관리자 비밀번호는 8자 이상이어야 해요.')
    if (count('categories') === 0) seedCategories()
    q(`INSERT INTO profiles (id, login_id, name, is_admin, must_change_password, password_hash)
       VALUES (?, 'admin', 'admin', 1, 0, ?)`).run(crypto.randomUUID(), bcrypt.hashSync(adminPassword, 10))
  }
  function seedCategories() {
    const ins = q('INSERT INTO categories (name, color, sort_order) VALUES (?, ?, ?)')
    DEFAULT_CATEGORIES.forEach(([name, color], i) => ins.run(name, color, i + 1))
  }

  // ── 대기 서버: 복제와 자동 전환 ──
  // 서버 목록: 주 서버(0) + 대기 서버(1, 2). 직원 PC는 이 목록 순서대로 사용 중인 서버를 찾아요
  const serverList = () => [{ priority: 0, ...primaryNow() },
    ...q('SELECT priority, host, port, pc_name FROM standbys ORDER BY priority').all()]
  function snapshot() {
    const tables = {}
    for (const t of REPLICATED) tables[t] = q(`SELECT * FROM ${t}`).all()
    return { version: meta().version, stamp: meta().stamp, tables }
  }
  function applySnapshot(snap) {
    db.exec('BEGIN')
    try {
      for (const t of [...REPLICATED].reverse()) q(`DELETE FROM ${t}`).run()
      for (const t of REPLICATED) {
        for (const row of snap.tables[t] ?? []) {
          const cols = Object.keys(row)
          q(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]))
        }
      }
      q('UPDATE meta SET version = ?, stamp = ? WHERE id = 1').run(snap.version, snap.stamp ?? '')
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  function becomeActive() { active = true; downTicks = 0 }
  // 사용 중을 그만둘 때: 연결된 위젯들의 실시간 흐름을 끊어서, 사용 중인 서버를 다시 찾게 해요
  function stepDown() {
    active = false
    for (const res of streams.keys()) res.end()
    streams.clear()
  }
  const peerFetch = (peer, path, init = {}) => peerFetchRaw(`${scheme}://${peer.host}:${peer.port}/api/repl/${path}`, {
    ...init, headers: { 'x-jple-key': meta().repl_key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(init.timeout ?? 2000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null)

  async function tick() {
    const peers = serverList().filter((sv) => sv.priority !== me)
    const seen = await Promise.all(peers.map(async (peer) => ({ ...peer, r: await peerFetch(peer, `version?port=${port}&priority=${me}&version=${meta().version}`) })))
    const higher = seen.filter((sv) => sv.priority < me && sv.r)
    const activeHigher = higher.find((sv) => sv.r.active)
    const activeLower = seen.find((sv) => sv.priority > me && sv.r?.active)
    if (active) {
      if (activeHigher) stepDown() // 우선순위가 높은 서버가 이미 사용 중이면 물러나요
      return
    }
    if (activeHigher) {
      // 사용 중인 서버를 따라 복제해요 (버전이 다르면 전체를 받아요. 일정이 수천 건이어도 1초 안팎이에요)
      downTicks = 0
      if (activeHigher.r.stamp !== meta().stamp) {
        const snap = await peerFetch(activeHigher, 'snapshot', { timeout: 15000 })
        if (snap) {
          applySnapshot(snap)
          const mine = cluster.pcId && q('SELECT 1 FROM standbys WHERE priority = ? AND pc_id = ?').get(me, cluster.pcId)
          if (me > 0 && cluster.pcId && !mine) return cluster.onRemoved?.()
        }
      }
      await ensureUpdateFile(activeHigher)
      return
    }
    if (activeLower) {
      // 우선순위가 낮은 서버가 대신 일하고 있으면: 그동안의 내용을 넘겨받고 다시 사용 중이 돼요 (주 서버 자동 복귀)
      const snap = await peerFetch(activeLower, 'handover', { method: 'POST', body: '{}', timeout: 15000 })
      if (!snap) return
      // 빈 내용(계정이 하나도 없음)은 받지 않아요. 내 내용을 그대로 쓰고 사용 중이 돼요
      if (snap.tables?.profiles?.length) applySnapshot(snap)
      becomeActive()
      await ensureUpdateFile(activeLower)
      return
    }
    // 아무도 사용 중이 아니에요: 주 서버는 바로, 대기 서버는 위 서버가 6초 넘게 안 보이면 사용 중이 돼요
    // 한 번도 복제받지 못한 빈 대기 서버는 넘겨받지 않아요 (빈 DB로 일하면 안 돼요)
    if (higher.length === 0 && (me === 0 || ++downTicks >= 3)) {
      // 넘겨받기 전에: 다른 대기 서버가 나보다 최신이면 그 내용부터 받아요 (주 서버가 꺼지기 직전 복제가 서로 달랐을 때)
      const candidates = [
        ...seen.filter((sv) => sv.r).map((sv) => ({ host: sv.host, port: sv.port, version: sv.r.version })),
        ...[...reports.values()].filter((x) => Date.now() - x.seen < TICK_MS * 3),
      ]
      const fresher = candidates.filter((x) => x.version > meta().version).sort((x, y) => y.version - x.version)[0]
      if (fresher) {
        const snap = await peerFetch(fresher, 'snapshot', { timeout: 15000 })
        if (snap?.tables?.profiles?.length) applySnapshot(snap)
      }
      if (!isEmpty()) becomeActive()
    }
  }
  // 2초마다 둘러봐요. 사용 중인 서버가 "바뀌었어요"라고 알려 오면 바로 한 번 더 봐요
  let running = false
  let again = false
  let closed = false
  async function loop() {
    clearTimeout(loopTimer)
    if (running) { again = true; return }
    running = true
    try { await tick() } catch { /* 다음 차례에 다시 해요 */ }
    running = false
    if (again) { again = false; return loop() }
    if (!closed) loopTimer = setTimeout(loop, TICK_MS)
  }
  // 일정 등이 바뀌면 대기 서버들에 바로 알려요 (바뀔 때만 보내요)
  function pokeStandbys() {
    for (const sv of serverList()) if (sv.priority !== me) peerFetch(sv, 'poke', { method: 'POST', body: '{}', timeout: 1500 })
  }

  // 다른 서버가 복제 열쇠로 부르는 주소들
  function replRequest(req, res, url) {
    if (req.headers['x-jple-key'] !== meta().repl_key) return send(res, 403, { error: '복제 열쇠가 맞지 않아요.' })
    const name = url.pathname.slice('/api/repl/'.length)
    if (name === 'version') {
      // 사용 중인 서버가 대기 서버의 주소를 기억해요 (직원 PC에 서버 목록으로 알려 줘요)
      const pr = Number(url.searchParams.get('priority'))
      const fromHost = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      const fromPort = Number(url.searchParams.get('port')) || DEFAULT_PORT
      if (pr >= 0 && pr <= 2 && pr !== me) {
        reports.set(pr, { priority: pr, host: fromHost, port: fromPort, version: Number(url.searchParams.get('version')) || 0, seen: Date.now() })
      }
      // 주 서버의 주소가 바뀌었어요(예: 공유기가 새 주소를 줌): 대기 서버는 새 주소를 따라가요
      if (pr === 0 && me > 0 && (primaryAddr.host !== fromHost || primaryAddr.port !== fromPort)) {
        primaryAddr = { host: fromHost, port: fromPort }
        cluster.onPrimaryMoved?.(primaryAddr)
        setImmediate(loop)
      }
      if (active && (pr === 1 || pr === 2)) {
        const host = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
        const pt = Number(url.searchParams.get('port')) || DEFAULT_PORT
        const old = q('SELECT host, port FROM standbys WHERE priority = ?').get(pr)
        if (old && (old.host !== host || old.port !== pt)) {
          q('UPDATE standbys SET host = ?, port = ? WHERE priority = ?').run(host, pt, pr)
          broadcast('SERVERS', { servers: serverList() })
        }
      }
      return send(res, 200, { version: meta().version, stamp: meta().stamp, active, priority: me })
    }
    if (name === 'snapshot') return send(res, 200, snapshot())
    if (name === 'update-file') return sendUpdateFile(res)
    if (name === 'poke' && req.method === 'POST') {
      setImmediate(loop)
      return send(res, 200, { ok: true })
    }
    if (name === 'handover' && req.method === 'POST') {
      stepDown()
      return send(res, 200, snapshot())
    }
    send(res, 404, { error: '없는 주소예요.' })
  }

  // ── 자동 업데이트 설치 파일 ──
  // 설치 파일은 updateDir/jple_update.exe 하나만 두고, 버전과 확인값(sha512)은 app_update 표에 적어요(대기 서버로 복제)
  const updateFile = () => updateDir && path.join(updateDir, 'jple_update.exe')
  const updateRow = () => q('SELECT version, sha512, size, file_name, uploaded_at FROM app_update WHERE id = 1').get() ?? null
  // 이 서버에 있는 설치 파일의 확인값 (117MB를 매번 다시 계산하지 않게 옆에 적어 둬요)
  function localUpdateSha() {
    try { return fs.readFileSync(`${updateFile()}.sha512`, 'utf8').trim() } catch { return '' }
  }
  function sendUpdateFile(res) {
    const row = updateRow()
    if (!row || !updateDir || localUpdateSha() !== row.sha512) return send(res, 404, { error: '배포된 설치 파일이 없어요.' })
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': row.size })
    fs.createReadStream(updateFile()).pipe(res)
  }
  // 관리자가 올리는 설치 파일을 받아요. 다 받은 뒤 확인값이 맞을 때만 배포해요
  function receiveUpdate(req, res, token) {
    const fail = (status, error) => { req.resume(); send(res, status, { error }) }
    try {
      const user = userFromToken(token)
      if (!user?.is_admin) return fail(403, '관리자만 배포할 수 있어요.')
      const who = checkPassword(decodeURIComponent(req.headers['x-admin-id'] ?? ''), decodeURIComponent(req.headers['x-admin-password'] ?? ''))
      if (!who?.is_admin) return fail(403, '관리자 아이디나 비밀번호가 맞지 않아요.')
    } catch (e) { return fail(e.status ?? 500, e.message) }
    const ver = String(req.headers['x-version'] ?? '')
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'jple_update.exe'))
    const expected = String(req.headers['x-sha512'] ?? '')
    if (!/^\d+\.\d+\.\d+$/.test(ver) || !/^[a-f0-9]{128}$/.test(expected)) return fail(400, '설치 파일 정보가 맞지 않아요.')
    if (!updateDir) return fail(500, '설치 파일을 둘 곳이 없어요.')
    fs.mkdirSync(updateDir, { recursive: true })
    const tmp = `${updateFile()}.part`
    const out = fs.createWriteStream(tmp)
    const hash = crypto.createHash('sha512')
    let size = 0
    req.on('data', (chunk) => { hash.update(chunk); size += chunk.length })
    req.pipe(out)
    out.on('finish', () => {
      const sha = hash.digest('hex')
      if (sha !== expected) { fs.rmSync(tmp, { force: true }); return send(res, 400, { error: '설치 파일이 올라오다 망가졌어요. 다시 해 주세요.' }) }
      fs.renameSync(tmp, updateFile())
      fs.writeFileSync(`${updateFile()}.sha512`, sha)
      q(`INSERT OR REPLACE INTO app_update (id, version, sha512, size, file_name, uploaded_at)
         VALUES (1, ?, ?, ?, ?, datetime('now'))`).run(ver, sha, size, fileName)
      send(res, 200, { ok: true, update: updateRow() })
      pokeStandbys()
      broadcast('UPDATE_AVAILABLE', updateRow())
    })
    out.on('error', (e) => send(res, 500, { error: `설치 파일을 저장하지 못했어요: ${e.message}` }))
  }
  // 대기 서버: 표에 적힌 설치 파일이 나에게 없으면 사용 중인 서버에서 받아 와요
  async function ensureUpdateFile(peer) {
    const row = updateRow()
    if (!row || !updateDir || localUpdateSha() === row.sha512) return
    const res = await peerFetchRaw(`${scheme}://${peer.host}:${peer.port}/api/repl/update-file`, {
      headers: { 'x-jple-key': meta().repl_key }, signal: AbortSignal.timeout(10 * 60 * 1000),
    }).catch(() => null)
    if (!res?.ok || !res.body) return
    fs.mkdirSync(updateDir, { recursive: true })
    const tmp = `${updateFile()}.part`
    const hash = crypto.createHash('sha512')
    const out = fs.createWriteStream(tmp)
    for await (const chunk of res.body) { hash.update(chunk); out.write(chunk) }
    await new Promise((r) => out.end(r))
    const sha = hash.digest('hex')
    if (sha !== row.sha512) { fs.rmSync(tmp, { force: true }); return }
    fs.renameSync(tmp, updateFile())
    fs.writeFileSync(`${updateFile()}.sha512`, sha)
  }

  // ── 실시간 반영: 일정이 바뀌면 연결된 모든 위젯에 알려요 ──
  function broadcast(type, row) {
    const text = `data: ${JSON.stringify({ type, row })}\n\n`
    for (const res of streams.keys()) res.write(text)
  }

  // ── 로그인 확인 ──
  // 로그인 기록은 마지막으로 쓴 날부터 90일 동안 유효해요. 쓴 날짜는 하루에 한 번만 고쳐 적어요(복제가 잦지 않게)
  function userFromToken(token) {
    if (!token) return null
    const row = q(`SELECT p.*, s.created_at AS s_created, s.last_used AS s_used FROM sessions s
                   JOIN profiles p ON p.id = s.user_id WHERE s.token = ?`).get(token)
    if (!row) return null
    const used = Date.parse(`${String(row.s_used || row.s_created).replace(" ", "T")}Z`)
    const day = 24 * 60 * 60 * 1000
    if (Date.now() - used > SESSION_DAYS * day) {
      q('DELETE FROM sessions WHERE token = ?').run(token)
      return null
    }
    if (Date.now() - used > day) q("UPDATE sessions SET last_used = datetime('now') WHERE token = ?").run(token)
    return row.is_active ? row : null
  }
  // 비밀번호 확인. 같은 아이디로 5번 연속 틀리면 5분 동안 그 아이디를 막아요
  function checkPassword(loginId, password) {
    const id = String(loginId ?? '').trim().toLowerCase()
    const f = failures.get(id)
    if (f?.until > Date.now()) {
      const min = Math.ceil((f.until - Date.now()) / 60000)
      throw new Fail(`비밀번호를 ${LOCK_TRIES}번 틀렸어요. ${min}분 뒤에 다시 해 주세요.`, 429)
    }
    const user = q('SELECT * FROM profiles WHERE login_id = ?').get(id)
    if (!user || !bcrypt.compareSync(String(password ?? ''), user.password_hash)) {
      const tries = (f?.until ? 0 : f?.tries ?? 0) + 1
      failures.set(id, tries >= LOCK_TRIES ? { tries: 0, until: Date.now() + LOCK_MINUTES * 60000 } : { tries })
      return null
    }
    failures.delete(id)
    return user
  }
  const needAdmin = (user) => { if (!user.is_admin) throw new Fail('관리자만 할 수 있어요.', 403) }

  // ── 일정 ──
  function cleanEvent(ev) {
    const title = String(ev.title ?? '').trim()
    if (!title) throw new Fail('제목을 적어 주세요.')
    if (!q('SELECT id FROM categories WHERE id = ?').get(ev.category_id)) throw new Fail('구분을 골라 주세요.')
    const date = /^\d{4}-\d{2}-\d{2}$/
    if (!date.test(ev.start_date) || !date.test(ev.end_date) || ev.end_date < ev.start_date) throw new Fail('날짜를 확인해 주세요.')
    return [title, ev.category_id, ev.start_date, ev.end_date, ev.start_time || null, ev.end_time || null,
      ev.location || null, ev.memo || null]
  }
  const getEvent = (id) => q('SELECT * FROM events WHERE id = ?').get(id)
  const canEdit = (user, ev) => user.is_admin || ev.author_id === user.id

  // ── 계정 ──
  function createAccount({ login_id, name, password, default_category_id, is_admin }, mustChange = true, passwordHash) {
    const loginId = String(login_id ?? '').trim().toLowerCase()
    const cleanName = String(name ?? '').trim()
    if (!cleanName) throw new Fail('이름을 적어 주세요.')
    if (!/^[a-z0-9._-]{3,30}$/.test(loginId)) throw new Fail('아이디는 영어 소문자, 숫자, 점(.), 밑줄(_), 빼기(-)로 3~30자예요.')
    if (!passwordHash && String(password ?? '').length < 8) throw new Fail('처음 비밀번호는 8자 이상이어야 해요.')
    if (q('SELECT id FROM profiles WHERE login_id = ?').get(loginId)) throw new Fail('이미 있는 아이디예요.')
    const id = crypto.randomUUID()
    q(`INSERT INTO profiles (id, login_id, name, default_category_id, is_admin, must_change_password, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, loginId, cleanName, default_category_id || null, is_admin ? 1 : 0,
      mustChange ? 1 : 0, passwordHash || bcrypt.hashSync(password, 10))
    return id
  }
  function activeAdminCount() {
    return q('SELECT count(*) AS n FROM profiles WHERE is_admin = 1 AND is_active = 1').get().n
  }

  // ── DB 관리 (백업 파일 모양은 Supabase 쪽과 같아서 서로 옮길 수 있어요) ──
  // withPasswords: 다른 DB로 옮길 때만 암호화된 비밀번호(bcrypt 값)와 "비밀번호 바꾸기 필요"도 담아요
  function makeBackup(withPasswords = false) {
    const categories = q('SELECT * FROM categories ORDER BY sort_order').all()
    const profiles = q('SELECT * FROM profiles').all()
    const events = q('SELECT * FROM events ORDER BY start_date').all()
    const catName = new Map(categories.map((c) => [c.id, c.name]))
    const loginOf = new Map(profiles.map((p) => [p.id, p.login_id]))
    return {
      app: 'jple', kind: 'db-backup', version: 1, created_at: new Date().toISOString(),
      categories: categories.map((c) => ({ name: c.name, color: c.color, sort_order: c.sort_order, is_hidden: bool(c.is_hidden) })),
      accounts: profiles.map((p) => ({
        login_id: p.login_id, name: p.name, category: catName.get(p.default_category_id) ?? null,
        is_admin: bool(p.is_admin), is_active: bool(p.is_active),
        ...(withPasswords ? { password_hash: p.password_hash, must_change_password: bool(p.must_change_password) } : {}),
      })),
      events: events.map((e) => ({
        title: e.title, category: catName.get(e.category_id) ?? null, start_date: e.start_date, end_date: e.end_date,
        start_time: e.start_time, end_time: e.end_time, location: e.location, memo: e.memo,
        repeat: e.repeat, repeat_until: e.repeat_until, author: loginOf.get(e.author_id) ?? null,
      })),
    }
  }
  function dbAction(body, caller) {
    const who = checkPassword(body.admin_id, body.admin_password)
    if (!who) throw new Fail('관리자 아이디나 비밀번호가 맞지 않아요.', 403)
    if (!who.is_admin || !who.is_active) throw new Fail('관리자 계정만 DB를 관리할 수 있어요.', 403)
    const counts = () => ({ events: count('events'), profiles: count('profiles'), categories: count('categories') })

    if (body.action === 'db_status') return { ...counts(), local: true }
    if (body.action === 'db_backup') return { backup: makeBackup() }
    if (body.action === 'db_move_out') return { backup: { ...makeBackup(true), move: true } }
    // 서버 구성: 지금 jple이 연결돼 있는 PC 목록(실시간 흐름이 열린 PC)과 대기 서버
    if (body.action === 'db_cluster') {
      const assigned = new Map(q('SELECT priority, pc_id FROM standbys').all().map((r) => [r.pc_id, r.priority]))
      const list = new Map()
      for (const pc of streams.values()) {
        if (!pc.pc_id || selfHosts().includes(pc.host)) continue
        list.set(pc.pc_id, { pc_id: pc.pc_id, name: pc.name, host: pc.host, login: pc.login, standby: assigned.get(pc.pc_id) ?? 0, pending: pending.get(pc.pc_id) ?? 0 })
      }
      return { pcs: [...list.values()].sort((x, y) => x.name.localeCompare(y.name)), servers: serverList() }
    }
    // 관리자가 PC를 골라 대기 서버 1·2로 지정 요청을 보내요. 그 PC 화면에 확인 창이 뜨고, 수락해야 대기 서버가 돼요
    if (body.action === 'db_standby_assign') {
      const n = Number(body.priority)
      if (n !== 1 && n !== 2) throw new Fail('대기 서버는 1번과 2번만 있어요.')
      const target = [...streams.entries()].filter(([, pc]) => pc.pc_id === String(body.pc_id))
      if (!target.length) throw new Fail('그 PC가 지금 연결돼 있지 않아요. 그 PC에서 jple을 켜고 로그인해 주세요.')
      if (selfHosts().includes(target[0][1].host)) throw new Fail('주 서버 PC는 대기 서버가 될 수 없어요.')
      pending.set(target[0][1].pc_id, n)
      const text = `data: ${JSON.stringify({ type: 'STANDBY_REQUEST', row: { priority: n } })}\n\n`
      for (const [res] of target) res.write(text)
      return { pending: true }
    }
    // 지정 해제: 대기 서버는 복제하면서 이 목록을 받으니, 자기가 빠진 것을 보고 스스로 그만둬요
    if (body.action === 'db_standby_remove') {
      q('DELETE FROM standbys WHERE priority = ?').run(Number(body.priority))
      broadcast('SERVERS', { servers: serverList() })
      return { servers: serverList() }
    }

    if (body.action === 'db_reset') {
      const scope = String(body.scope)
      if (!['events', 'accounts', 'all'].includes(scope)) throw new Fail('초기화 범위를 골라 주세요.')
      let removed = 0
      db.exec('BEGIN')
      try {
        q('DELETE FROM events').run()
        if (scope !== 'events') removed = q('DELETE FROM profiles WHERE is_admin = 0').run().changes
        if (scope === 'all') {
          q('UPDATE profiles SET default_category_id = NULL').run()
          q('DELETE FROM categories').run()
          seedCategories()
        }
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
      broadcast('RESET', {})
      return { removedAccounts: removed, ...counts() }
    }

    if (body.action === 'db_restore' || body.action === 'db_move_in') {
      const b = body.backup
      if (!b || b.kind !== 'db-backup') throw new Fail('jple 백업 파일이 아니에요.')
      const move = body.action === 'db_move_in'
      if (move && !b.move) throw new Fail('옮기기 파일이 아니에요.')
      const password = String(body.default_password ?? '')
      const report = { categories: 0, accountsCreated: 0, accountsUpdated: 0, events: 0, skipped: 0 }
      db.exec('BEGIN')
      try {
        const catId = new Map(q('SELECT id, name FROM categories').all().map((c) => [c.name, c.id]))
        for (const c of b.categories ?? []) {
          if (catId.has(c.name)) {
            q('UPDATE categories SET color = ?, sort_order = ?, is_hidden = ? WHERE id = ?').run(c.color, c.sort_order, c.is_hidden ? 1 : 0, catId.get(c.name))
          } else {
            const r = q('INSERT INTO categories (name, color, sort_order, is_hidden) VALUES (?, ?, ?, ?)').run(c.name, c.color, c.sort_order, c.is_hidden ? 1 : 0)
            catId.set(c.name, Number(r.lastInsertRowid))
          }
          report.categories++
        }
        const userId = new Map(q('SELECT id, login_id FROM profiles').all().map((p) => [p.login_id, p.id]))
        for (const a of b.accounts ?? []) {
          if (userId.has(a.login_id)) {
            if (move && a.password_hash) {
              q(`UPDATE profiles SET name = ?, default_category_id = ?, is_admin = ?, is_active = ?, must_change_password = ?, password_hash = ?
                 WHERE id = ?`).run(a.name, a.category ? catId.get(a.category) ?? null : null, a.is_admin ? 1 : 0, a.is_active === false ? 0 : 1,
                a.must_change_password ? 1 : 0, a.password_hash, userId.get(a.login_id))
              report.accountsUpdated++
            }
            continue
          }
          // 옮기기용 백업에는 암호화된 비밀번호가 들어 있을 수 있어요(2단계). 없으면 기본 처음 비밀번호로 만들어요
          if (!a.password_hash && password.length < 8) { report.skipped++; continue }
          const id = createAccount({ login_id: a.login_id, name: a.name, password, default_category_id: a.category ? catId.get(a.category) : null, is_admin: a.is_admin },
            a.password_hash ? Boolean(a.must_change_password) : true, a.password_hash)
          if (a.is_active === false) q('UPDATE profiles SET is_active = 0 WHERE id = ?').run(id)
          userId.set(a.login_id, id)
          report.accountsCreated++
        }
        q('DELETE FROM events').run()
        const fallbackCat = catId.values().next().value
        const ins = q(`INSERT INTO events (id, title, category_id, start_date, end_date, start_time, end_time, location, memo, repeat, repeat_until, author_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const e of b.events ?? []) {
          ins.run(crypto.randomUUID(), e.title, (e.category && catId.get(e.category)) ?? fallbackCat, e.start_date, e.end_date,
            e.start_time ?? null, e.end_time ?? null, e.location ?? null, e.memo ?? null, e.repeat ?? 'none', e.repeat_until ?? null,
            (e.author && userId.get(e.author)) ?? caller.id)
          report.events++
        }
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
      broadcast('RESET', {})
      return { report, ...counts() }
    }
    throw new Fail('알 수 없는 DB 요청이에요.')
  }

  // 관리자 작업 (Supabase 쪽 Edge Function admin-users와 같은 동작)
  function adminAction(body, user) {
    needAdmin(user)
    if (String(body.action ?? '').startsWith('db_')) return dbAction(body, user)
    const findUser = (id) => { const u = q('SELECT * FROM profiles WHERE id = ?').get(id); if (!u) throw new Fail('계정을 찾지 못했어요.'); return u }

    switch (body.action) {
      case 'create':
        createAccount(body)
        return {}
      case 'reset_password':
        if (String(body.password ?? '').length < 8) throw new Fail('처음 비밀번호는 8자 이상이어야 해요.')
        findUser(body.user_id)
        q('UPDATE profiles SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(body.password, 10), body.user_id)
        q('DELETE FROM sessions WHERE user_id = ?').run(body.user_id)
        return {}
      case 'set_category':
        findUser(body.user_id)
        q('UPDATE profiles SET default_category_id = ? WHERE id = ?').run(body.default_category_id || null, body.user_id)
        return {}
      case 'update': {
        const name = String(body.name ?? '').trim()
        if (!name) throw new Fail('이름을 적어 주세요.')
        findUser(body.user_id)
        q('UPDATE profiles SET name = ?, default_category_id = ? WHERE id = ?').run(name, body.default_category_id || null, body.user_id)
        return {}
      }
      case 'set_admin':
        findUser(body.user_id)
        if (!body.is_admin && activeAdminCount() <= 1) throw new Fail('관리자가 한 명은 남아 있어야 해요.')
        q('UPDATE profiles SET is_admin = ? WHERE id = ?').run(body.is_admin ? 1 : 0, body.user_id)
        return {}
      case 'reset_all': {
        if (String(body.password ?? '').length < 8) throw new Fail('처음 비밀번호는 8자 이상이어야 해요.')
        if (!checkPassword(user.login_id, body.admin_password)) throw new Fail('관리자 비밀번호가 맞지 않아요.', 403)
        const hash = bcrypt.hashSync(body.password, 10)
        const targets = q('SELECT id FROM profiles WHERE is_admin = 0').all()
        for (const t of targets) {
          q('UPDATE profiles SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, t.id)
          q('DELETE FROM sessions WHERE user_id = ?').run(t.id)
        }
        return { done: targets.length, failed: 0 }
      }
      default:
        throw new Fail('알 수 없는 요청이에요.')
    }
  }

  // ── 요청 처리 ──
  // 대기 서버 지정 요청에 그 PC 사용자가 답해요. 수락하면 대기 서버 목록에 넣고 복제 설정을 줘요
  function standbyAnswer(body) {
    const pcId = String(body.pc_id ?? '')
    const n = pending.get(pcId)
    if (!n) throw new Fail('지정 요청이 없거나 이미 끝났어요.')
    pending.delete(pcId)
    if (!body.accept) return { standby: null }
    const pc = [...streams.values()].find((x) => x.pc_id === pcId)
    const host = pc?.host ?? body.__host
    db.exec('BEGIN')
    try {
      q('DELETE FROM standbys WHERE pc_id = ? OR priority = ?').run(pcId, n)
      q('INSERT INTO standbys (priority, host, port, pc_id, pc_name) VALUES (?, ?, ?, ?, ?)').run(n, host, DEFAULT_PORT, pcId, pc?.name ?? '')
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    broadcast('SERVERS', { servers: serverList() })
    // 대기 서버는 주 서버와 같은 인증서를 써요 (직원 PC가 지문 하나로 세 서버를 모두 믿을 수 있게)
    return { standby: { priority: n, primary: primaryNow(), key: meta().repl_key, tls } }
  }

  function handle(action, body, user) {
    if (action === 'login') {
      const found = checkPassword(body.login_id, body.password)
      if (!found) throw new Fail('아이디나 비밀번호가 맞지 않아요.', 401)
      if (!found.is_active) throw new Fail('사용이 중지된 계정이에요. 관리자에게 물어보세요.', 403)
      const token = crypto.randomBytes(32).toString('base64url')
      q("INSERT INTO sessions (token, user_id, last_used) VALUES (?, ?, datetime('now'))").run(token, found.id)
      return { token, user: publicProfile(found) }
    }
    if (!user) throw new Fail('로그인이 필요해요.', 401)

    switch (action) {
      case 'standby_answer':
        return standbyAnswer(body)
      case 'update_info':
        return { update: updateRow() }
      case 'me':
        return { user: publicProfile(user) }
      case 'logout':
        q('DELETE FROM sessions WHERE token = ?').run(body.__token)
        return {}
      case 'change_password': {
        if (String(body.password ?? '').length < 8) throw new Fail('비밀번호는 8자 이상이어야 해요.')
        if (bcrypt.compareSync(body.password, user.password_hash)) throw new Fail('지금 비밀번호와 다른 비밀번호를 써 주세요.')
        q('UPDATE profiles SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(body.password, 10), user.id)
        return { user: publicProfile(q('SELECT * FROM profiles WHERE id = ?').get(user.id)) }
      }
      case 'load':
        return {
          categories: q('SELECT * FROM categories WHERE is_hidden = 0 ORDER BY sort_order').all().map(publicCategory),
          profiles: q('SELECT * FROM profiles ORDER BY name').all().map(publicProfile),
        }
      case 'profile_name':
        return { name: q('SELECT name FROM profiles WHERE id = ?').get(body.id)?.name ?? null }
      case 'events':
        return { events: q('SELECT * FROM events WHERE start_date <= ? AND end_date >= ? ORDER BY start_date, start_time').all(body.to, body.from) }
      case 'save_event': {
        const values = cleanEvent(body.ev)
        if (body.ev.id) {
          const old = getEvent(body.ev.id)
          if (!old || !canEdit(user, old)) throw new Fail('이 일을 할 권한이 없거나, 이미 지워진 일정이에요.', 403)
          q(`UPDATE events SET title = ?, category_id = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?,
             location = ?, memo = ?, updated_at = datetime('now') WHERE id = ?`).run(...values, old.id)
          broadcast('UPDATE', getEvent(old.id))
          return {}
        }
        const id = crypto.randomUUID()
        q(`INSERT INTO events (title, category_id, start_date, end_date, start_time, end_time, location, memo, id, author_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values, id, user.id)
        broadcast('INSERT', getEvent(id))
        return {}
      }
      case 'delete_event': {
        const old = getEvent(body.id)
        if (!old || !canEdit(user, old)) throw new Fail('이 일을 할 권한이 없거나, 이미 지워진 일정이에요.', 403)
        q('DELETE FROM events WHERE id = ?').run(old.id)
        broadcast('DELETE', { id: old.id })
        return {}
      }
      case 'category_save': {
        needAdmin(user)
        const c = body.cat
        if (!String(c.name ?? '').trim()) throw new Fail('구분 이름을 적어 주세요.')
        if (c.id) {
          q('UPDATE categories SET name = ?, color = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?').run(c.name, c.color, c.sort_order ?? null, c.id)
        } else {
          const last = q('SELECT max(sort_order) AS m FROM categories').get().m ?? 0
          q('INSERT INTO categories (name, color, sort_order) VALUES (?, ?, ?)').run(c.name, c.color, last + 1)
        }
        return {}
      }
      case 'category_delete': {
        needAdmin(user)
        const used = q('SELECT 1 FROM events WHERE category_id = ? UNION SELECT 1 FROM profiles WHERE default_category_id = ? LIMIT 1').get(body.id, body.id)
        if (used) { q('UPDATE categories SET is_hidden = 1 WHERE id = ?').run(body.id); return { hidden: true } }
        q('DELETE FROM categories WHERE id = ?').run(body.id)
        return {}
      }
      case 'admin':
        return adminAction(body.body ?? {}, user)
      default:
        throw new Fail('알 수 없는 요청이에요.', 404)
    }
  }

  const send = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  const onRequest = (req, res) => {
    const url = new URL(req.url, 'http://local')
    const token = (req.headers.authorization ?? '').replace('Bearer ', '') || url.searchParams.get('token')

    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return send(res, 200, { app: 'jple', server: true, version, ready: !isEmpty(), active, priority: me, servers: serverList() })
    }
    if (url.pathname.startsWith('/api/repl/')) return replRequest(req, res, url)
    if (!active) return send(res, 503, { error: '대기 중인 서버예요.', standby: true })

    // 자동 업데이트: 관리자가 설치 파일을 올리고(관리자 비밀번호 확인), 직원 PC는 로그인한 상태로 내려받아요
    if (url.pathname === '/api/update/upload' && req.method === 'PUT') return receiveUpdate(req, res, token)
    if (url.pathname === '/api/update/file' && req.method === 'GET') {
      if (!userFromToken(token)) return send(res, 401, { error: '로그인이 필요해요.' })
      return sendUpdateFile(res)
    }

    // 실시간 반영 흐름: 로그인한 위젯만 연결할 수 있어요
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      if (!userFromToken(token)) return send(res, 401, { error: '로그인이 필요해요.' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      // 맨 먼저 서버 목록(주 서버 + 대기 서버)을 보내요
      res.write(`data: ${JSON.stringify({ type: 'SERVERS', row: { servers: serverList() } })}\n\n`)
      const who = userFromToken(token)
      streams.set(res, {
        pc_id: /^[a-f0-9]{32,64}$/.test(url.searchParams.get('pc') ?? '') ? url.searchParams.get('pc') : '',
        name: String(url.searchParams.get('pc_name') ?? '').slice(0, 60) || '이름 없는 PC',
        host: String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), login: who.name,
      })
      const beat = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => { clearInterval(beat); streams.delete(res) })
      return
    }

    const match = url.pathname.match(/^\/api\/([a-z_]+)$/)
    if (req.method !== 'POST' || !match) return send(res, 404, { error: '없는 주소예요.' })
    readBody(req, (body) => {
      try {
        body.__token = token
        body.__host = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
        const before = meta().stamp
        send(res, 200, { ok: true, ...handle(match[1], body, userFromToken(token)) })
        if (meta().stamp !== before) pokeStandbys()
      } catch (e) {
        send(res, e.status ?? 500, { error: e instanceof Fail ? e.message : `서버 오류: ${e.message}` })
      }
    })
  }
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, onRequest) : http.createServer(onRequest)
  function readBody(req, done) {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 20 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      let body
      try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
      done(body)
    })
  }

  return {
    initialize,
    isEmpty,
    // 켜자마자 한 번 둘러보고(사용 중인 서버가 있는지) 2초마다 다시 봐요
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '0.0.0.0', async () => {
        await loop()
        resolve(port)
      })
    }),
    status: () => ({ active, priority: me, version: meta().version, stamp: meta().stamp, servers: serverList() }),
    // 매일 자동 백업용 (사용 중인 서버만 해요)
    backup: () => makeBackup(),
    fingerprint: () => (tls ? fingerprint(tls.cert) : ''),
    close: () => {
      closed = true
      clearTimeout(loopTimer)
      for (const res of streams.keys()) res.end()
      if (server.listening) server.close()
      db.close()
    },
  }
}

module.exports = { createServer, DEFAULT_PORT }
