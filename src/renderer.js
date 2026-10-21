const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...children.filter((c) => c != null))
  return el
}

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (t) => (t ? t.slice(0, 5) : '')

// selected: 왼쪽 내 업무/학교 전체가 보여 주는 날짜 (달력에서 누른 날짜, 처음엔 오늘)
const state = { me: null, categories: [], profiles: [], events: [], shown: new Date(), today: ymd(new Date()) }
state.selected = state.today

const colorOf = (ev) => state.categories.find((c) => c.id === ev.category_id)?.color ?? '#888'
const nameOf = (id) => state.profiles.find((p) => p.id === id)?.name ?? '알 수 없음'
const onDay = (ev, day) => ev.start_date <= day && ev.end_date >= day
const byTime = (a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? '')
  || (a.start_time ? 0 : a.start_date.localeCompare(b.start_date) || b.end_date.localeCompare(a.end_date))
  || (a.end_time ?? '').localeCompare(b.end_time ?? '')
  || a.title.localeCompare(b.title, 'ko')
const canEdit = (ev) => !ev || state.me?.is_admin || ev.author_id === state.me?.id

// PRD 7.3 형식: 제목(시간, 장소)
function format(ev) {
  const time = ev.start_time ? hhmm(ev.start_time) + (ev.end_time ? `~${hhmm(ev.end_time)}` : '') : ''
  const extra = [time, ev.location].filter(Boolean).join(', ')
  return extra ? `${ev.title}(${extra})` : ev.title
}

function showStatus(text) { $('#who-am-i').textContent = text }

// ── 왼쪽: 시간별 줄 (종일 + 08시~17시, 그 밖의 시각은 일정이 있을 때만) ──
// 한 줄 = 시간 | 내 업무 | 학교 전체. 두 열이 같은 시간 줄을 써서 같이 스크롤돼요
function renderTimeline(el, mine, school) {
  const hourOf = (ev) => (ev.start_time ? Number(ev.start_time.slice(0, 2)) : null)
  const hours = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  school.forEach((ev) => hourOf(ev) != null && hours.add(hourOf(ev)))
  const items = (list, hour, showWho) => list.filter((ev) => hourOf(ev) === hour).sort(byTime).map((ev) => h('div',
    { className: 'item', title: `${nameOf(ev.author_id)} · ${format(ev)}`, onclick: (e) => { e.stopPropagation(); openEvent(ev) } },
    h('span', { className: 'dot', style: `background:${colorOf(ev)}` }),
    h('span', { className: 'text', textContent: format(ev) }),
    showWho ? h('span', { className: 'who', textContent: ` ${nameOf(ev.author_id)}` }) : null))
  // 오늘을 보고 있을 때만 지금 시각 줄을 강조해요
  const nowHour = state.selected === state.today ? new Date().getHours() : -1

  el.replaceChildren(...[null, ...[...hours].sort((a, b) => a - b)].map((hour) => h('div',
    {
      className: hour === nowHour ? 'row now' : 'row',
      title: '빈 곳을 누르면 이 시간에 일정을 입력해요',
      // 줄의 빈 곳을 누르면 그 날짜, 그 시각으로 새 일정을 입력해요
      onclick: () => state.me && openEvent(null, state.selected, hour),
    },
    h('div', { className: 'label', textContent: hour == null ? '종일' : `${pad(hour)}시` }),
    h('div', { className: 'cell mine-cell' }, ...items(mine, hour, false),
      state.me ? h('button', {
        className: 'add', textContent: '+', title: '이 시간에 내 일정 추가',
        onclick: (e) => { e.stopPropagation(); openEvent(null, state.selected, hour) },
      }) : null),
    h('div', { className: 'cell' }, ...items(school, hour, true)))))
  el.querySelector('.now')?.scrollIntoView({ block: 'center' })
}

// ── 오른쪽: 한 달 달력 (월요일 시작, 한 칸에 2건까지, 넘치면 +N건 더) ──
function renderCalendar() {
  const y = state.shown.getFullYear()
  const m = state.shown.getMonth()
  $('#month-title').textContent = `${y}년 ${m + 1}월`
  const lead = (new Date(y, m, 1).getDay() + 6) % 7
  const days = new Date(y, m + 1, 0).getDate()

  // 필요한 주 수만큼만 줄을 만들어요 (빈 6번째 줄 없음)
  const weeks = Math.ceil((lead + days) / 7)
  $('#calendar').style.setProperty('--weeks', weeks)

  const cells = ['월', '화', '수', '목', '금', '토', '일'].map((d, i) =>
    h('div', { className: `head ${i === 5 ? 'sat' : ''} ${i === 6 ? 'sun' : ''}`, textContent: d }))
  for (let i = 0; i < weeks * 7; i++) {
    const day = i - lead + 1
    const weekday = i % 7 === 5 ? 'sat' : i % 7 === 6 ? 'sun' : ''
    // 앞뒤 달의 날짜는 흐리게만 보여 줘요
    if (day < 1 || day > days) {
      cells.push(h('div', { className: `other ${weekday}` }, h('span', { className: 'daynum', textContent: new Date(y, m, day).getDate() })))
      continue
    }
    const date = ymd(new Date(y, m, day))
    const list = state.events.filter((ev) => onDay(ev, date)).sort(byTime)
    const cls = ['day', weekday, date === state.today ? 'today' : '', date === state.selected ? 'selected' : ''].join(' ')
    cells.push(h('div', {
      className: cls,
      title: '누르면 이 날 일정이 한 줄씩 나와요',
      // 칸의 빈 곳을 누르면 왼쪽이 그날로 바뀌고, 그날 일정이 한 줄씩 떠요
      onclick: () => { state.selected = date; render(); openDay(date) },
    },
      h('span', { className: 'daynum', textContent: day }),
      // 애플 캘린더처럼: 종일 일정은 옅은 색 막대, 시간 일정은 색 점 + 제목 + 시각
      ...list.slice(0, 2).map((ev) => h('div', {
        className: ev.start_time ? 'chip timed' : 'chip allday', style: `--c:${colorOf(ev)}`,
        title: `${nameOf(ev.author_id)} · ${format(ev)}`,
        onclick: (e) => { e.stopPropagation(); openEvent(ev) },
      },
      ev.start_time ? h('span', { className: 'cdot' }) : null,
      h('span', { className: 'ctitle', textContent: ev.title }),
      ev.start_time ? h('span', { className: 'ctime', textContent: hhmm(ev.start_time) }) : null)),
      list.length > 2 ? h('div', { className: 'more', textContent: `+${list.length - 2}건 더` }) : null))
  }
  $('#calendar').replaceChildren(...cells)
}

function render() {
  const day = state.events.filter((ev) => onDay(ev, state.selected))
  const [, m, d] = state.selected.split('-').map(Number)
  const label = state.selected === state.today ? '오늘' : `${m}월 ${d}일`
  $('#mine-title').textContent = `내 업무 · ${label}`
  $('#school-title').textContent = `학교 전체 · ${label}`
  renderTimeline($('#timeline'), day.filter((ev) => ev.author_id === state.me?.id), day)
  renderCalendar()
  if (state.view === 'week') renderWeek()
}

// ── 주간업무 표: 구분 × (월~금, 토·일) (PRD 6.3, 7.2, 7.3) ──
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7))
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']
state.view = 'month'
state.weekStart = mondayOf(new Date())

// "N월 N주": 그 주 월요일이 그 달의 몇 번째 월요일인지
function weekTitle() {
  const mon = state.weekStart
  return `${mon.getMonth() + 1}월 ${Math.ceil(mon.getDate() / 7)}주 주간 업무 계획`
}

function weekColumns() {
  const label = (d) => `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})`
  // 월~일 7칸 (토요일, 일요일도 따로)
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = addDays(state.weekStart, i)
    return { label: label(d), days: [ymd(d)], sat: i === 5, sun: i === 6 }
  })
}

// 한 칸에 들어갈 일정: 종일 먼저, 그다음 시간순
function weekCell(categoryId, col) {
  return state.events
    .filter((ev) => ev.category_id === categoryId && onDay(ev, col.days[0]))
    .sort(byTime)
    .map((ev) => ({ ev, text: format(ev) }))
}

