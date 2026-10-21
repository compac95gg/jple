// 관리자 전용 계정 관리: 계정 만들기, 비밀번호 초기화, 기본 구분 바꾸기, 관리자 권한 주기/빼기
// service role 키는 이 함수 안에서만 써요. 앱에는 절대 넣지 않아요 (PRD 12.1).
import { createClient } from 'npm:@supabase/supabase-js@2'
import postgres from 'npm:postgres@3.4.5'

// 아이디를 Supabase 로그인용 이메일로 바꿀 때 쓰는 도메인. 앱의 src/config.js와 같아야 해요.
const EMAIL_DOMAIN = 'example.com'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  // 요청한 사람이 사용 중인 관리자인지 직접 확인해요
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return reply({ error: '로그인이 필요해요.' }, 401)
  const { data: me } = await admin.from('profiles').select('is_admin, is_active').eq('id', user.id).single()
  if (!me?.is_admin || !me.is_active) return reply({ error: '관리자만 할 수 있어요.' }, 403)

  const body = await req.json()

  // ── DB 관리 (백업, 복원, 초기화, 상태). 요청마다 관리자 아이디와 비밀번호를 서버에서 다시 확인해요 ──
  if (String(body.action ?? '').startsWith('db_')) {
    const checkId = String(body.admin_id ?? '').trim().toLowerCase()
    const checker = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: signed, error: wrong } = await checker.auth.signInWithPassword({
      email: `${checkId}@${EMAIL_DOMAIN}`, password: String(body.admin_password ?? ''),
    })
    if (wrong || !signed.user) return reply({ error: '관리자 아이디나 비밀번호가 맞지 않아요.' }, 403)
    const { data: who } = await admin.from('profiles').select('is_admin, is_active').eq('id', signed.user.id).single()
    if (!who?.is_admin || !who.is_active) return reply({ error: '관리자 계정만 DB를 관리할 수 있어요.' }, 403)
    return await dbAction(body, user.id)
  }

  if (body.action === 'create') {
    const loginId = String(body.login_id ?? '').trim().toLowerCase()
    const name = String(body.name ?? '').trim()
    if (!name) return reply({ error: '이름을 적어 주세요.' }, 400)
    if (!/^[a-z0-9._-]{3,30}$/.test(loginId)) {
      return reply({ error: '아이디는 영어 소문자, 숫자, 점(.), 밑줄(_), 빼기(-)로 3~30자예요.' }, 400)
    }
    if (String(body.password ?? '').length < 8) return reply({ error: '처음 비밀번호는 8자 이상이어야 해요.' }, 400)

    const { data, error } = await admin.auth.admin.createUser({
      email: `${loginId}@${EMAIL_DOMAIN}`,
      password: body.password,
      email_confirm: true,
      user_metadata: { login_id: loginId, name, default_category_id: body.default_category_id ?? '' },
    })
    if (error) {
      const taken = /already|registered|exists/i.test(error.message)
      return reply({ error: taken ? '이미 있는 아이디예요.' : error.message }, 400)
    }
    if (body.is_admin) await admin.from('profiles').update({ is_admin: true }).eq('id', data.user.id)
    return reply({ ok: true })
  }

  if (body.action === 'reset_password') {
    if (String(body.password ?? '').length < 8) return reply({ error: '처음 비밀번호는 8자 이상이어야 해요.' }, 400)
    const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password })
    if (error) return reply({ error: error.message }, 400)
    await admin.from('profiles').update({ must_change_password: true }).eq('id', body.user_id)
    await signOutUsers([String(body.user_id)]) // 이미 로그인해 둔 PC도 바로 풀려요
    return reply({ ok: true })
  }

  // 관리자 PC의 하루 1번 자동 백업 (관리자로 로그인한 jple만 부를 수 있어요. 비밀번호는 담지 않아요)
  if (body.action === 'backup_auto') {
    return reply({ ok: true, backup: await makeBackup() })
  }

  // 관리자를 뺀 모든 계정의 비밀번호를 한꺼번에 초기화해요.
  // 중요한 작업이라, 요청한 관리자의 비밀번호를 여기(서버)에서 다시 확인해요
  if (body.action === 'reset_all') {
    if (String(body.password ?? '').length < 8) return reply({ error: '처음 비밀번호는 8자 이상이어야 해요.' }, 400)
    const checker = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error: wrong } = await checker.auth.signInWithPassword({ email: user.email!, password: String(body.admin_password ?? '') })
    if (wrong) return reply({ error: '관리자 비밀번호가 맞지 않아요.' }, 403)

    const { data: targets, error } = await admin.from('profiles').select('id').eq('is_admin', false)
    if (error) return reply({ error: error.message }, 400)
    let done = 0
    const failed: string[] = []
    for (const t of targets ?? []) {
      const { error: e } = await admin.auth.admin.updateUserById(t.id, { password: body.password })
      if (e) { failed.push(e.message); continue }
      await admin.from('profiles').update({ must_change_password: true }).eq('id', t.id)
      done++
    }
    await signOutUsers((targets ?? []).map((t) => t.id))
    return reply({ ok: true, done, failed: failed.length })
  }

  // 엑셀 올리기에서 쓰는 이름, 기본 구분 바꾸기
  if (body.action === 'update') {
    const name = String(body.name ?? '').trim()
    if (!name) return reply({ error: '이름을 적어 주세요.' }, 400)
    const { error } = await admin.from('profiles')
      .update({ name, default_category_id: body.default_category_id || null }).eq('id', body.user_id)
    if (error) return reply({ error: error.message }, 400)
    return reply({ ok: true })
  }

  if (body.action === 'set_category') {
    const { error } = await admin.from('profiles')
      .update({ default_category_id: body.default_category_id || null }).eq('id', body.user_id)
    if (error) return reply({ error: error.message }, 400)
    return reply({ ok: true })
  }

  if (body.action === 'set_admin') {
    if (!body.is_admin) {
      // 관리자가 한 명도 남지 않게 되는 변경은 막아요 (PRD 5장)
      const { count } = await admin.from('profiles')
        .select('id', { count: 'exact', head: true }).eq('is_admin', true).eq('is_active', true)
      if ((count ?? 0) <= 1) return reply({ error: '관리자가 한 명은 남아 있어야 해요.' }, 400)
    }
    const { error } = await admin.from('profiles').update({ is_admin: !!body.is_admin }).eq('id', body.user_id)
    if (error) return reply({ error: error.message }, 400)
    return reply({ ok: true })
  }

  return reply({ error: '알 수 없는 요청이에요.' }, 400)
})

