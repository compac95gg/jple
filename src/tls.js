// 로컬 서버의 https 인증서와 지문
// - 서버 PC가 처음 켜질 때 스스로 인증서를 만들어요(10년). 대기 서버도 주 서버와 같은 인증서를 받아 써요.
// - 직원 PC는 연결 코드에 든 "지문"과 서버 인증서의 지문이 같은지 보고, 같을 때만 이야기해요.
const fs = require('fs')
const crypto = require('crypto')
const { Agent, buildConnector, fetch } = require('undici')

async function loadOrCreateCert(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved.key && saved.cert) return saved
  } catch { /* 없으면 새로 만들어요 */ }
  const selfsigned = require('selfsigned')
  const notAfterDate = new Date()
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10)
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'jple-server' }], { keyType: 'ec', algorithm: 'sha256', notAfterDate })
  const cert = { key: pems.private, cert: pems.cert }
  saveCert(file, cert)
  return cert
}

function saveCert(file, cert) {
  fs.writeFileSync(file, JSON.stringify({ key: cert.key, cert: cert.cert }))
}

// 인증서 지문 (SHA-256, 소문자 16진수 64자)
const fingerprint = (certPem) => new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase()

// 지문이 맞는 서버하고만 통신하는 fetch. 인증서는 스스로 만든 것이라 일반 확인 대신 지문으로 확인해요
const agents = new Map()
function pinnedFetch(fp) {
  if (!agents.has(fp)) {
    const connector = buildConnector({ rejectUnauthorized: false })
    agents.set(fp, new Agent({
      connect(opts, callback) {
        connector(opts, (err, socket) => {
          if (err) return callback(err)
          const got = socket.getPeerCertificate?.()?.fingerprint256?.replace(/:/g, '').toLowerCase()
          if (got !== fp) {
            socket.destroy()
            return callback(new Error('서버 인증서가 연결 코드와 달라요.'))
          }
          callback(null, socket)
        })
      },
    }))
  }
  const dispatcher = agents.get(fp)
  return (url, init = {}) => fetch(url, { ...init, dispatcher })
}

module.exports = { loadOrCreateCert, saveCert, fingerprint, pinnedFetch }
