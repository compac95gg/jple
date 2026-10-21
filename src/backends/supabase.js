// 외부 DB(Supabase)에 연결하는 방법. data.js가 이 함수들을 불러 써요.
// local.js(로컬 서버)와 함수 이름과 모양이 같아서, 화면 코드는 어느 DB인지 몰라도 돼요.
const { createClient, FunctionsHttpError } = require('@supabase/supabase-js')
const config = require('../config')
const fs = require('fs')
const crypto = require('crypto')
const UPDATE_BUCKET = 'jple-updates'
const PART_SIZE = 40 * 1024 * 1024 // Supabase 무료 요금제는 파일 하나 50MB까지라 40MB씩 나눠요

function supabaseBackend({ url, key }, storage) {
  const supabase = createClient(url, key, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  const must = ({ data, error }) => { if (error) throw error; return data }
  let channel = null

  async function myId() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.user.id ?? null
  }
  async function me() {
    const id = await myId()
    return id ? must(await supabase.from('profiles').select('*').eq('id', id).single()) : null
  }

  return {
    type: 'supabase',
    myId,
    me,
    async login(loginId, password) {
      const email = `${String(loginId).trim().toLowerCase()}@${config.emailDomain}`
      must(await supabase.auth.signInWithPassword({ email, password }))
      return me()
    },
    async logout() { await supabase.auth.signOut() },
    async changePassword(password) {
      must(await supabase.auth.updateUser({ password }))
      must(await supabase.rpc('mark_password_changed'))
      return me()
    },
    async load() {
      return {
        categories: must(await supabase.from('categories').select('*').eq('is_hidden', false).order('sort_order')),
        profiles: must(await supabase.from('profiles').select('id, login_id, name, default_category_id, is_admin, is_active').order('name')),
      }
    },
    async profileName(id) {
      const { data } = await supabase.from('profiles').select('name').eq('id', id).single()
      return data?.name ?? null
    },
    async events(from, to) {
      return must(await supabase.from('events').select('*').lte('start_date', to).gte('end_date', from)
        .order('start_date').order('start_time', { nullsFirst: true }))
    },
    async saveEvent(ev) {
      const row = {
        title: ev.title, category_id: ev.category_id, start_date: ev.start_date, end_date: ev.end_date,
        start_time: ev.start_time || null, end_time: ev.end_time || null, location: ev.location || null, memo: ev.memo || null,
      }
      if (ev.id) must(await supabase.from('events').update(row).eq('id', ev.id).select('id').single())
      else must(await supabase.from('events').insert({ ...row, author_id: await myId() }))
    },
    async deleteEvent(id) {
      must(await supabase.from('events').delete().eq('id', id).select('id').single())
    },
    async saveCategory(cat) {
      const row = { name: cat.name, color: cat.color }
      if (cat.sort_order != null) row.sort_order = cat.sort_order
      if (cat.id) must(await supabase.from('categories').update(row).eq('id', cat.id).select('id').single())
      else {
        const { data: last } = await supabase.from('categories').select('sort_order').order('sort_order', { ascending: false }).limit(1)
        must(await supabase.from('categories').insert({ ...row, sort_order: (last?.[0]?.sort_order ?? 0) + 1 }))
      }
    },
    // 일정이나 계정이 쓰고 있는 구분은 지우지 않고 숨겨요 (PRD 6.5)
    async deleteCategory(id) {
      const { error } = await supabase.from('categories').delete().eq('id', id)
      if (!error) return {}
      if (error.code !== '23503') throw error
      must(await supabase.from('categories').update({ is_hidden: true }).eq('id', id).select('id').single())
      return { hidden: true }
    },
    // 관리자 작업은 Edge Function에서 관리자인지 다시 확인한 뒤 처리해요
    async admin(body) {
      const { data, error } = await supabase.functions.invoke('admin-users', { body })
      if (error instanceof FunctionsHttpError) {
        const detail = await error.context.json().catch(() => ({}))
        return { error: detail.error ?? '요청을 처리하지 못했어요.' }
      }
      if (error) throw error
      return { ok: true, ...(typeof data === 'object' ? data : {}) }
    },
    // 관리자 PC의 하루 1번 자동 백업
    async autoBackup() { return this.admin({ action: 'backup_auto' }) },
    // ── 자동 업데이트 (설치 파일은 공개 보관함에 40MB 조각으로) ──
    async updateInfo() {
      const res = await fetch(`${url}/storage/v1/object/public/${UPDATE_BUCKET}/latest.json?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null)
      if (!res?.ok) return null
      return res.json().catch(() => null)
    },
    async downloadUpdate(info, dest, onProgress) {
      const hash = crypto.createHash('sha512')
      const out = fs.createWriteStream(dest)
      let got = 0
      for (const part of info.parts) {
        const res = await fetch(`${url}/storage/v1/object/public/${UPDATE_BUCKET}/${part}`, { signal: AbortSignal.timeout(30 * 60 * 1000) })
        if (!res.ok || !res.body) { out.destroy(); throw new Error('설치 파일을 받지 못했어요.') }
        for await (const chunk of res.body) {
          hash.update(chunk)
          got += chunk.length
          onProgress?.(got, info.size)
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
        }
      }
      await new Promise((r) => out.end(r))
      if (hash.digest('hex') !== info.sha512) { fs.rmSync(dest, { force: true }); throw new Error('받은 설치 파일이 망가졌어요.') }
    },
    async publishUpdate({ filePath, version, sha512, fileName }, adminId, adminPassword) {
      const size = fs.statSync(filePath).size
      const count = Math.ceil(size / PART_SIZE)
      const cred = { admin_id: adminId, admin_password: adminPassword }
      const slots = await this.admin({ action: 'db_update_upload', version, parts: count, ...cred })
      if (slots.error) throw new Error(slots.error)
      const fd = fs.openSync(filePath, 'r')
      try {
        for (let i = 0; i < count; i++) {
          const length = Math.min(PART_SIZE, size - i * PART_SIZE)
          const chunk = Buffer.alloc(length)
          fs.readSync(fd, chunk, 0, length, i * PART_SIZE)
          const res = await fetch(slots.urls[i], { method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' } })
          if (!res.ok) throw new Error(`설치 파일 ${i + 1}번째 조각을 올리지 못했어요 (${res.status}).`)
        }
      } finally { fs.closeSync(fd) }
      const parts = Array.from({ length: count }, (_, i) => `${version}/part${i}`)
      const done = await this.admin({ action: 'db_update_publish', manifest: { version, sha512, size, file_name: fileName, parts }, ...cred })
      if (done.error) throw new Error(done.error)
      return done.update
    },
    // 실시간 반영: onChange(종류 add|update|delete|reset, 일정)
    subscribe(onChange) {
      this.unsubscribe()
      channel = supabase.channel('events')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, (payload) => {
          const kind = { INSERT: 'add', UPDATE: 'update', DELETE: 'delete' }[payload.eventType]
          onChange(kind, kind === 'delete' ? payload.old : payload.new)
        })
        .subscribe()
    },
    unsubscribe() {
      if (channel) supabase.removeChannel(channel)
      channel = null
    },
  }
}

module.exports = { supabaseBackend }