function renderWeek() {
  $('#week-title').textContent = weekTitle()
  const cols = weekColumns()
  const head = h('tr', {}, h('th', { textContent: '구분' }),
    ...cols.map((c) => h('th', {
      textContent: c.label,
      className: [c.days.includes(state.today) ? 'today-col' : '', c.sat ? 'sat' : '', c.sun ? 'sun' : ''].join(' '),
    })))
  const rows = state.categories.map((cat) => h('tr', {},
    h('td', {}, h('span', { className: 'cat-dot', style: `background:${cat.color}` }), cat.name),
    ...cols.map((col) => h('td', {
      className: `slot ${col.days.includes(state.today) ? 'today-col' : ''}`,
      title: '빈 곳을 누르면 이 구분, 이 날짜로 일정을 입력해요',
      // 빈 곳을 누르면 그 구분과 날짜가 채워진 입력 창 (PRD 6.3)
      onclick: () => state.me && openEvent(null, col.days[0], null, cat.id),
    }, ...weekCell(cat.id, col).map(({ ev, text }) => h('div', {
      className: 'entry', textContent: text, title: `${text} · ${nameOf(ev.author_id)}`,
      onclick: (e) => { e.stopPropagation(); openEvent(ev) },
    }))))))
  $('#week-table').replaceChildren(h('thead', {}, head), h('tbody', {}, ...rows))
}

async function setView(view) {
  state.view = view
  $('main').hidden = view === 'week'
  $('#week-view').hidden = view !== 'week'
  $('#toggle-view').checked = view === 'week'
  // 스위치 옆 글자는 '누르면 갈 화면'을 보여 줘요
  $('#toggle-label').textContent = view === 'week' ? '달력' : '주간업무'
  await window.widget.setMode(view)
  await loadEvents()
}
// 스위치를 켜면 주간업무 표, 끄면 달력
$('#toggle-view').onchange = (e) => setView(e.target.checked ? 'week' : 'month')

const moveWeek = (delta) => {
  state.weekStart = delta == null ? mondayOf(new Date()) : addDays(state.weekStart, delta * 7)
  loadEvents()
}
$('#week-prev').onclick = () => moveWeek(-1)
$('#week-next').onclick = () => moveWeek(1)
$('#week-today').onclick = () => moveWeek(null)
// 파일 이름: 주간업무(10월2주,2026-10-12) — 그 주 월요일 날짜 기준
function weekFileName() {
  const mon = state.weekStart
  return `주간업무(${mon.getMonth() + 1}월${Math.ceil(mon.getDate() / 7)}주,${ymd(mon)})`
}

// PDF로 저장할 때 기본 파일 이름은 창 제목을 따라가서, 인쇄하는 동안만 제목을 바꿔요
$('#week-print').onclick = () => {
  const title = document.title
  document.title = weekFileName()
  window.addEventListener('afterprint', () => { document.title = title }, { once: true })
  window.print()
}

$('#week-excel').onclick = async () => {
  const cols = weekColumns()
  const res = await window.widget.exportWeek({
    title: weekTitle(),
    fileName: `${weekFileName()}.xlsx`,
    header: ['구분', ...cols.map((c) => c.label)],
    // 한 칸에 여러 건이면 구분되게 내용마다 앞에 "- "를 붙여요
    rows: state.categories.map((cat) => [cat.name, ...cols.map((col) => weekCell(cat.id, col).map((x) => `- ${x.text}`).join('\n'))]),
  })
  if (res?.error) alert(`엑셀로 저장하지 못했어요: ${res.error}`)
  else if (res?.ok) showStatus('엑셀 파일을 저장했어요.')
}

// ── 데이터 불러오기 ──
async function loadBasics() {
  const res = await window.api.load()
  if (res.error) return showStatus(`⚠ ${res.error}`)
  state.categories = res.categories
  state.profiles = res.profiles
  const options = () => state.categories.map((c) => h('option', { value: c.id, textContent: c.name }))
  $('#ev-category').replaceChildren(...options())
  $('#acc-category').replaceChildren(...options())
}

async function loadEvents() {
  if (!state.me) return
  const y = state.shown.getFullYear()
  const m = state.shown.getMonth()
  const dates = [ymd(new Date(y, m, 1)), ymd(new Date(y, m + 1, 0)), state.today, state.selected,
    ymd(state.weekStart), ymd(addDays(state.weekStart, 6))].sort()
  const from = dates[0]
  const to = dates[dates.length - 1]
  const res = await window.api.events(from, to)
  if (res.error) return showStatus(`⚠ ${res.error}`)
  state.events = res.events
  // 새로 만든 계정이 쓴 일정이면 이름을 모르니 계정 목록을 다시 받아요
  if (state.events.some((ev) => !state.profiles.some((p) => p.id === ev.author_id))) await loadBasics()
  showStatus(`${state.me.name}${state.me.is_admin ? ' (관리자)' : ''}`)
  render()
}

let reloadTimer
window.api.onEventsChanged(() => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadEvents, 300) })

// ── 로그인과 비밀번호 ──
async function enter(user) {
  state.me = user
  updateAuthButton()
  $('#login').hidden = true
  if (user.must_change_password) return openPassword(true)
  $('#password').hidden = true
  $('#add-event').disabled = false
  $('#toggle-view').disabled = false
  $('#admin-tab-button').hidden = !user.is_admin
  $('#my-account').textContent = `${user.name} (${user.login_id})${user.is_admin ? ' · 관리자' : ''}`
  await loadBasics()
  await loadEvents()
}

// 위쪽 로그인/로그아웃 버튼: 로그인 상태면 로그아웃, 아니면 로그인 창 열기
function updateAuthButton() {
  $('#auth-button').textContent = state.me ? '🚪 로그아웃' : '🔑 로그인'
}
$('#auth-button').onclick = async () => {
  if (!state.me) return openLogin()
  if (!confirm('로그아웃할까요?')) return
  await window.api.logout()
  signedOut()
  showStatus('로그아웃됨')
}
$('#login-close').onclick = () => { $('#login').hidden = true }

function signedOut() {
  state.me = null
  state.events = []
  $('#add-event').disabled = true
  $('#toggle-view').disabled = true
  if (state.view === 'week') setView('month')
  $('#admin-tab-button').hidden = true
  $$('.overlay').forEach((o) => { o.hidden = true })
  updateAuthButton()
  render()
}

function openLogin(message = '') {
  signedOut()
  showStatus('로그아웃됨')
  $('#login-error').textContent = message
  $('#login-pw').value = ''
  $('#login').hidden = false
  $('#login-id').focus()
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault()
  $('#login-error').textContent = ''
  const res = await window.api.login($('#login-id').value, $('#login-pw').value)
  if (res.error) return void ($('#login-error').textContent = res.error)
  enter(res.user)
}

function openPassword(forced) {
  $('#password-note').hidden = !forced
  $('#password-cancel').hidden = forced
  $('#password-error').textContent = ''
  $('#new-pw').value = ''
  $('#new-pw2').value = ''
  $('#password').hidden = false
  $('#new-pw').focus()
}

$('#password-form').onsubmit = async (e) => {
  e.preventDefault()
  if ($('#new-pw').value !== $('#new-pw2').value) return void ($('#password-error').textContent = '두 비밀번호가 달라요.')
  const res = await window.api.changePassword($('#new-pw').value)
  if (res.error) return void ($('#password-error').textContent = res.error)
  $('#password').hidden = true
  enter(res.user)
}
$('#password-cancel').onclick = () => { $('#password').hidden = true }

// ── 일정 입력·수정 ──
let editing = null

// ev가 없으면 새 일정. date와 hour(시간 줄에서 눌렀을 때)를 미리 채워요
function openEvent(ev, date, hour, categoryId) {
  editing = ev
  const editable = canEdit(ev)
  $('#event-heading').textContent = !ev ? '일정 입력' : editable ? '일정 수정' : '일정 보기'
  // 다른 사람 일정은 보기 전용: 잠금 안내를 띄우고 입력 칸을 글자처럼 보이게 해요 (관리자는 모두 수정 가능)
  $('#event-form').classList.toggle('view-only', !editable)
  $('#ev-lock').hidden = editable
  if (!editable) $('#ev-lock').textContent = `🔒 ${nameOf(ev.author_id)}님이 쓴 일정이라 볼 수만 있어요. 고치거나 지우는 건 쓴 사람과 관리자만 할 수 있어요.`
  $('#event-form .hint').hidden = !editable
  $('#ev-title').value = ev?.title ?? ''
  $('#ev-category').value = ev?.category_id ?? categoryId ?? state.me.default_category_id ?? state.categories[0]?.id
  $('#ev-start').value = ev?.start_date ?? date ?? state.today
  $('#ev-end').value = ev && ev.end_date !== ev.start_date ? ev.end_date : ''
  $('#ev-start-time').value = ev ? hhmm(ev.start_time) : hour != null ? `${pad(hour)}:00` : ''
  $('#ev-end-time').value = hhmm(ev?.end_time)
  $('#ev-location').value = ev?.location ?? ''
  $('#ev-memo').value = ev?.memo ?? ''
  $$('#event-form input, #event-form select, #event-form textarea').forEach((el) => { el.disabled = !editable })
  $('#ev-save').hidden = !editable
  $('#ev-delete').hidden = !ev || !editable
  // 다른 사람 일정은 못 고치지만, 같은 날짜와 시각으로 내 일정을 바로 넣을 수 있어요
  $('#ev-add-same').hidden = editable
  $('#ev-author').textContent = ev ? nameOf(ev.author_id) : state.me.name
  $('#event-error').textContent = ''
  $('#day').hidden = true
  $('#event').hidden = false
  if (editable) $('#ev-title').focus()
}