// ── DB 관리 동작 ──
const DEFAULT_CATEGORIES: [string, string][] = [
  ['교무운영', '#4E79A7'], ['교육과정', '#F28E2B'], ['교육연구부', '#E15759'], ['입학홍보', '#76B7B2'],
  ['정보생활지원', '#59A14F'], ['스마트팜과', '#EDC948'], ['바이오식품과', '#B07AA1'], ['직업교육부', '#FF9DA7'],
  ['진로상담부', '#9C755F'], ['현장실습취업부', '#1F77B4'], ['동물자원연구센터', '#2CA02C'], ['반려동물과', '#D62728'],
  ['학생생활안전부', '#9467BD'], ['건강생활부', '#8C564B'], ['행정실', '#E377C2'], ['교감', '#17BECF'],
  ['교장', '#BCBD22'], ['복무', '#7F7F7F'], ['방과후', '#AEC7E8'], ['진행업무', '#FFBB78'],
]

async function counts() {
  const n = async (table: string) => (await admin.from(table).select('*', { count: 'exact', head: true })).count ?? 0
  return { events: await n('events'), profiles: await n('profiles'), categories: await n('categories') }
}

// 백업 파일 내용: 아이디와 부서 이름으로 적어서, 다른 DB에도 그대로 되돌릴 수 있게 해요
async function makeBackup() {
  const { data: categories } = await admin.from('categories').select('*').order('sort_order')
  const { data: profiles } = await admin.from('profiles').select('*')
  const { data: events } = await admin.from('events').select('*').order('start_date')
  const catName = new Map((categories ?? []).map((c) => [c.id, c.name]))
  const loginOf = new Map((profiles ?? []).map((p) => [p.id, p.login_id]))
  return {
    app: 'jple', kind: 'db-backup', version: 1, created_at: new Date().toISOString(),
    categories: (categories ?? []).map((c) => ({ name: c.name, color: c.color, sort_order: c.sort_order, is_hidden: c.is_hidden })),
    accounts: (profiles ?? []).map((p) => ({
      login_id: p.login_id, name: p.name, category: catName.get(p.default_category_id) ?? null, is_admin: p.is_admin, is_active: p.is_active,
    })),
    events: (events ?? []).map((e) => ({
      title: e.title, category: catName.get(e.category_id) ?? null, start_date: e.start_date, end_date: e.end_date,
      start_time: e.start_time, end_time: e.end_time, location: e.location, memo: e.memo,
      repeat: e.repeat, repeat_until: e.repeat_until, author: loginOf.get(e.author_id) ?? null,
    })),
  }
}

