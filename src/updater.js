// 자동 업데이트: 관리자가 배포한 설치 파일을 직원 PC가 받아 두었다가, 다음에 jple을 켤 때 조용히 설치해요
// - 배포: 관리자가 설치 파일을 고르면 지금 연결된 DB(로컬 서버 또는 Supabase 보관함)에 올려요
// - 받기: 학교에 배포된 버전이 이 PC보다 새것이면 받아 두고, 확인값(sha512)이 맞을 때만 설치해요
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

// "0.4.1" > "0.4.0" 비교
function newer(a, b) {
  const x = String(a).split('.').map(Number)
  const y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

// app: electron app, dir: 받은 설치 파일을 둘 폴더, getDb(): 지금 DB 연결, notify(제목, 내용)
// progress(퍼센트 또는 null): 받는 동안 진행 정도 (시계 옆 아이콘 설명에 보여 줘요)
function createUpdater({ app, dir, getDb, notify, progress = () => {} }) {
  const readyFile = path.join(dir, 'ready.json')
  const readReady = () => { try { return JSON.parse(fs.readFileSync(readyFile, 'utf8')) } catch { return null } }
  let checking = false
  let distributed = null // 학교에 배포된 버전 정보

  // 받아 둔 설치 파일을 조용히 설치하고 jple을 끝내요. 설치가 끝나면 새 jple이 저절로 켜져요
  // 설치하는 동안은 화면에 아무것도 없어서, 시작할 때 알려 줘요
  function runInstaller(ready) {
    if (!app.isPackaged) {
      notify('jple 업데이트 (개발용)', `설치 파일 ${ready.version}이 준비돼 있어요. 개발용 실행이라 설치는 하지 않아요.`)
      return false
    }
    notify('jple을 새 버전으로 바꾸는 중이에요', `${ready.version} 설치가 끝나면 jple이 저절로 다시 켜져요. 30초~1분쯤 걸려요.`)
    // 알림이 화면에 뜰 틈을 잠깐 준 뒤 설치를 시작해요
    setTimeout(() => {
      spawn(ready.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      app.exit(0)
    }, 1500)
    return true
  }

  return {
    newer,
    // jple을 켤 때 맨 먼저: 받아 둔 새 버전이 있으면 설치해요. 설치하면 true(곧 꺼져요)
    async applyPendingAtStartup() {
      const ready = readReady()
      if (!ready) return false
      if (!newer(ready.version, app.getVersion()) || !fs.existsSync(ready.file) || await sha512File(ready.file) !== ready.sha512) {
        fs.rmSync(dir, { recursive: true, force: true }) // 이미 설치됐거나 망가진 파일은 지워요
        return false
      }
      return runInstaller(ready)
    },
    // 학교에 배포된 버전을 보고, 이 PC보다 새것이면 받아 둬요 (켤 때, 6시간마다, 서버가 새 버전을 알려 올 때)
    async check() {
      const db = getDb()
      if (!db?.updateInfo || checking) return distributed
      checking = true
      try {
        distributed = await db.updateInfo().catch(() => null)
        if (!distributed || !newer(distributed.version, app.getVersion())) return distributed
        if (readReady()?.version === distributed.version) return distributed
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `jple_update_${distributed.version}.exe`)
        notify('jple 새 버전을 받는 중이에요', `${distributed.version}을 받고 있어요. 다 받으면 다시 알려 드릴게요. 그동안 jple은 그대로 쓰시면 돼요.`)
        let last = -1
        await db.downloadUpdate(distributed, file, (got, total) => {
          const pct = total ? Math.floor((got / total) * 100) : 0
          if (pct >= last + 5) { last = pct; progress(pct, distributed.version) } // 5%마다 한 번
        })
        fs.writeFileSync(readyFile, JSON.stringify({ version: distributed.version, file, sha512: distributed.sha512 }))
        notify('jple 새 버전이 준비됐어요', `${distributed.version}으로 바꿀 준비가 됐어요. 다음에 jple을 켤 때 저절로 바뀌어요. 지금 바꾸려면 시계 옆 아이콘 → "지금 업데이트".`)
      } catch (e) {
        console.error('업데이트 확인 실패:', e.message)
      } finally { checking = false; progress(null) }
      return distributed
    },
    ready: () => {
      const r = readReady()
      return r && newer(r.version, app.getVersion()) ? r : null
    },
    installNow() {
      const r = readReady()
      return r ? runInstaller(r) : false
    },
    status: () => ({ appVersion: app.getVersion(), distributed: distributed?.version ?? '', ready: readReady()?.version ?? '' }),
    // 관리자: 설치 파일(jple_설치_버전.exe)을 골라 학교 DB에 올려요
    async publish(filePath, adminId, adminPassword) {
      const db = getDb()
      if (!db?.publishUpdate) return { error: '이 DB에는 배포할 수 없어요.' }
      const fileName = path.basename(filePath)
      const version = fileName.match(/(\d+\.\d+\.\d+)/)?.[1]
      if (!version) return { error: '설치 파일 이름에서 버전을 찾지 못했어요. jple_설치_0.4.1.exe 같은 파일을 골라 주세요.' }
      const now = distributed ?? await db.updateInfo().catch(() => null)
      if (now && !newer(version, now.version)) return { error: `학교에 이미 ${now.version}이 배포돼 있어요. 더 새 버전의 설치 파일을 골라 주세요.` }
      const sha512 = await sha512File(filePath)
      try {
        distributed = await db.publishUpdate({ filePath, version, sha512, fileName }, adminId, adminPassword)
        return { ok: true, version }
      } catch (e) {
        return { error: e.message }
      }
    },
  }
}

module.exports = { createUpdater, newer }