$('#event-form').onsubmit = async (e) => {
  e.preventDefault()
  const start = $('#ev-start').value
  const end = $('#ev-end').value || start
  const startTime = $('#ev-start-time').value
  const endTime = $('#ev-end-time').value
  const fail = (msg) => { $('#event-error').textContent = msg }
  if (end < start) return fail('끝 날짜가 시작 날짜보다 빨라요.')
  if (endTime && !startTime) return fail('끝 시각을 쓰려면 시작 시각도 적어 주세요.')
  if (endTime && start === end && endTime <= startTime) return fail('끝 시각이 시작 시각보다 늦어야 해요.')

  const res = await window.api.saveEvent({
    id: editing?.id,
    title: $('#ev-title').value.trim(),
    category_id: Number($('#ev-category').value),
    start_date: start,
    end_date: end,
    start_time: startTime,
    end_time: endTime,
    location: $('#ev-location').value.trim(),
    memo: $('#ev-memo').value.trim(),
  })
  if (res.error) return fail(res.error)
  $('#event').hidden = true
  showToast(editing ? '✓ 고쳤어요' : '✓ 저장했어요')
  loadEvents()
}

$('#ev-delete').onclick = async () => {
  if (!confirm('이 일정을 지울까요?')) return
  const res = await window.api.deleteEvent(editing.id)
  if (res.error) return void ($('#event-error').textContent = res.error)
  $('#event').hidden = true
  showToast('✓ 지웠어요')
  loadEvents()
}

// 내가 저장하거나 지운 뒤에는 윈도우 알림 대신 위젯 아래쪽에 2초 동안 확인 메시지를 보여 줘요
let toastTimer
function showToast(text) {
  $('#toast').textContent = text
  $('#toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { $('#toast').hidden = true }, 2000)
}
$('#ev-cancel').onclick = () => { $('#event').hidden = true }
$('#ev-add-same').onclick = () => {
  const other = editing
  openEvent(null, state.selected >= other.start_date && state.selected <= other.end_date ? state.selected : other.start_date)
  $('#ev-start-time').value = hhmm(other.start_time)
}
$('#win-hide').onclick = () => window.widget.windowAction('hide')
$('#win-full').onclick = async () => {
  const { full } = await window.widget.windowAction('full')
  $('#win-full').textContent = full ? '❐' : '☐'
  $('#win-full').title = full ? '이전 크기로' : '최대화'
}
// ✕는 끄지 않고 숨겨요 (위젯은 계속 켜져 있어요)
$('#quit').onclick = () => window.widget.hide()
$('#add-event').onclick = () => openEvent(null, state.selected)

// 그날 일정만 시간순으로 한 줄씩 (빈 시간은 안 보여요)
let dayShown = null
function openDay(date) {
  dayShown = date
  const [, m, d] = date.split('-').map(Number)
  const list = state.events.filter((ev) => onDay(ev, date)).sort(byTime)
  $('#day-heading').textContent = `${m}월 ${d}일 일정 ${list.length}건`
  $('#day-list').replaceChildren(...(list.length ? list.map((ev) => h('div', { className: 'day-line', title: format(ev), onclick: () => openEvent(ev) },
    h('span', { className: 'who', textContent: nameOf(ev.author_id) }),
    h('span', { className: 'when', textContent: ev.start_time ? hhmm(ev.start_time) + (ev.end_time ? `~${hhmm(ev.end_time)}` : '') : '종일' }),
    h('span', { className: 'dot', style: `background:${colorOf(ev)}` }),
    h('span', { className: 'text', textContent: ev.title + (ev.location ? ` (${ev.location})` : '') })))
    : [h('p', { className: 'note', textContent: '입력된 일정이 없어요.' })]))
  $('#day-add').hidden = !state.me
  $('#day').hidden = false
}
$('#day-close').onclick = () => { $('#day').hidden = true }
$('#day-add').onclick = () => openEvent(null, dayShown)

// ── 달 넘기기 ──
const moveMonth = (delta) => {
  state.shown = delta == null ? new Date() : new Date(state.shown.getFullYear(), state.shown.getMonth() + delta, 1)
  renderCalendar()
  loadEvents()
}
$('#prev').onclick = () => moveMonth(-1)
$('#next').onclick = () => moveMonth(1)
$('#today').onclick = () => { state.selected = state.today; moveMonth(null) }

// 1분마다 다시 그려요. 날짜가 바뀌면(자정) 일정도 새로 불러와요.
setInterval(() => {
  const today = ymd(new Date())
  if (today !== state.today) {
    if (state.selected === state.today) state.selected = today
    state.today = today
    loadEvents()
  }
  render()
}, 60 * 1000)

// ── 설정: 개인 설정 ──
const setAlpha = (percent) => {
  document.documentElement.style.setProperty('--alpha', percent / 100)
  $('#opacity-value').textContent = `${percent}%`
}
// 색 테마: 윈도우, 로제타스톤, 블랙, NEIS (widget.css의 :root[data-theme]) + 사용자 정의
const THEMES = [
  { id: 'win', name: '윈도우', swatch: 'linear-gradient(135deg, #0067c0 50%, #f3f3f3 50%)' },
  { id: 'rosetta', name: '로제타스톤', swatch: 'linear-gradient(135deg, #1ca8a8 50%, #ffffff 50%)' },
  { id: 'black', name: '블랙', swatch: '#000000' },
  { id: 'neis', name: 'NEIS', swatch: 'linear-gradient(135deg, #1f4e9a 50%, #e6ecf4 50%)' },
  { id: 'custom', name: '사용자 정의', swatch: 'conic-gradient(#e15759, #edc948, #59a14f, #4e79a7, #b07aa1, #e15759)' },
]
const CUSTOM_VARS = ['--bg', '--surface', '--fg', '--muted', '--accent', '--line', '--grid', '--btn-bg', '--btn-fg', '--btn-border']

// 사용자 정의: 바탕색과 강조색 두 가지만 고르면 나머지 색은 어울리게 계산해요
function applyCustomColors({ bg, accent }) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16))
  const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128
  const fg = dark ? '#eef0f3' : '#1f2430'
  const mix = (a, c, p) => `color-mix(in srgb, ${a} ${p}%, ${c})`
  const surface = dark ? mix(bg, '#ffffff', 92) : mix(bg, '#ffffff', 30)
  const vars = {
    '--bg': bg, '--surface': surface, '--fg': fg, '--muted': mix(fg, bg, 60), '--accent': accent,
    '--line': mix(fg, surface, 10), '--grid': mix(fg, surface, 20),
    '--btn-bg': surface, '--btn-fg': fg, '--btn-border': mix(fg, surface, 20),
  }
  Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v))
}

let customColors = { bg: '#eef3f8', accent: '#2f6fde' }
function setTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]
  document.documentElement.dataset.theme = theme.id
  CUSTOM_VARS.forEach((k) => document.documentElement.style.removeProperty(k))
  if (theme.id === 'custom') applyCustomColors(customColors)
  $('#custom-colors').hidden = theme.id !== 'custom'
  $('#theme-name').textContent = theme.name
  $$('.theme-swatch').forEach((b) => b.classList.toggle('active', b.dataset.id === theme.id))
}
$('#themes').replaceChildren(...THEMES.map((t) => {
  const b = h('button', {
    className: 'theme-swatch', title: t.name, style: `background:${t.swatch}`,
    onclick: () => { setTheme(t.id); window.widget.setTheme(t.id) },
  })
  b.dataset.id = t.id
  return b
}))
const onCustomColor = (save) => () => {
  customColors = { bg: $('#custom-bg').value, accent: $('#custom-accent').value }
  applyCustomColors(customColors)
  if (save) window.widget.setTheme('custom', customColors)
}
$('#custom-bg').oninput = onCustomColor(false)
$('#custom-accent').oninput = onCustomColor(false)
$('#custom-bg').onchange = onCustomColor(true)
$('#custom-accent').onchange = onCustomColor(true)