// 다른 DB로 옮길 때만 써요. 비밀번호 원문은 어디에도 없고, 암호화된 값만 옮겨요
function sql() {
  return postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
}
async function passwordHashes() {
  const db = sql()
  try {
    const rows = await db`select id, encrypted_password from auth.users`
    return new Map(rows.map((r) => [r.id as string, r.encrypted_password as string]))
  } finally { await db.end() }
}
// 그 사람들이 로그인해 둔 PC를 모두 로그아웃시켜요 (비밀번호 초기화 뒤). 이미 받은 출입증은 길어야 1시간 안에 끝나요
async function signOutUsers(ids: string[]) {
  if (!ids.length) return
  const db = sql()
  try { await db`delete from auth.sessions where user_id = any(${ids}::uuid[])` } finally { await db.end() }
}

// ── 자동 업데이트: 설치 파일을 40MB 조각으로 나눠 공개 보관함에 올려요 (무료 요금제는 파일 하나 50MB까지) ──
const UPDATE_BUCKET = 'jple-updates'
async function ensureUpdateBucket() {
  const { data } = await admin.storage.getBucket(UPDATE_BUCKET)
  if (!data) await admin.storage.createBucket(UPDATE_BUCKET, { public: true, fileSizeLimit: 50 * 1024 * 1024 })
}

async function setPasswordHash(id: string, hash: string) {
  const db = sql()
  try { await db`update auth.users set encrypted_password = ${hash} where id = ${id}` } finally { await db.end() }
}

async function deleteAllEvents() {
  await admin.from('events').delete().not('id', 'is', null)
}

// 관리자가 아닌 계정을 지워요 (일정은 먼저 지워야 해요)
async function deleteNonAdminAccounts() {
  const { data: users } = await admin.from('profiles').select('id').eq('is_admin', false)
  for (const u of users ?? []) await admin.auth.admin.deleteUser(u.id)
  return users?.length ?? 0
}

