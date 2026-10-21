// 로컬 DB(서버 PC의 jple 로컬 서버)에 연결하는 방법. supabase.js와 함수 이름과 모양이 같아요.
// 대기 서버가 있으면: 서버가 알려 준 목록(주 서버 → 대기 1 → 대기 2)을 기억해 두었다가,
// 지금 서버가 안 되면 목록 순서대로 "사용 중"인 서버를 찾아 저절로 옮겨 가요.
const fs = require('fs')
const crypto = require('crypto')
const { DEFAULT_PORT } = require('../server/server')
const { pinnedFetch } = require('../tls')

// pc: { pc_id, pc_name } 이 PC의 이름표. 실시간 흐름을 열 때 함께 보내서, 관리자가 대기 서버를 고르는 목록에 나와요
// fp: 서버 인증서 지문 (연결 코드에 들어 있어요). 지문이 맞는 서버하고만 https로 이야기해요
function localBackend({ host, port = DEFAULT_PORT, fp }, storage, pc = null) {
  const net = fp ? pinnedFetch(fp) : fetch
  const scheme = fp ? 'https' : 'http'
  const token = () => storage.getItem('local_token')
  const saved = (() => { try { return JSON.parse(storage.getItem('local_servers') ?? 'null') } catch { return null } })()
  // 처음 연결 코드의 서버가 늘 맨 앞이에요 (저장된 목록은 그 뒤 대기 서버들)
  let servers = [{ host, port }, ...(Array.isArray(saved) ? saved.filter((s) => !(s.host === host && s.port === port)) : [])]
  let current = 0
  let onSwitch = null
  const base = () => `${scheme}://${servers[current].host}:${servers[current].port}`
  let streamAbort = null
  let me = null

  // 서버가 알려 준 서버 목록(주 서버 + 대기 서버)을 기억해요. 지금 붙어 있는 서버는 그대로
  function learnServers(list) {
    const now = servers[current]
    const others = list.filter((x) => x.priority > 0).map(({ host: h, port: p }) => ({ host: h, port: p }))
      .filter((x) => !(x.host === servers[0].host && x.port === servers[0].port))
    servers = [servers[0], ...others]
    current = Math.max(0, servers.findIndex((x) => x.host === now.host && x.port === now.port))
    storage.setItem('local_servers', JSON.stringify(servers.slice(1)))
  }

  // 목록 순서대로 사용 중인 서버를 찾아요. 찾으면 그 서버가 알려 주는 최신 목록을 기억해요
  async function findActive() {
    const before = base()
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i]
      const ping = await net(`${scheme}://${s.host}:${s.port}/api/ping`, { signal: AbortSignal.timeout(2500) })
        .then((r) => r.json()).catch(() => null)
      if (ping?.app !== 'jple' || ping.active === false) continue
      current = i
      if (Array.isArray(ping.servers)) learnServers(ping.servers)
      if (base() !== before) onSwitch?.()
      return true
    }
    return false
  }

  async function call(action, body = {}, retried = false) {
    let res
    try {
      res = await net(`${base()}/api/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token() ?? ''}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
    } catch {
      if (!retried && await findActive()) return call(action, body, true)
      throw new Error('서버에 연결할 수 없어요. 서버 PC가 켜져 있는지 확인해 주세요.')
    }
    const data = await res.json().catch(() => ({}))
    // 대기 중인 서버에 물었으면 사용 중인 서버를 찾아 다시 물어요
    if (res.status === 503 && data.standby) {
      if (!retried && await findActive()) return call(action, body, true)
      throw new Error('서버를 바꾸는 중이에요. 잠시 뒤에 다시 해 주세요.')
    }
    if (!res.ok || data.error) {
      const err = new Error(data.error ?? `서버 오류 (${res.status})`)
      err.status = res.status
      throw err
    }
    return data
  }

  return {
    type: 'local',
    async myId() { return me?.id ?? null },
    async me() {
      if (!token()) return null
      try {
        me = (await call('me')).user
        return me
      } catch (e) {
        if (e.status === 401) { storage.removeItem('local_token'); return null }
        throw e
      }
    },
    async login(loginId, password) {
      const data = await call('login', { login_id: loginId, password })
      storage.setItem('local_token', data.token)
      me = data.user
      return me
    },
    async logout() {
      await call('logout').catch(() => {})
      storage.removeItem('local_token')
      me = null
    },
    async changePassword(password) {
      me = (await call('change_password', { password })).user
      return me
    },
    async load() {
      const { categories, profiles } = await call('load')
      return { categories, profiles }
    },
    async profileName(id) { return (await call('profile_name', { id })).name },
    async events(from, to) { return (await call('events', { from, to })).events },
    async saveEvent(ev) { await call('save_event', { ev }) },
    async deleteEvent(id) { await call('delete_event', { id }) },
    async saveCategory(cat) { await call('category_save', { cat }) },
    async deleteCategory(id) { return call('category_delete', { id }) },
    async admin(body) {
      try { return await call('admin', { body }) } catch (e) { return { error: e.message } }
    },
    // 관리자의 대기 서버 지정 요청에 답해요. 수락하면 대기 서버 설정이 돌아와요
    async standbyAnswer(accept) { return call('standby_answer', { pc_id: pc?.pc_id, accept }) },
    // ── 자동 업데이트 ──
    // 학교에 배포된 버전 정보 { version, sha512, size, file_name } 또는 null
    async updateInfo() { return (await call('update_info')).update ?? null },
    // 배포된 설치 파일을 받아 dest에 저장하고, 확인값이 맞는지 봐요
    async downloadUpdate(info, dest, onProgress) {
      const res = await net(`${base()}/api/update/file`, { headers: { Authorization: `Bearer ${token() ?? ''}` }, signal: AbortSignal.timeout(30 * 60 * 1000) })
      if (!res.ok || !res.body) throw new Error('설치 파일을 받지 못했어요.')
      const hash = crypto.createHash('sha512')
      const out = fs.createWriteStream(dest)
      let got = 0
      for await (const chunk of res.body) {
        hash.update(chunk)
        got += chunk.length
        onProgress?.(got, info.size)
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise((r) => out.end(r))
      if (hash.digest('hex') !== info.sha512) { fs.rmSync(dest, { force: true }); throw new Error('받은 설치 파일이 망가졌어요.') }
    },
    // 관리자: 설치 파일을 서버에 올려 배포해요 (관리자 아이디·비밀번호를 서버가 다시 확인해요)
    async publishUpdate({ filePath, version, sha512, fileName }, adminId, adminPassword) {
      const size = fs.statSync(filePath).size
      const res = await net(`${base()}/api/update/upload`, {
        method: 'PUT', duplex: 'half', body: fs.createReadStream(filePath),
        headers: {
          Authorization: `Bearer ${token() ?? ''}`, 'Content-Length': String(size), 'x-version': version, 'x-sha512': sha512,
          'x-file-name': encodeURIComponent(fileName), 'x-admin-id': encodeURIComponent(adminId), 'x-admin-password': encodeURIComponent(adminPassword),
        },
        signal: AbortSignal.timeout(30 * 60 * 1000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `올리지 못했어요 (${res.status})`)
      return data.update
    },
    // 지금 붙어 있는 서버 (DB 정보에 보여 줘요)
    currentServer() { return { ...servers[current], index: current } },
    // 실시간 반영: 서버가 보내는 알림 흐름(SSE)을 읽어요. 끊기면 3초 뒤, 주 서버부터 다시 찾아 이어요
    subscribe(onChange) {
      this.unsubscribe()
      const controller = new AbortController()
      streamAbort = controller
      // 다른 서버로 옮겨 가면 화면을 다시 불러요
      onSwitch = () => onChange('reset', {})
      const connect = async () => {
        if (controller.signal.aborted) return
        try {
          await findActive()
          const tag = pc ? `?pc=${pc.pc_id}&pc_name=${encodeURIComponent(pc.pc_name)}` : ''
          const res = await net(`${base()}/api/stream${tag}`, { headers: { Authorization: `Bearer ${token() ?? ''}` }, signal: controller.signal })
          if (!res.ok || !res.body) throw new Error('stream')
          const decoder = new TextDecoder()
          let buffer = ''
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true })
            let cut
            while ((cut = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 2)
              const line = block.split('\n').find((l) => l.startsWith('data: '))
              if (!line) continue
              const { type, row } = JSON.parse(line.slice(6))
              if (type === 'SERVERS') { learnServers(row.servers ?? []); continue }
              onChange({ INSERT: 'add', UPDATE: 'update', DELETE: 'delete', RESET: 'reset', STANDBY_REQUEST: 'standby_request', UPDATE_AVAILABLE: 'update_available' }[type], row)
            }
          }
        } catch { /* 서버가 꺼졌거나 연결이 끊겼어요 */ }
        if (!controller.signal.aborted) setTimeout(connect, 3000)
      }
      connect()
    },
    unsubscribe() {
      streamAbort?.abort()
      streamAbort = null
      onSwitch = null
    },
  }
}

module.exports = { localBackend }