// 알림 받기: 새 일정 추가 / 고치거나 지운 것 / 알림 받지 않음(앞의 둘을 모두 끔)
function showNotifyPrefs({ add, change }) {
  $('#notify-add').checked = add
  $('#notify-change').checked = change
  $('#notify-none').checked = !add && !change
}
function saveNotifyPrefs(prefs) {
  showNotifyPrefs(prefs)
  window.widget.setNotify(prefs)
}
$('#notify-add').onchange = (e) => saveNotifyPrefs({ add: e.target.checked, change: $('#notify-change').checked })
$('#notify-change').onchange = (e) => saveNotifyPrefs({ add: $('#notify-add').checked, change: e.target.checked })
$('#notify-none').onchange = (e) => saveNotifyPrefs(e.target.checked ? { add: false, change: false } : { add: true, change: true })

window.widget.getSettings().then(({ opacity, theme, customColors: saved, autoStart, notify, serverError }) => {
  // 이 PC가 서버인데 서버를 켜지 못했을 때 (다른 프로그램이 같은 포트를 쓰는 경우 등)
  if (serverError) alert(`⚠ 이 PC의 jple 서버를 켜지 못했어요.\n(${serverError})\njple을 완전히 종료하고 다시 켜 보세요.`)
  $('#opacity').value = Math.round(opacity * 100)
  setAlpha($('#opacity').value)
  if (saved) customColors = saved
  $('#custom-bg').value = customColors.bg
  $('#custom-accent').value = customColors.accent
  setTheme(theme)
  $('#auto-start').checked = autoStart
  showNotifyPrefs(notify)
})
$('#opacity').oninput = (e) => setAlpha(e.target.value)
$('#opacity').onchange = (e) => window.widget.setOpacity(e.target.value / 100)
$('#auto-start').onchange = async (e) => { e.target.checked = await window.widget.setAutoStart(e.target.checked) }

function selectTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name })
  // 개인 설정은 좁게, 계정 표가 있는 관리자 설정은 넓게
  $('#settings-card').classList.toggle('wide', name === 'admin')
  if (name === 'admin') refreshAccounts()
}
$$('.tab').forEach((t) => { t.onclick = () => selectTab(t.dataset.tab) })
$('#open-settings').onclick = () => { selectTab('personal'); showSettingsTitle(); $('#settings').hidden = false }

// 설정 창 제목 줄: jple 버전과 지금 연결된 DB 종류(외부/로컬)
async function showSettingsTitle() {
  $('#settings-title').textContent = `jple v${await window.widget.version()} 설정`
  const info = await window.widget.dbInfo()
  const badge = $('#settings-db')
  badge.className = `db-badge ${info.kind}`
  badge.textContent = info.kind === 'external' ? '🌐 외부 DB' : info.kind === 'local' ? (info.isServer ? '🖥 로컬 DB · 이 PC가 서버' : '🖥 로컬 DB') : '연결 없음'
}
$('#close-settings').onclick = () => { $('#settings').hidden = true }
$('#open-password').onclick = () => { $('#settings').hidden = true; openPassword(false) }
$('#open-help').onclick = () => { $('#help').hidden = false }
$('#open-connect').onclick = () => openSetup(true)
$('#help-close').onclick = () => { $('#help').hidden = true }

// 맨 위 제목 줄에 버전을 보여 줘요
window.widget.version().then((v) => { $('#app-version').textContent = `v${v}` })
$('#logout').onclick = async () => {
  await window.api.logout()
  signedOut()
  showStatus('로그아웃됨')
}

// ── 설정: 관리자 설정 (계정 관리) ──
const adminMessage = (text) => { $('#admin-message').textContent = text }
let defaultPassword = ''

$('#default-pw-form').onsubmit = async (e) => {
  e.preventDefault()
  const value = $('#default-pw').value
  if (value && value.length < 8) return adminMessage('⚠ 기본 처음 비밀번호는 8자 이상이어야 해요.')
  await window.widget.setDefaultPassword(value)
  defaultPassword = value
  $('#acc-pw').value = value
  adminMessage(value ? '기본 처음 비밀번호를 저장했어요.' : '기본 처음 비밀번호를 지웠어요.')
}

async function adminCall(body, done) {
  adminMessage('처리하는 중이에요…')
  const res = await window.api.admin(body)
  if (res.error) return adminMessage(`⚠ ${res.error}`)
  adminMessage(done)
  refreshAccounts()
}

// 계정마다 기본 구분을 고르는 목록 (바꾸면 바로 저장)
function categorySelect(p) {
  const select = h('select', {
    onchange: () => adminCall({ action: 'set_category', user_id: p.id, default_category_id: Number(select.value) || null },
      `${p.name}님 기본 구분을 바꿨어요.`),
  },
  h('option', { value: '', textContent: '-' }),
  ...state.categories.map((c) => h('option', { value: c.id, textContent: c.name })))
  select.value = p.default_category_id ?? ''
  return select
}

async function refreshAccounts() {
  await loadBasics()
  defaultPassword = await window.widget.getDefaultPassword()
  $('#default-pw').value = defaultPassword
  if (!$('#acc-pw').value) $('#acc-pw').value = defaultPassword
  renderCategories()
  accountsToggleLabel()
  $('#account-rows').replaceChildren(...state.profiles.map((p) => {
    const actions = h('td', {},
      h('button', { textContent: '비밀번호 초기화', onclick: () => askNewPassword(p, actions) }), ' ',
      h('button', {
        textContent: p.is_admin ? '관리자 빼기' : '관리자 주기',
        onclick: () => confirm(`${p.name}님의 관리자 권한을 ${p.is_admin ? '뺄까요' : '줄까요'}?`) &&
          adminCall({ action: 'set_admin', user_id: p.id, is_admin: !p.is_admin }, '관리자 권한을 바꿨어요.'),
      }))
    return h('tr', {},
      h('td', { textContent: p.name }),
      h('td', { textContent: p.login_id }),
      h('td', {}, categorySelect(p)),
      h('td', { textContent: p.is_admin ? '✓' : '' }),
      actions)
  }))
}

// ── 구분(부서) 관리 펼치기/접기 ──
$('#category-toggle').onclick = () => {
  const open = $('#category-panel').hidden
  $('#category-panel').hidden = !open
  $('#category-toggle').textContent = `${open ? '▾' : '▸'} 구분(부서) 관리`
}

// ── DB 관리: 관리자 아이디와 비밀번호를 확인한 뒤 메뉴를 열어요. 비밀번호는 창을 닫으면 잊어요 ──
let dbCred = null
const dbMessage = (text) => { $('#db-message').textContent = text; $('#db-error').textContent = '' }
const dbError = (text) => { $('#db-error').textContent = text }
const dbCall = (action, extra = {}) => window.api.admin({ action, admin_id: dbCred.id, admin_password: dbCred.pw, ...extra })

function closeDb() {
  dbCred = null
  $('#db-pw').value = ''
  $('#db').hidden = true
}
$$('.db-close').forEach((b) => { b.onclick = closeDb })

$('#db-open').onclick = () => {
  $('#db-login').hidden = false
  $('#db-menu').hidden = true
  $('#db-id').value = state.me?.login_id ?? ''
  $('#db-pw').value = ''
  $('#db-login-error').textContent = ''
  $('#db').hidden = false
  $('#db-pw').focus()
}

async function showDbStatus() {
  const res = await dbCall('db_status')
  if (res.error) return dbError(res.error)
  $('#db-status').textContent = `✅ 연결 정상 · 일정 ${res.events}건 · 계정 ${res.profiles}명 · 부서 ${res.categories}개`
  const conn = await window.widget.getConnection()
  $('#db-connection').textContent = `지금 연결: ${conn.url}${conn.server ? ' (이 PC가 서버예요)' : ''}`
  showStandbys()
  showUpdateStatus()
}