async function dbAction(body: Record<string, unknown>, callerId: string) {
  if (body.action === 'db_status') {
    return reply({ ok: true, ...(await counts()) })
  }

  if (body.action === 'db_backup') {
    return reply({ ok: true, backup: await makeBackup() })
  }

  // 옮기기 파일 내용: 백업 + 계정마다 암호화된 비밀번호와 "비밀번호 바꾸기 필요"
  // 업데이트 배포 ①: 조각마다 올릴 주소(서명된 주소)를 줘요
  if (body.action === 'db_update_upload') {
    const version = String(body.version ?? '')
    const parts = Number(body.parts)
    if (!/^\d+\.\d+\.\d+$/.test(version) || !(parts >= 1 && parts <= 20)) return reply({ error: '설치 파일 정보가 맞지 않아요.' }, 400)
    await ensureUpdateBucket()
    const urls: string[] = []
    for (let i = 0; i < parts; i++) {
      const { data, error } = await admin.storage.from(UPDATE_BUCKET).createSignedUploadUrl(`${version}/part${i}`, { upsert: true })
      if (error || !data) return reply({ error: error?.message ?? '올릴 주소를 만들지 못했어요.' }, 400)
      urls.push(data.signedUrl)
    }
    return reply({ ok: true, urls })
  }
  // 업데이트 배포 ②: 다 올렸으면 안내 파일(latest.json)을 쓰고, 예전 버전 조각은 지워요
  if (body.action === 'db_update_publish') {
    const m = body.manifest as Record<string, unknown>
    if (!m || !/^\d+\.\d+\.\d+$/.test(String(m.version)) || !/^[a-f0-9]{128}$/.test(String(m.sha512))) return reply({ error: '설치 파일 정보가 맞지 않아요.' }, 400)
    const manifest = {
      version: String(m.version), sha512: String(m.sha512), size: Number(m.size), file_name: String(m.file_name ?? ''),
      parts: (m.parts as string[]).map(String), uploaded_at: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' })
    const { error } = await admin.storage.from(UPDATE_BUCKET).upload('latest.json', blob, { upsert: true, cacheControl: '60' })
    if (error) return reply({ error: error.message }, 400)
    const { data: folders } = await admin.storage.from(UPDATE_BUCKET).list('')
    for (const f of folders ?? []) {
      if (f.name === 'latest.json' || f.name === manifest.version) continue
      const { data: files } = await admin.storage.from(UPDATE_BUCKET).list(f.name)
      if (files?.length) await admin.storage.from(UPDATE_BUCKET).remove(files.map((x) => `${f.name}/${x.name}`))
    }
    return reply({ ok: true, update: manifest })
  }

  if (body.action === 'db_move_out') {
    const backup = await makeBackup()
    const hashes = await passwordHashes()
    const { data: profiles } = await admin.from('profiles').select('id, login_id, must_change_password')
    const byLogin = new Map((profiles ?? []).map((p) => [p.login_id, p]))
    for (const a of backup.accounts as Record<string, unknown>[]) {
      const p = byLogin.get(a.login_id as string)
      if (!p) continue
      a.password_hash = hashes.get(p.id) ?? null
      a.must_change_password = p.must_change_password
    }
    return reply({ ok: true, backup: { ...backup, move: true } })
  }

  if (body.action === 'db_reset') {
    const scope = String(body.scope)
    if (!['events', 'accounts', 'all'].includes(scope)) return reply({ error: '초기화 범위를 골라 주세요.' }, 400)
    await deleteAllEvents()
    let removed = 0
    if (scope === 'accounts' || scope === 'all') removed = await deleteNonAdminAccounts()
    if (scope === 'all') {
      // 부서를 처음 20개로 되돌려요. 관리자 계정의 기본 부서는 비워요
      await admin.from('profiles').update({ default_category_id: null }).not('id', 'is', null)
      await admin.from('categories').delete().not('id', 'is', null)
      await admin.from('categories').insert(DEFAULT_CATEGORIES.map(([name, color], i) => ({ name, color, sort_order: i + 1 })))
    }
    return reply({ ok: true, removedAccounts: removed, ...(await counts()) })
  }

  if (body.action === 'db_restore' || body.action === 'db_move_in') {
    // deno-lint-ignore no-explicit-any
    const b = body.backup as any
    if (!b || b.kind !== 'db-backup') return reply({ error: 'jple 백업 파일이 아니에요.' }, 400)
    const move = body.action === 'db_move_in'
    if (move && !b.move) return reply({ error: '옮기기 파일이 아니에요.' }, 400)
    const password = String(body.default_password ?? '')
    const report = { categories: 0, accountsCreated: 0, accountsUpdated: 0, events: 0, skipped: 0 }

    // 1) 부서: 이름이 같으면 색과 순서를 맞추고, 없으면 만들어요
    const { data: cats } = await admin.from('categories').select('id, name')
    const catId = new Map((cats ?? []).map((c) => [c.name, c.id]))
    for (const c of b.categories) {
      if (catId.has(c.name)) {
        await admin.from('categories').update({ color: c.color, sort_order: c.sort_order, is_hidden: c.is_hidden }).eq('id', catId.get(c.name))
      } else {
        const { data } = await admin.from('categories').insert({ name: c.name, color: c.color, sort_order: c.sort_order, is_hidden: c.is_hidden }).select('id').single()
        if (data) catId.set(c.name, data.id)
      }
      report.categories++
    }

    // 2) 계정: 없는 아이디는 기본 처음 비밀번호로 만들어요 (비밀번호는 백업에 없어요)
    const { data: profs } = await admin.from('profiles').select('id, login_id')
    const userId = new Map((profs ?? []).map((p) => [p.login_id, p.id]))
    // 옮기기: 비밀번호를 암호화된 값 그대로 넣어서, 모두 쓰던 비밀번호로 로그인해요
    const moveAccount = async (id: string, a: Record<string, unknown>) => {
      await setPasswordHash(id, a.password_hash as string)
      await admin.from('profiles').update({
        name: a.name, is_admin: a.is_admin, is_active: a.is_active !== false, must_change_password: Boolean(a.must_change_password),
        default_category_id: a.category ? catId.get(a.category as string) ?? null : null,
      }).eq('id', id)
    }
    for (const a of b.accounts) {
      const hashed = move && typeof a.password_hash === 'string' && a.password_hash.startsWith('$2')
      if (userId.has(a.login_id)) {
        if (hashed) { await moveAccount(userId.get(a.login_id), a); report.accountsUpdated++ }
        continue
      }
      if (!hashed && password.length < 8) { report.skipped++; continue }
      const { data, error } = await admin.auth.admin.createUser({
        email: `${a.login_id}@${EMAIL_DOMAIN}`, password: hashed ? crypto.randomUUID() : password, email_confirm: true,
        user_metadata: { login_id: a.login_id, name: a.name, default_category_id: a.category ? catId.get(a.category) ?? '' : '' },
      })
      if (error || !data.user) { report.skipped++; continue }
      if (hashed) await moveAccount(data.user.id, a)
      else await admin.from('profiles').update({ is_admin: a.is_admin, must_change_password: true }).eq('id', data.user.id)
      userId.set(a.login_id, data.user.id)
      report.accountsCreated++
    }

    // 3) 일정: 지금 일정을 모두 지우고 백업의 일정으로 바꿔요. 작성자가 없으면 복원하는 관리자 이름으로 넣어요
    await deleteAllEvents()
    const fallbackCat = catId.values().next().value
    // deno-lint-ignore no-explicit-any
    const rows = b.events.map((e: any) => ({
      title: e.title, category_id: (e.category && catId.get(e.category)) ?? fallbackCat,
      start_date: e.start_date, end_date: e.end_date, start_time: e.start_time, end_time: e.end_time,
      location: e.location, memo: e.memo, repeat: e.repeat ?? 'none', repeat_until: e.repeat_until,
      author_id: (e.author && userId.get(e.author)) ?? callerId,
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from('events').insert(rows.slice(i, i + 500))
      if (!error) report.events += rows.slice(i, i + 500).length
    }
    return reply({ ok: true, report, ...(await counts()) })
  }

  return reply({ error: '알 수 없는 DB 요청이에요.' }, 400)
}