// ── 서버 구성: 주 서버와 대기 서버의 상태, 켜져 있는 PC 중에서 대기 서버 지정 (관리자 확인 뒤 서버가 처리해요) ──
const SERVER_STATE = { active: '🟢 사용 중', standby: '🟡 대기 (복제 중)', off: '⚪ 꺼짐' }
$('#standby-refresh').onclick = () => showStandbys()
async function showStandbys() {
  const i = await window.widget.dbInfo()
  $('#standby-section').hidden = i.kind !== 'local'
  if (i.kind !== 'local') return
  const c = await dbCall('db_cluster')
  if (c.error) return dbError(c.error)
  const names = ['주 서버', '대기 서버 1', '대기 서버 2']
  $('#standby-list').innerHTML = [0, 1, 2].map((n) => {
    const sv = i.servers.find((x) => x.priority === n) ?? c.servers.find((x) => x.priority === n)
    if (!sv) return `<div class="standby-row"><span>${names[n]}</span><span class="note">없음</span><span></span></div>`
    const state = SERVER_STATE[sv.state] ?? ''
    const who = sv.pc_name ? `${escapeHtml(sv.pc_name)} (${escapeHtml(sv.host)})` : escapeHtml(sv.host)
    const remove = n > 0 ? `<button type="button" data-standby-remove="${n}">지정 해제</button>` : ''
    return `<div class="standby-row"><span>${names[n]}</span><span>${who} · ${state}</span><span>${remove}</span></div>`
  }).join('')
  $('#pc-list').innerHTML = c.pcs.length
    ? c.pcs.map((pc) => `<div class="standby-row"><span>${escapeHtml(pc.name)}</span><span>${escapeHtml(pc.host)}${pc.login ? ` · ${escapeHtml(pc.login)}` : ''}${pc.standby ? ` · 대기 서버 ${pc.standby}` : ''}${pc.pending ? ` · ⏳ 대기 ${pc.pending} 수락 기다리는 중` : ''}</span>
        <span>${[1, 2].filter((n) => n !== pc.standby).map((n) => `<button type="button" data-assign="${n}" data-pc="${pc.pc_id}">대기 ${n}로</button>`).join(' ')}</span></div>`).join('')
    : '<p class="note">지금 로그인해 있는 다른 PC가 없어요. 대기 서버로 쓸 PC에서 jple을 켜고 로그인한 뒤(같은 학교 네트워크, 이 DB에 연결) [↻ 새로고침]을 눌러 보세요.</p>'
  $('#standby-list').querySelectorAll('[data-standby-remove]').forEach((b) => {
    b.onclick = async () => {
      const n = Number(b.dataset.standbyRemove)
      if (!confirm(`대기 서버 ${n}의 지정을 해제할까요?\n그 PC는 몇 초 안에 대기 서버를 그만두고 보통 PC로 돌아가요(꺼져 있으면 다음에 켤 때).`)) return
      const res = await dbCall('db_standby_remove', { priority: n })
      if (res.error) return dbError(res.error)
      dbMessage(`대기 서버 ${n}의 지정을 해제했어요.`)
      showStandbys()
    }
  })
  $('#pc-list').querySelectorAll('[data-assign]').forEach((b) => {
    b.onclick = async () => {
      const n = Number(b.dataset.assign)
      const pc = c.pcs.find((x) => x.pc_id === b.dataset.pc)
      const taken = c.servers.find((x) => x.priority === n)
      if (!confirm(`${pc.name} (${pc.host})에 대기 서버 ${n} 지정 요청을 보낼까요?${taken ? `\n그 PC가 수락하면 지금 대기 서버 ${n}인 PC는 지정이 풀려요.` : ''}\n그 PC 화면에 확인 창이 뜨고, 수락해야 대기 서버가 돼요.`)) return
      const res = await dbCall('db_standby_assign', { priority: n, pc_id: pc.pc_id })
      if (res.error) return dbError(res.error)
      dbMessage(`🛟 ${pc.name}에 확인 창을 보냈어요. 그 PC에서 수락하면 대기 서버 ${n}이 돼요. 잠시 뒤 [↻ 새로고침]으로 확인하세요.`)
      showStandbys()
    }
  })
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
// [DB 정보]: DB 관리 내용 대신 DB 정보만 보여 줘요. 외부 DB인지 로컬 DB인지, 각각 연결에 필요한 정보
function closeDbInfo() {
  $('#db-menu').classList.remove('info-mode')
  $('#db-info').hidden = true
}
$('#db-info-toggle').onclick = () => showDbInfo()
async function showDbInfo() {
  const box = $('#db-info')
  const i = await window.widget.dbInfo()
  const row = (k, v) => `<dt>${k}</dt><dd>${escapeHtml(String(v ?? ''))}</dd>`
  let html
  if (i.kind === 'external') {
    html = `<p class="db-kind external">🌐 외부 DB · Supabase (인터넷)</p><dl>`
      + row('프로젝트 주소', i.url) + row('프로젝트 ID', i.ref) + row('공개 키', i.key) + row('연결 코드', i.code)
      + `</dl><p class="note">학교 밖에서도 인터넷만 되면 접속돼요. 공개 키는 비밀이 아니에요(관리 권한은 서버가 따로 확인해요).</p>`
  } else if (i.kind === 'local') {
    html = `<p class="db-kind local">🖥 로컬 DB · 학교 안 서버 PC</p><dl>`
      + row('서버 주소', `${i.host}:${i.port}`) + row('이 PC', i.isServer ? `${i.role} PC (늘 켜 두어야 해요)` : '직원 PC')
      + row('서버 구성', i.servers.map((sv) => `${['주', '대기1', '대기2'][sv.priority]} ${sv.host} ${SERVER_STATE[sv.state]}`).join(' / '))
      + row('서버 상태', i.online ? `켜져 있음 (jple v${i.serverVersion})` : '연결 안 됨')
      + (i.isServer ? row('이 PC의 내부 주소', i.ips.join(', ') || '없음') + row('DB 파일', i.dbFile) : '')
      + row('연결 코드', i.code) + row('인증서 지문', i.fp)
      + `</dl>`
      + (i.canChooseAddress ? `<div class="addr-pick"><b>연결 코드에 쓸 서버 주소</b>
          <div class="actions start"><select id="addr-select">${i.ips.map((ip) => `<option ${ip === i.address ? 'selected' : ''}>${escapeHtml(ip)}</option>`).join('')}<option value="__custom">직접 적기…</option></select>
          <input id="addr-custom" placeholder="예: 192.168.0.20" hidden />
          <button type="button" id="addr-save">저장하고 연결 코드 복사</button></div>
          <span class="note">서버 PC의 주소가 바뀌면 여기서 새 주소를 고르고, 복사된 연결 코드를 메신저로 직원들에게 보내 주세요. 직원은 ⚙ → 개인 설정 → 🔗 연결 바꾸기에 넣어요.</span></div>` : '')
      + `<p class="note">학교 안 네트워크에서만 접속돼요. 통신은 https로 암호화되고, 직원 PC는 인증서 지문이 맞는 서버하고만 이야기해요.</p>`
  } else html = '<p class="note">연결된 DB가 없어요.</p>'
  box.innerHTML = `<div class="actions"><b class="db-info-title">🔎 DB 정보</b><span class="spacer"></span><button type="button" id="db-info-back">← 돌아가기</button></div>` + html
  box.hidden = false
  $('#db-menu').classList.add('info-mode')
  $('#db-info-back').onclick = closeDbInfo
  const sel = $('#addr-select')
  if (sel) {
    sel.onchange = () => { $('#addr-custom').hidden = sel.value !== '__custom' }
    $('#addr-save').onclick = async () => {
      const address = sel.value === '__custom' ? $('#addr-custom').value.trim() : sel.value
      const res = await window.widget.setServerAddress(address)
      if (res.error) return dbError(res.error)
      const conn = await window.widget.getConnection()
      copyCode(conn.code, dbMessage)
      showDbInfo()
    }
  }
}

// ── 업데이트 배포 (관리자) ──
async function showUpdateStatus() {
  const s = await window.widget.updateStatus()
  $('#update-status').textContent = `이 PC: v${s.appVersion} · 학교에 배포된 버전: ${s.distributed ? `v${s.distributed}` : '아직 없음'}${s.ready ? ` · 받아 둔 새 버전: v${s.ready}` : ''}`
}
$('#update-publish').onclick = async () => {
  dbMessage('설치 파일을 고르면 올리기 시작해요. 1~3분쯤 걸려요. 그동안 이 창을 닫지 말아 주세요.')
  const res = await window.widget.publishUpdate(dbCred.id, dbCred.pw)
  if (res?.canceled) return dbMessage('')
  if (res?.error) return dbError(res.error)
  dbMessage(`📤 v${res.version}을 배포했어요. 직원 PC들은 받아 두었다가 다음에 jple을 켤 때 저절로 바뀌어요.`)
  showUpdateStatus()
}
// 업데이트 배포를 묻는 창에서 "DB 관리 열기"를 누르면 DB 관리를 열어요
window.widget.onOpenDb(() => $('#db-open').click())

$('#db-login').onsubmit = async (e) => {
  e.preventDefault()
  dbCred = { id: $('#db-id').value.trim().toLowerCase(), pw: $('#db-pw').value }
  $('#db-login-error').textContent = '확인하는 중이에요…'
  const res = await dbCall('db_status')
  if (res.error) { dbCred = null; return void ($('#db-login-error').textContent = res.error) }
  $('#db-login').hidden = true
  $('#db-menu').hidden = false
  closeDbInfo()
  dbMessage('')
  showDbStatus()
}

$('#db-backup').onclick = async () => {
  dbMessage('백업하는 중이에요…')
  const res = await dbCall('db_backup')
  if (res.error) return dbError(res.error)
  const saved = await window.widget.saveBackup(res.backup, false)
  if (saved?.ok) dbMessage(`💾 백업했어요: ${saved.filePath}`)
  else dbMessage('')
}

$('#db-restore').onclick = async () => {
  const file = await window.widget.openBackup()
  if (file?.error) return dbError(file.error)
  if (!file?.ok) return
  const b = file.backup
  if (b?.kind !== 'db-backup') return dbError('jple 백업 파일이 아니에요.')
  const when = new Date(b.created_at).toLocaleString('ko-KR')
  if (!confirm(`${when}에 만든 백업(일정 ${b.events.length}건, 계정 ${b.accounts.length}명)으로 되돌릴까요?\n지금 일정은 모두 백업의 일정으로 바뀌어요. 바꾸기 전에 지금 상태를 자동으로 백업해 둘게요.`)) return
  dbMessage('지금 상태를 자동 백업하는 중이에요…')
  const now = await dbCall('db_backup')
  if (now.error) return dbError(now.error)
  const auto = await window.widget.saveBackup(now.backup, true)
  dbMessage('복원하는 중이에요…')
  const res = await dbCall('db_restore', { backup: b, default_password: defaultPassword })
  if (res.error) return dbError(res.error)
  const r = res.report
  dbMessage(`↩ 복원했어요. 일정 ${r.events}건, 새로 만든 계정 ${r.accountsCreated}명${r.skipped ? `, 건너뛴 계정 ${r.skipped}명(기본 처음 비밀번호가 없어요)` : ''}. 복원 전 자동 백업: ${auto.filePath}`)
  showDbStatus()
  loadBasics()
  loadEvents()
}

// ── 다른 DB로 옮기기: 계정의 암호화된 비밀번호까지 담은 파일을 관리자 비밀번호로 잠가서 저장하고, 옮길 DB에서 가져와요 ──
$('#move-out').onclick = async () => {
  dbMessage('옮기기 파일을 만드는 중이에요…')
  const res = await dbCall('db_move_out')
  if (res.error) return dbError(res.error)
  const saved = await window.widget.saveMove(res.backup, dbCred.pw)
  if (!saved?.ok) return dbMessage('')
  dbMessage(`📦 옮기기 파일을 만들었어요(일정 ${res.backup.events.length}건, 계정 ${res.backup.accounts.length}명): ${saved.filePath}\n파일은 지금 관리자 비밀번호로 잠겨 있어요. 옮길 DB의 DB 관리에서 가져오세요.`)
}

$('#move-in').onclick = async () => {
  const file = await window.widget.openMove($('#move-pw').value || dbCred.pw)
  if (file?.error) return dbError(file.error)
  if (!file?.ok) return
  const b = file.backup
  const when = new Date(b.created_at).toLocaleString('ko-KR')
  if (!confirm(`${when}에 만든 옮기기 파일(일정 ${b.events.length}건, 계정 ${b.accounts.length}명)을 이 DB로 가져올까요?\n· 이 DB의 일정은 모두 파일의 일정으로 바뀌어요.\n· 같은 아이디의 계정은 파일의 비밀번호와 정보로 바뀌어요.\n가져오기 전에 지금 상태를 자동으로 백업해 둘게요.`)) return
  dbMessage('지금 상태를 자동 백업하는 중이에요…')
  const now = await dbCall('db_backup')
  if (now.error) return dbError(now.error)
  const auto = await window.widget.saveBackup(now.backup, true)
  dbMessage('가져오는 중이에요… 계정이 많으면 1~2분 걸려요.')
  const res = await dbCall('db_move_in', { backup: b, default_password: defaultPassword })
  if (res.error) return dbError(res.error)
  const r = res.report
  $('#move-pw').value = ''
  alert(`📥 옮기기를 마쳤어요.\n일정 ${r.events}건, 새로 만든 계정 ${r.accountsCreated}명, 바꾼 계정 ${r.accountsUpdated}명${r.skipped ? `, 건너뛴 계정 ${r.skipped}명` : ''}\n이제 모두 옮기기 전 비밀번호로 로그인해요. 관리자 비밀번호도 파일을 만든 DB의 것으로 바뀌었을 수 있어요.\n가져오기 전 자동 백업: ${auto.filePath}`)
  closeDb()
  loadBasics()
  loadEvents()
}

$('#db-reset').onclick = async () => {
  const scope = $('input[name="db-scope"]:checked').value
  const label = { events: '일정을 모두', accounts: '일정과 관리자 외 계정을 모두', all: '일정, 관리자 외 계정, 부서를 모두' }[scope]
  if (!confirm(`${label} 지울까요? 되돌릴 수 없어요.\n실행 직전에 자동으로 백업해 둘게요.`)) return
  dbMessage('자동 백업하는 중이에요…')
  const now = await dbCall('db_backup')
  if (now.error) return dbError(now.error)
  const auto = await window.widget.saveBackup(now.backup, true)
  dbMessage('초기화하는 중이에요…')
  const res = await dbCall('db_reset', { scope })
  if (res.error) return dbError(res.error)
  dbMessage(`⚠ 초기화했어요${res.removedAccounts ? ` (계정 ${res.removedAccounts}명 삭제)` : ''}. 자동 백업: ${auto.filePath}`)
  showDbStatus()
  loadBasics()
  loadEvents()
}

// ── 새 DB 만들기 마법사: 단계마다 할 일 하나, 필요한 화면 열기, 붙여 넣을 내용 자동 복사, 확인 ──
const wiz = { step: 0, url: '', key: '' }
const refOf = () => wiz.url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? '_'
const site = (path) => () => window.widget.openSupabase(`https://supabase.com/dashboard${path.replace('{ref}', refOf())}`)

const WIZARD = [
  {
    title: '1. 새 프로젝트 만들기',
    text: 'Supabase 사이트에서 새 프로젝트를 만들어요.<br>· <b>Project name</b>: 아무 이름(예: jple-2027)<br>· <b>Database Password</b>: 정해서 따로 적어 두기<br>· <b>Region</b>: Northeast Asia (Seoul)<br>만든 뒤 1~2분 기다렸다가 아래 [만들었어요]를 눌러요.',
    buttons: [['새 프로젝트 화면 열기', site('/new/_')]],
    next: '만들었어요 ▶',
  },
  {
    title: '2. 프로젝트 주소 넣기',
    text: '새 프로젝트 화면 맨 위에 보이는 <b>https://…supabase.co</b> 주소를 복사해서 아래 칸에 붙여 넣어요. 화면의 [Copy] 버튼을 누르면 복사돼요.',
    buttons: [['프로젝트 목록 열기', site('/projects')]],
    input: ['url', 'https://xxxx.supabase.co'],
    check: 'url',
  },
  {
    title: '3. 공개 키 넣기',
    text: '열리는 화면에서 <b>Publishable key</b>(sb_publishable_로 시작)의 복사 버튼을 눌러 아래 칸에 붙여 넣어요.',
    buttons: [['API 키 화면 열기', site('/project/{ref}/settings/api-keys')]],
    input: ['key', 'sb_publishable_...'],
    check: 'key',
  },
  {
    title: '4. 표 만들기',
    text: '표 만들기 SQL을 <b>방금 복사해 뒀어요</b>. 열리는 SQL Editor에 <b>Ctrl + V</b>로 붙여 넣고 오른쪽 아래 <b>Run</b>을 눌러요. "Success"가 나오면 [확인]을 눌러요.',
    enter: () => window.widget.copySetup('sql'),
    buttons: [['SQL Editor 열기', site('/project/{ref}/sql/new')], ['SQL 다시 복사', () => window.widget.copySetup('sql')]],
    check: 'sql',
  },
  {
    title: '5. 관리자 함수 올리기',
    text: '관리자 함수 코드를 <b>방금 복사해 뒀어요</b>. 열리는 화면에서 <b>Deploy a new function → Via Editor</b>를 고르고, 내용을 지운 뒤 <b>Ctrl + V</b>. 이름은 <b>admin-users</b>로 하고 Deploy해요. 다 되면 함수 설정에서 <b>Verify JWT</b>를 꺼요.',
    enter: () => window.widget.copySetup('function'),
    buttons: [['Edge Functions 열기', site('/project/{ref}/functions')], ['코드 다시 복사', () => window.widget.copySetup('function')]],
    check: 'function',
  },
  {
    title: '6. 첫 관리자 만들기',
    text: '열리는 화면에서 <b>Add user → Create new user</b>를 눌러요.<br>· Email: <b>admin@example.com</b><br>· Password: 관리자 비밀번호<br>· <b>Auto Confirm User</b> 체크<br>만든 뒤 그 비밀번호를 아래 칸에 넣으면 로그인이 되는지 확인해요.',
    buttons: [['사용자 화면 열기', site('/project/{ref}/auth/users')]],
    input: ['password', '방금 정한 관리자 비밀번호', 'password'],
    check: 'admin',
  },
  {
    title: '7. 새 DB로 연결',
    text: '준비가 모두 끝났어요.<br>① 먼저 <b>[연결 코드 복사]</b>를 눌러 메신저로 직원들에게 보내 주세요. 직원들은 jple을 설치하고 처음 화면에서 이 코드를 붙여 넣으면 돼요.<br>② <b>[연결하고 다시 켜기]</b>를 누르면 이 PC의 jple이 새 DB로 바뀌고 다시 켜져요. <b>admin</b>과 방금 정한 비밀번호로 로그인하면 돼요.',
    buttons: [['🔗 연결 코드 복사', async () => copyCode(await window.widget.makeCode({ url: wiz.url, key: wiz.key }), (t) => { $('#wizard-ok').textContent = t })]],
    next: '연결하고 다시 켜기',
    finish: true,
  },
]

function showWizardStep() {
  const s = WIZARD[wiz.step]
  $('#wizard-steps').replaceChildren(...WIZARD.map((w, i) => h('li', {
    className: i < wiz.step ? 'done' : i === wiz.step ? 'current' : '', textContent: w.title.replace(/^\d+\.\s*/, ''),
  })))
  $('#wizard-title').textContent = s.title
  $('#wizard-text').innerHTML = s.text
  $('#wizard-actions').replaceChildren(...(s.buttons ?? []).map(([label, fn]) => h('button', { type: 'button', textContent: label, onclick: fn })))
  const input = $('#wizard-input')
  input.hidden = !s.input
  if (s.input) {
    input.placeholder = s.input[1]
    input.type = s.input[2] ?? 'text'
    input.value = s.input[0] === 'password' ? '' : wiz[s.input[0]] ?? ''
  }
  $('#wizard-error').textContent = ''
  $('#wizard-ok').textContent = ''
  $('#wizard-prev').disabled = wiz.step === 0
  $('#wizard-next').textContent = s.next ?? '확인하고 다음 ▶'
  s.enter?.()
}

$('#wizard-open').onclick = () => {
  wiz.step = 0
  wiz.url = ''
  wiz.key = ''
  $('#wizard').hidden = false
  showWizardStep()
}
// 아직 연결된 DB가 없는 PC에서 마법사를 닫으면 처음 설정 화면으로 돌아가요
$('#wizard-close').onclick = () => { $('#wizard').hidden = true; if (!state.configured) openSetup(false) }
$('#wizard-prev').onclick = () => { wiz.step = Math.max(0, wiz.step - 1); showWizardStep() }
$('#wizard-next').onclick = async () => {
  const s = WIZARD[wiz.step]
  if (s.finish) {
    if (!confirm('새 DB로 연결하고 jple을 다시 켤까요?')) return
    return window.widget.setConnection({ url: wiz.url, key: wiz.key })
  }
  if (s.input && s.input[0] !== 'password') wiz[s.input[0]] = $('#wizard-input').value.trim().replace(/\/+$/, '')
  if (s.check) {
    $('#wizard-error').textContent = ''
    $('#wizard-ok').textContent = '확인하는 중이에요…'
    const res = await window.widget.wizardCheck(s.check, { url: wiz.url, key: wiz.key, password: $('#wizard-input').value })
    $('#wizard-ok').textContent = ''
    if (res.error) return void ($('#wizard-error').textContent = `⚠ ${res.error}`)
  }
  wiz.step++
  showWizardStep()
  $('#wizard-ok').textContent = '✅ 앞 단계가 잘 끝났어요.'
}
// ── 연결 코드: 지금 DB 코드 복사, 처음 설정 화면(코드 넣기 / 새 DB 만들기) ──
async function copyCode(code, where) {
  await window.widget.copyText(code)
  where(`🔗 연결 코드를 복사했어요. 메신저로 직원들에게 보내 주세요.\n${code}`)
}
$('#db-copy-code').onclick = async () => {
  const conn = await window.widget.getConnection()
  copyCode(conn.code, dbMessage)
}
$('#db-other').onclick = () => { closeDb(); openSetup(true) }

// canClose: 이미 연결된 PC에서 "다른 DB에 연결"로 연 경우에만 닫을 수 있어요
function openSetup(canClose) {
  $$('.overlay').forEach((o) => { o.hidden = true })
  $('#setup-code').value = ''
  $('#server-pw').value = ''
  $('#server-pw2').value = ''
  $('#setup-error').textContent = ''
  $('#setup-ok').textContent = ''
  $('#setup-close').hidden = !canClose
  $('#setup').hidden = false
}
$('#setup-close').onclick = () => { $('#setup').hidden = true }
$('#setup-wizard').onclick = () => { $('#setup').hidden = true; $('#wizard-open').click() }
$('#setup-connect').onclick = async () => {
  const fail = (msg) => { $('#setup-ok').textContent = ''; $('#setup-error').textContent = `⚠ ${msg}` }
  const conn = await window.widget.readCode($('#setup-code').value)
  if (!conn) return fail('연결 코드가 맞지 않아요. 받은 코드를 처음부터 끝까지 그대로 붙여 넣어 주세요.')
  if (conn.old) return fail('예전(0.4.0 전) 로컬 연결 코드예요. 관리자에게 새 연결 코드를 받아 주세요.')
  $('#setup-error').textContent = ''
  $('#setup-ok').textContent = '확인하는 중이에요…'
  for (const step of conn.type === 'local' ? ['local'] : ['url', 'key', 'function']) {
    const res = await window.widget.wizardCheck(step, conn)
    if (res.error) return fail(`이 DB에 연결하지 못했어요. 관리자에게 문의해 주세요. (${res.error})`)
  }
  $('#setup-ok').textContent = '✅ 연결할 수 있어요. jple을 다시 켤게요.'
  setTimeout(() => window.widget.setConnection(conn), 800)
}
// 이 PC를 로컬 서버로: admin 계정과 부서를 만들고 jple을 다시 켜요
$('#server-start').onclick = async () => {
  const fail = (msg) => { $('#setup-ok').textContent = ''; $('#setup-error').textContent = `⚠ ${msg}` }
  const pw = $('#server-pw').value
  if (pw.length < 8) return fail('관리자 비밀번호는 8자 이상이어야 해요.')
  if (pw !== $('#server-pw2').value) return fail('두 비밀번호가 달라요.')
  if (!confirm('이 PC를 jple 서버로 정할까요?\n이 PC는 윈도우와 함께 jple이 켜지게 돼요.\n다음에 "액세스 허용" 창이 뜨면 허용을 눌러 주세요.')) return
  $('#setup-error').textContent = ''
  $('#setup-ok').textContent = '서버를 준비하는 중이에요…'
  const res = await window.widget.startServer(pw)
  if (res?.error) fail(res.error)
}

// ── 전체 비밀번호 초기화 (관리자 제외). 관리자 비밀번호는 서버에서 다시 확인해요 ──
$('#reset-all-open').onclick = async () => {
  await loadBasics()
  const count = state.profiles.filter((p) => !p.is_admin).length
  $('#reset-all-note').textContent = `⚠ 관리자를 뺀 ${count}명의 비밀번호가 모두 아래 비밀번호로 바뀌어요. 각자 다음 로그인 때 새 비밀번호를 정해야 해요.`
  $('#reset-all-pw').value = defaultPassword
  $('#reset-all-admin-pw').value = ''
  $('#reset-all-error').textContent = ''
  $('#reset-all').hidden = false
  $('#reset-all-admin-pw').focus()
}
$('#reset-all-cancel').onclick = () => { $('#reset-all').hidden = true }
$('#reset-all-form').onsubmit = async (e) => {
  e.preventDefault()
  $('#reset-all-error').textContent = '처리하는 중이에요…'
  const res = await window.api.admin({
    action: 'reset_all', password: $('#reset-all-pw').value, admin_password: $('#reset-all-admin-pw').value,
  })
  $('#reset-all-admin-pw').value = ''
  if (res.error) return void ($('#reset-all-error').textContent = res.error)
  $('#reset-all').hidden = true
  adminMessage(`${res.done}명의 비밀번호를 초기화했어요.${res.failed ? ` ⚠ ${res.failed}명은 실패했어요.` : ''}`)
  refreshAccounts()
}

// 계정 목록도 눌러서 펼치고 접어요. 버튼에 인원수를 보여 줘요
function accountsToggleLabel() {
  const open = !$('#accounts-panel').hidden
  $('#accounts-toggle').textContent = `${open ? '▾' : '▸'} 계정 목록 (${state.profiles.length}명)`
}
$('#accounts-toggle').onclick = () => {
  $('#accounts-panel').hidden = !$('#accounts-panel').hidden
  accountsToggleLabel()
}

// ── 계정 엑셀 받기: 빈 양식(새 사람 추가용)과 전체 명단(고치기용) ──
async function exportAccounts(withPeople) {
  await loadBasics()
  const categoryName = (id) => state.categories.find((c) => c.id === id)?.name ?? ''
  const rows = withPeople ? state.profiles.map((p) => ({
    name: p.name, login_id: p.login_id, category: categoryName(p.default_category_id), is_admin: p.is_admin,
  })) : []
  const res = await window.widget.exportAccounts(rows, state.categories.map((c) => c.name),
    withPeople ? '계정목록(전체).xlsx' : '계정추가양식.xlsx')
  if (res?.ok) adminMessage(`${withPeople ? '전체 명단' : '빈 양식'}을 저장했어요. (${res.filePath})`)
}
$('#accounts-template').onclick = () => exportAccounts(false)
$('#accounts-export').onclick = () => exportAccounts(true)

// ── 계정 목록 엑셀 올리기: 새 아이디는 만들고, 있는 아이디는 바뀐 것만 고쳐요 ──
$('#accounts-import').onclick = async () => {
  const res = await window.widget.importAccounts()
  if (!res?.ok) return
  await loadBasics()
  const byId = new Map(state.profiles.map((p) => [p.login_id, p]))
  const categoryId = (name) => (name ? state.categories.find((c) => c.name === name)?.id : null)
  const problems = []
  const jobs = []

  for (const r of res.rows) {
    const where = `${r.row}번째 줄`
    if (!/^[a-z0-9._-]{3,30}$/.test(r.login_id)) { problems.push(`${where}: 아이디 형식이 맞지 않아요`); continue }
    const catId = categoryId(r.category)
    if (r.category && catId === undefined) { problems.push(`${where}: '${r.category}' 부서가 없어요`); continue }
    const p = byId.get(r.login_id)
    if (!p) {
      const password = r.password || defaultPassword
      if (!r.name) { problems.push(`${where}: 이름이 비어 있어요`); continue }
      if (password.length < 8) { problems.push(`${where}: 비밀번호가 8자보다 짧거나 비어 있어요`); continue }
      jobs.push({ label: `${r.name} 만들기`, body: { action: 'create', name: r.name, login_id: r.login_id, password, default_category_id: catId ?? null, is_admin: r.is_admin } })
      continue
    }
    const newCat = r.category ? catId : p.default_category_id
    if ((r.name && r.name !== p.name) || newCat !== p.default_category_id) {
      jobs.push({ label: `${p.name} 정보 바꾸기`, body: { action: 'update', user_id: p.id, name: r.name || p.name, default_category_id: newCat } })
    }
    if (r.is_admin !== p.is_admin) jobs.push({ label: `${p.name} 관리자 권한`, body: { action: 'set_admin', user_id: p.id, is_admin: r.is_admin } })
    if (r.password) {
      if (r.password.length < 8) { problems.push(`${where}: 비밀번호가 8자보다 짧아요`); continue }
      jobs.push({ label: `${p.name} 비밀번호 초기화`, body: { action: 'reset_password', user_id: p.id, password: r.password } })
    }
  }

  if (!jobs.length) return adminMessage(problems.length ? `⚠ 반영할 내용이 없어요. ${problems.join(' / ')}` : '바뀐 내용이 없어요.')
  const creates = jobs.filter((j) => j.body.action === 'create').length
  if (!confirm(`새 계정 ${creates}개, 고칠 항목 ${jobs.length - creates}개를 반영할까요?${problems.length ? `\n(건너뛸 줄 ${problems.length}개)` : ''}`)) return

  let done = 0
  for (const job of jobs) {
    adminMessage(`반영하는 중이에요… (${done + 1}/${jobs.length})`)
    const r = await window.api.admin(job.body)
    if (r.error) problems.push(`${job.label}: ${r.error}`)
    else done++
  }
  await refreshAccounts()
  adminMessage(`${done}건 반영했어요.${problems.length ? ` ⚠ ${problems.join(' / ')}` : ''}`)
}

// ── 구분(부서) 관리 ──
const categoryMessage = (text) => { $('#category-message').textContent = text }

async function categoryCall(promise, done) {
  categoryMessage('처리하는 중이에요…')
  const res = await promise
  if (res.error) return categoryMessage(`⚠ ${res.error}`)
  categoryMessage(typeof done === 'function' ? done(res) : done)
  await refreshAccounts()
  render()
}

function renderCategories() {
  const list = state.categories
  $('#category-rows').replaceChildren(...list.map((c, i) => {
    const save = (patch, msg) => categoryCall(window.api.saveCategory({ id: c.id, name: c.name, color: c.color, ...patch }), msg)
    // 위아래 구분과 순서를 맞바꿔요
    const swap = (other) => other && categoryCall(Promise.all([
      window.api.saveCategory({ id: c.id, name: c.name, color: c.color, sort_order: other.sort_order }),
      window.api.saveCategory({ id: other.id, name: other.name, color: other.color, sort_order: c.sort_order }),
    ]).then((rs) => rs.find((r) => r.error) ?? { ok: true }), '순서를 바꿨어요.')
    return h('div', { className: 'category-row' },
      h('input', { type: 'color', value: c.color, onchange: (e) => save({ color: e.target.value }, `${c.name} 색을 바꿨어요.`) }),
      h('input', {
        type: 'text', value: c.name,
        onchange: (e) => e.target.value.trim()
          ? save({ name: e.target.value.trim() }, '이름을 바꿨어요.')
          : (e.target.value = c.name),
      }),
      h('button', { textContent: '▲', title: '위로', disabled: i === 0, onclick: () => swap(list[i - 1]) }),
      h('button', { textContent: '▼', title: '아래로', disabled: i === list.length - 1, onclick: () => swap(list[i + 1]) }),
      h('button', {
        className: 'danger', textContent: '삭제',
        onclick: () => confirm(`'${c.name}' 구분을 삭제할까요?`) && categoryCall(window.api.deleteCategory(c.id),
          (res) => res.hidden ? `'${c.name}'은 일정이나 계정이 쓰고 있어서 목록에서 숨겼어요.` : `'${c.name}'을 삭제했어요.`),
      }))
  }))
}

$('#category-form').onsubmit = (e) => {
  e.preventDefault()
  const name = $('#cat-name').value.trim()
  categoryCall(window.api.saveCategory({ name, color: $('#cat-color').value }), `'${name}' 구분을 추가했어요.`)
  $('#cat-name').value = ''
}

// 비밀번호 초기화: 그 줄에 새 처음 비밀번호 입력 칸을 띄워요
function askNewPassword(p, cell) {
  const input = h('input', { placeholder: '새 처음 비밀번호 (8자 이상)', size: 18, value: defaultPassword })
  cell.replaceChildren(input, ' ',
    h('button', {
      className: 'primary', textContent: '확인',
      onclick: () => adminCall({ action: 'reset_password', user_id: p.id, password: input.value },
        `${p.name}님 비밀번호를 초기화했어요. 다음 로그인 때 새 비밀번호를 정하게 돼요.`),
    }), ' ',
    h('button', { textContent: '취소', onclick: refreshAccounts }))
  input.focus()
}

$('#account-form').onsubmit = async (e) => {
  e.preventDefault()
  const name = $('#acc-name').value.trim()
  await adminCall({
    action: 'create',
    name,
    login_id: $('#acc-id').value.trim().toLowerCase(),
    password: $('#acc-pw').value,
    default_category_id: Number($('#acc-category').value),
    is_admin: $('#acc-admin').checked,
  }, `${name}님 계정을 만들었어요. 아이디와 처음 비밀번호를 알려 주세요.`)
  if (!$('#admin-message').textContent.startsWith('⚠')) {
    e.target.reset()
    $('#acc-pw').value = defaultPassword
  }
}

// ── 오른쪽 아래 모서리를 끌어서 크기 바꾸기 ──
$('#grip').addEventListener('pointerdown', (e) => {
  const grip = e.currentTarget
  grip.setPointerCapture(e.pointerId)
  // 투명 창에서는 outerWidth가 실제 크기를 따라오지 않아서 innerWidth를 써요
  const start = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight }
  const move = (ev) => window.widget.resize(start.w + ev.screenX - start.x, start.h + ev.screenY - start.y)
  grip.addEventListener('pointermove', move)
  grip.addEventListener('pointerup', () => grip.removeEventListener('pointermove', move), { once: true })
})

// ── 시작 ──
render()
window.api.authState().then((res) => {
  state.configured = res.configured
  if (res.error) return openLogin(res.error)
  // 연결된 DB가 없으면(새로 설치한 PC) 처음 설정 화면을 띄워요
  if (!res.configured) return openSetup(false)
  if (res.user) enter(res.user)
  else openLogin()
})
