import { RL, rk, sk, evaluate, handName, cleanName, fmt } from '../shared/engine';
import { startLobby } from './lobby';
import { PROTOCOL, NSEAT, type ClientMsg, type HandView, type ServerMsg, type TableView, type YouView } from '../shared/protocol';

/* ================= identity: table code + player token ================= */

// Rooms are issued by the lobby now, so an address without a code is the lobby
// itself rather than an invitation to mint a table.
const CODE = (() => {
  const m = location.pathname.match(/^\/t\/([a-z0-9]{4,16})\/?$/i);
  if (!m) return '';
  const c = m[1].toLowerCase();
  if (location.pathname !== '/t/' + c) history.replaceState(null, '', '/t/' + c);
  return c;
})();

const TOKEN = (() => {
  const mk = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
  try {
    let t = localStorage.getItem('holdem.token');
    if (!t || !/^[A-Za-z0-9-]{16,64}$/.test(t)) { t = mk(); localStorage.setItem('holdem.token', t); }
    return t;
  } catch { return mk(); }
})();

/* ================= state ================= */

let T: TableView | null = null;
let YOU: YouView = { seat: -1, cards: null };
let conn: 'connecting' | 'open' | 'closed' = 'connecting';
let turnDeadline = 0;
let pending: { hand: string; seq: number } | null = null;
let joinPref = -1, joinShownOnce = false, renameMode = false;
let standArmed = 0, raiseTo = 0, turnKey = '';
/* The room password lives in sessionStorage, not localStorage: closing the tab
   should ask again. `dead` stops the reconnect loop once the room is gone. */
let pw: string | null = null;
let dead = false;
try { pw = CODE ? sessionStorage.getItem('holdem.pw.' + CODE) : null; } catch { /* private mode */ }

const SU = ['♠︎', '♥︎', '♦︎', '♣︎'];
const SUN = ['스페이드', '하트', '다이아몬드', '클럽'];
const STREET: Record<string, string> = { preflop: '프리플롭', flop: '플롭', turn: '턴', river: '리버', showdown: '쇼다운' };
const isRed = (c: number) => sk(c) === 1 || sk(c) === 2;

/* ================= DOM ================= */

const $ = <E extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as E;
const tableEl = $('#table'), logEl = $('#log'), standEl = $('#stand'), infoEl = $('#info'), ctrlEl = $('#ctrl');
const sizerEl = $('#sizer');
const bFold = $<HTMLButtonElement>('#bFold'), bCall = $<HTMLButtonElement>('#bCall'), bRaise = $<HTMLButtonElement>('#bRaise');
const rRange = $<HTMLInputElement>('#rRange'), rInput = $<HTMLInputElement>('#rInput');
const presetBtns = [...document.querySelectorAll<HTMLButtonElement>('#presets button')];
const boardEls = [...document.querySelectorAll<HTMLElement>('#board .card')];
const ovJoin = $('#ovJoin'), ovRanks = $('#ovRanks'), nameIn = $<HTMLInputElement>('#nameIn'), joinErr = $('#joinErr');
const ovPw = $('#ovPw'), ovGone = $('#ovGone'), pwIn = $<HTMLInputElement>('#pwIn'), pwErr = $('#pwErr');
const btnJoin = $<HTMLButtonElement>('#btnJoin'), btnAway = $<HTMLButtonElement>('#btnAway'), btnRebuy = $<HTMLButtonElement>('#btnRebuy');
const btnStand = $<HTMLButtonElement>('#btnStand'), btnRename = $<HTMLButtonElement>('#btnRename');

interface SeatEl {
  root: HTMLElement; cards: HTMLElement[]; dot: HTMLElement; nmt: HTMLElement; stk: HTMLElement; hn: HTMLElement;
  timer: HTMLElement; bar: HTMLElement; act: HTMLElement; d: HTMLElement; sit: HTMLButtonElement; bet: HTMLElement; betAmt: HTMLElement;
}
const seats: SeatEl[] = Array.from({ length: NSEAT }, (_, i) => {
  const root = document.createElement('div');
  root.className = 'seat vacant'; root.dataset.pos = String(i);
  root.innerHTML =
    '<div class="hole"><div class="card empty" role="img"></div><div class="card empty" role="img"></div></div>' +
    '<div class="plate"><div class="nm"><span class="dot" hidden></span><span class="nmt">빈 자리</span></div><div class="stk"></div>' +
    '<div class="hn" hidden></div><div class="timer" hidden><i></i></div></div>' +
    '<div class="act"></div><div class="dbtn" title="딜러 버튼" hidden>D</div>' +
    '<button type="button" class="sitbtn" hidden>여기 앉기</button>';
  tableEl.appendChild(root);
  const bet = document.createElement('div');
  bet.className = 'bet'; bet.dataset.pos = String(i); bet.hidden = true;
  bet.innerHTML = '<span class="disc" aria-hidden="true"></span><span class="amt"></span>';
  tableEl.appendChild(bet);
  const q = (s: string) => root.querySelector(s) as HTMLElement;
  const o: SeatEl = {
    root, cards: [...root.querySelectorAll<HTMLElement>('.card')], dot: q('.dot'), nmt: q('.nmt'), stk: q('.stk'), hn: q('.hn'),
    timer: q('.timer'), bar: q('.timer i'), act: q('.act'), d: q('.dbtn'), sit: q('.sitbtn') as HTMLButtonElement,
    bet, betAmt: bet.querySelector('.amt') as HTMLElement,
  };
  o.sit.addEventListener('click', () => openJoin(i));
  return o;
});

function faceHTML(c: number) { return `<span class="ix"><b>${RL[rk(c)]}</b><i>${SU[sk(c)]}</i></span><span class="pip">${SU[sk(c)]}</span>`; }
function cardName(c: number) { return `${SUN[sk(c)]} ${RL[rk(c)]}`; }
function setCard(el: HTMLElement, mode: 'face' | 'back' | 'empty', c: number | null = null, backKey = '', delay?: number) {
  const key = mode === 'face' ? 'f' + c : mode === 'back' ? 'b' + backKey : 'e';
  if (el.dataset.key === key) return;
  const prev = el.dataset.key || 'e';
  el.dataset.key = key;
  el.classList.remove('back', 'red', 'empty', 'anim-deal', 'anim-flip', 'hl', 'lo');
  el.style.animationDelay = '';
  if (mode === 'empty') { el.classList.add('empty'); el.innerHTML = ''; el.removeAttribute('aria-label'); return; }
  if (mode === 'back') { el.classList.add('back'); el.innerHTML = ''; el.setAttribute('aria-label', '뒤집힌 카드'); }
  else { if (isRed(c!)) el.classList.add('red'); el.innerHTML = faceHTML(c!); el.setAttribute('aria-label', cardName(c!)); }
  void el.offsetWidth;
  el.classList.add(prev.startsWith('b') && mode === 'face' ? 'anim-flip' : 'anim-deal');
  if (delay) el.style.animationDelay = delay + 'ms';
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { t.hidden = true; }, 3800);
}

/* ================= connection ================= */

let ws: WebSocket | null = null, retry = 0, pingTimer = 0;
function connect() {
  conn = 'connecting'; render();
  const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${CODE}`);
  ws = s;
  s.onopen = () => {
    retry = 0; conn = 'open';
    s.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token: TOKEN, ...(pw ? { password: pw } : {}) } satisfies ClientMsg));
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => { if (s.readyState === WebSocket.OPEN) s.send('ping'); }, 25000);
  };
  s.onmessage = e => {
    if (e.data === 'pong') return;
    let m: ServerMsg;
    try { m = JSON.parse(e.data); } catch { return; }
    onMsg(m);
  };
  s.onclose = () => {
    if (ws !== s || dead) return;
    conn = 'closed'; clearInterval(pingTimer); render();
    const d = [800, 1500, 3000, 6000, 12000][Math.min(retry++, 4)];
    setTimeout(connect, d);
  };
}
function send(m: ClientMsg): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(m)); return true; }
  toast('연결이 끊겨 있습니다. 다시 연결되면 눌러 주세요');
  return false;
}
function onMsg(m: ServerMsg) {
  if (m.t === 'reload') {
    let last = 0; try { last = Number(sessionStorage.getItem('holdem.reload') || 0); } catch { /* */ }
    if (Date.now() - last > 60000) {
      try { sessionStorage.setItem('holdem.reload', String(Date.now())); } catch { /* */ }
      toast('새 버전이 배포되어 페이지를 다시 불러옵니다');
      setTimeout(() => location.reload(), 1200);
    } else toast('새 버전을 불러오지 못했습니다. 페이지를 새로고침해 주세요');
    return;
  }
  if (m.t === 'error') {
    if (m.code === 'no_room') { showGone(); return; }
    if (m.code === 'pw_required' || m.code === 'pw_wrong' || m.code === 'pw_wait') {
      // Only a wrong password is discarded. `pw_wait` is returned before the
      // password is even checked, so the one we hold may well be the right one.
      if (m.code === 'pw_wrong') { pw = null; try { sessionStorage.removeItem('holdem.pw.' + CODE); } catch { /* */ } }
      showPw(m.code === 'pw_required' ? '' : m.msg, m.code === 'pw_wait');
      return;
    }
    if (!ovJoin.hidden) { joinErr.textContent = m.msg; joinErr.hidden = false; }
    else toast(m.msg);
    return;
  }
  ovPw.hidden = true;   // a state message means the password went through
  T = m.table; YOU = m.you;
  const h = T.hand;
  turnDeadline = h && h.phase === 'bet' && h.toAct >= 0 ? Date.now() + h.turnLeft : 0;
  if (pending && (!h || h.id !== pending.hand || h.seq !== pending.seq || h.phase !== 'bet')) pending = null;
  if (YOU.seat >= 0 && !ovJoin.hidden && !renameMode) closeJoin();
  if (YOU.seat < 0 && !joinShownOnce){ joinShownOnce = true; openJoin(-1); }
  render();
}

/* ================= view helpers ================= */

const hand = (): HandView | null => (T && T.hand) || null;
const mySeat = () => YOU.seat;
function liveIdx(h: HandView) { const o: number[] = []; h.ps.forEach((p, i) => { if (p && !p.folded) o.push(i); }); return o; }
function totalPot(h: HandView) { return h.pot + h.ps.reduce((a, p) => a + (p ? p.bet : 0), 0); }
function turnLeft() { return Math.max(0, turnDeadline - Date.now()); }
function myHandText(h: HandView, cards: number[]) {
  if (h.board.length >= 3) return handName(evaluate(cards.concat(h.board)));
  const [a, b] = cards, ra = rk(a), rb = rk(b), hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  if (ra === rb) return `포켓 ${RL[hi]}${RL[hi]}`;
  return `${RL[hi]}${RL[lo]} ${sk(a) === sk(b) ? '수딧' : '오프수트'}`;
}
function esc(s: string) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/* ================= render ================= */

let lastHandId: string | null = null, lastBoardLen = 0, logSig = '';
function render() {
  const h = hand();
  const ms = mySeat();
  const anchor = ms >= 0 ? ms : 0;
  const hl = h && h.hl ? new Set(h.hl) : null;
  const dealDelay = new Map<string, number>();
  if (h && h.id !== lastHandId) {
    lastHandId = h.id; lastBoardLen = 0;
    h.order.forEach((seat, k) => { dealDelay.set(seat + ':0', k * 85); dealDelay.set(seat + ':1', (h.order.length + k) * 85); });
  }
  if (!h) { lastHandId = null; lastBoardLen = 0; }

  $('#mCode').textContent = CODE;
  $('#mBlinds').textContent = T ? `${fmt(T.cfg.sb)}/${fmt(T.cfg.bb)}` : '—';
  $('#mBuyin').textContent = T ? fmt(T.cfg.buyin) : '—';
  $('#mHand').textContent = T && T.handNo ? '#' + T.handNo : '—';
  $('#mOnlineN').textContent = String(T ? T.online : 0);

  const showSit = conn === 'open' && ms < 0;
  for (let i = 0; i < NSEAT; i++) {
    const e = seats[i], pos = (i - anchor + NSEAT) % NSEAT;
    e.root.dataset.pos = String(pos); e.bet.dataset.pos = String(pos);
    const s = T ? T.seats[i] : null;
    const p = h ? h.ps[i] : null;
    const cl = e.root.classList;
    cl.toggle('vacant', !s);
    cl.toggle('me', !!s && i === ms);
    e.sit.hidden = !!s || !showSit;
    if (!s) {
      e.nmt.textContent = '빈 자리'; e.stk.textContent = ''; e.dot.hidden = true; e.hn.hidden = true; e.timer.hidden = true;
      e.act.textContent = ''; e.act.className = 'act'; e.d.hidden = true; e.bet.hidden = true;
      cl.remove('turn', 'folded', 'win', 'away');
      e.cards.forEach(el => setCard(el, 'empty'));
      continue;
    }
    e.nmt.textContent = s.name;
    e.stk.textContent = fmt(s.stack);
    e.dot.hidden = false;
    e.dot.classList.toggle('on', s.online);
    const turn = !!h && h.phase === 'bet' && h.toAct === i;
    cl.toggle('turn', turn);
    cl.toggle('folded', !!p && p.folded);
    cl.toggle('win', !!p && p.win);
    cl.toggle('away', !p && (s.away || s.idle || s.stack === 0 || s.leaving));
    let lab = '', cls = '';
    if (p) {
      lab = p.label || '';
      if (turn) { lab = i === ms ? '내 차례' : '생각 중'; cls = i === ms ? 'mine' : 'think'; }
      else if (p.win) cls = 'win';
      else if (lab.startsWith('올인')) cls = 'allin';
      else if (lab.startsWith('폴드')) cls = 'fold';
      else if (lab.startsWith('레이즈') || lab.startsWith('벳')) cls = 'aggr';
    } else {
      lab = s.leaving ? '나가는 중' : s.stack === 0 ? '바이인 대기' : (s.away || s.idle) ? '자리 비움' : (h && h.phase === 'bet') ? '다음 핸드부터' : '';
    }
    if (!lab && !s.online) lab = '오프라인';
    e.act.textContent = lab;
    e.act.className = 'act' + (cls ? ' ' + cls : '');
    e.d.hidden = !(h && h.dealer === i);
    e.timer.hidden = !turn;
    const mine = i === ms && !!p && !!YOU.cards;
    e.cards.forEach((el, k) => {
      let mode: 'face' | 'back' | 'empty' = 'empty', c: number | null = null;
      if (p) {
        if (mine) { mode = 'face'; c = YOU.cards![k]; }
        else if (p.shown) { mode = 'face'; c = p.shown[k]; }
        else if (!p.folded) mode = 'back';
      }
      setCard(el, mode, c, h ? `${h.id}:${i}:${k}` : '', dealDelay.get(i + ':' + k));
      const vis = mode === 'face';
      el.classList.toggle('hl', !!hl && vis && hl.has(c!));
      el.classList.toggle('lo', !!hl && vis && !hl.has(c!));
    });
    if (mine && h) { e.hn.hidden = false; e.hn.textContent = myHandText(h, YOU.cards!); }
    else e.hn.hidden = true;
    e.bet.hidden = !(p && p.bet > 0);
    if (p) e.betAmt.textContent = fmt(p.bet);
  }

  boardEls.forEach((el, k) => {
    const c = h ? h.board[k] : undefined;
    if (c === undefined) setCard(el, 'empty');
    else setCard(el, 'face', c, '', k >= lastBoardLen ? (h!.runout ? 260 : 0) + (k - lastBoardLen) * 110 : 0);
    el.classList.toggle('hl', !!hl && c !== undefined && hl.has(c));
    el.classList.toggle('lo', !!hl && c !== undefined && !hl.has(c));
  });
  lastBoardLen = h ? h.board.length : 0;

  const street = $('#street'), verdict = $('#verdict'), pot = $('#pot');
  let vText = '', quiet = false;
  if (!T) { street.textContent = conn === 'closed' ? '연결 끊김' : '연결 중'; quiet = true; }
  else if (!h) {
    street.textContent = '대기 중';
    const n = T.seats.filter(Boolean).length;
    vText = n < 2 ? '두 명 이상 앉으면 시작합니다' : '참가할 수 있는 플레이어를 기다리는 중입니다';
    quiet = true;
  }
  else if (h.phase === 'over') { street.textContent = h.street === 'showdown' ? '쇼다운' : '핸드 종료'; vText = h.verdict || ''; }
  else street.textContent = STREET[h.street];
  verdict.hidden = !vText; verdict.textContent = vText; verdict.classList.toggle('quiet', quiet);
  pot.hidden = !!vText;
  $('#potAmt').textContent = h ? fmt(h.pot) : '0';

  renderTools(ms);
  renderControls(ms);
  renderSide();
  tick();
}

function renderTools(ms: number) {
  const s = ms >= 0 && T ? T.seats[ms] : null;
  const h = hand();
  btnJoin.hidden = !!s;
  btnJoin.disabled = conn !== 'open';
  btnRebuy.hidden = !(s && s.stack === 0 && !s.leaving && !(h && h.phase === 'bet' && h.ps[ms]));
  btnAway.hidden = !s;
  btnAway.textContent = s && (s.away || s.idle) ? '복귀' : '자리 비움';
  btnRename.hidden = !s;
  btnStand.hidden = !s;
  if (!s && standArmed) { standArmed = 0; btnStand.textContent = '일어나기'; btnStand.classList.remove('warn'); }
}

function sizing(ms: number) {
  const h = hand()!, s = T!.seats[ms]!, p = h.ps[ms]!;
  const toCall = Math.max(0, h.cur - p.bet);
  const total = totalPot(h);
  const maxTo = p.bet + s.stack;
  const minTo = Math.min(maxTo, h.cur === 0 ? T!.cfg.bb : h.cur + h.minR);
  return { toCall, total, maxTo, minTo, stack: s.stack };
}
function setRaise(v: number, ms: number) {
  const z = sizing(ms), step = T!.cfg.sb;
  if (!isFinite(v)) v = z.minTo;
  if (v >= z.maxTo - step / 2) v = z.maxTo; else v = Math.round(v / step) * step;
  v = Math.max(z.minTo, Math.min(z.maxTo, v));
  raiseTo = v;
  rRange.min = String(z.minTo); rRange.max = String(z.maxTo); rRange.value = String(v);
  rInput.min = String(z.minTo); rInput.max = String(z.maxTo); rInput.step = String(step); rInput.value = String(v);
  $('#bRaiseLbl').textContent = z.stack <= z.toCall ? '레이즈' : v >= z.maxTo ? `올인 ${fmt(v)}` : hand()!.cur === 0 ? `벳 ${fmt(v)}` : `레이즈 ${fmt(v)}`;
}
function isMyTurn(ms: number) {
  const h = hand();
  if (!h || ms < 0 || h.phase !== 'bet' || h.toAct !== ms || !h.ps[ms] || conn !== 'open') return false;
  return !(pending && pending.hand === h.id && pending.seq === h.seq);
}

function renderControls(ms: number) {
  const h = hand();
  const s = ms >= 0 && T ? T.seats[ms] : null;
  const p = h && ms >= 0 ? h.ps[ms] : null;
  const myTurn = isMyTurn(ms);
  ctrlEl.classList.toggle('live', myTurn);
  let info = '', canRaise = false;
  const tl = `<span id="tLeft">${Math.ceil(turnLeft() / 1000)}</span>초`;
  if (conn === 'closed') info = '서버와 연결이 끊겼습니다 · 다시 연결하는 중입니다';
  else if (!T) info = '테이블에 연결하는 중입니다';
  else if (myTurn && h) {
    const z = sizing(ms);
    canRaise = z.stack > z.toCall;
    $('#bCallLbl').textContent = z.toCall === 0 ? '체크' : z.toCall >= z.stack ? `올인 콜 ${fmt(z.stack)}` : `콜 ${fmt(z.toCall)}`;
    const key = `${h.id}|${h.seq}`;
    if (turnKey !== key) { turnKey = key; setRaise(z.minTo, ms); } else setRaise(raiseTo, ms);
    info = (z.toCall > 0
      ? `콜 <b>${fmt(z.toCall)}</b> · 총 팟 <b>${fmt(z.total)}</b>`
      : `체크할 수 있습니다 · 총 팟 <b>${fmt(z.total)}</b>`) + ` · 남은 시간 <b>${tl}</b>`;
  } else if (pending && h && pending.hand === h.id && pending.seq === h.seq) {
    info = '보냈습니다 · 테이블에 반영되기를 기다리는 중입니다';
  } else if (h && h.phase === 'over' && h.results) {
    info = h.results.map(r => `${r.pot} <b>${fmt(r.amount)}</b> → <b>${esc(r.names.join(' · '))}</b>${r.names.length > 1 ? ' 분할' : ''}${r.hand ? ' · ' + r.hand : ''}`).join('<br>') + '<br>잠시 후 다음 핸드가 시작됩니다';
  } else if (!s) {
    info = '관전 중입니다 · 참가하기를 누르거나 빈 자리를 골라 앉으세요';
  } else if (s.stack === 0 && !p) {
    info = `칩을 모두 잃었습니다 · 다시 바이인을 누르면 ${fmt(T.cfg.buyin)}칩으로 계속합니다`;
  } else if ((s.away || s.idle) && !p) {
    info = '자리 비움 상태입니다 · 복귀를 누르면 다음 핸드부터 참여합니다';
  } else if (!h) {
    info = '다른 플레이어를 기다리는 중입니다 · 링크 복사를 눌러 친구에게 보내세요';
  } else if (!p) {
    info = '다음 핸드부터 참여합니다';
  } else if (p.folded) {
    info = '폴드했습니다 · 이번 핸드가 끝나기를 기다립니다';
  } else if (p.allIn) {
    info = `올인했습니다 · 총 팟 <b>${fmt(totalPot(h))}</b>`;
  } else if (h.toAct >= 0 && T.seats[h.toAct]) {
    info = `<b>${esc(T.seats[h.toAct]!.name)}</b> 님 차례입니다 · 남은 시간 <b>${tl}</b> · 총 팟 <b>${fmt(totalPot(h))}</b>`;
  } else info = `총 팟 <b>${fmt(totalPot(h))}</b>`;

  bFold.disabled = !myTurn; bCall.disabled = !myTurn;
  bRaise.disabled = !(myTurn && canRaise);
  [rRange, rInput, ...presetBtns].forEach(b => { b.disabled = !(myTurn && canRaise); });
  sizerEl.classList.toggle('off', myTurn && !canRaise);

  infoEl.innerHTML = info;
}

function renderSide() {
  standEl.textContent = '';
  const h = hand();
  const rows = T ? T.seats.flatMap((s, i) => s ? [{ s, chips: s.stack + (h && h.phase === 'bet' && h.ps[i] ? h.ps[i]!.total : 0), me: i === mySeat() }] : []) : [];
  rows.sort((a, b) => b.chips - a.chips);
  $('#standSub').textContent = rows.length ? `${rows.length}/${NSEAT}` : '';
  if (!rows.length) { const li = document.createElement('li'); li.innerHTML = '<span class="none">아직 앉은 사람이 없습니다</span>'; standEl.appendChild(li); }
  for (const { s, chips, me } of rows) {
    const li = document.createElement('li');
    const nn = document.createElement('span'); nn.className = 'nn'; nn.textContent = s.name;
    if (me) { const sm = document.createElement('small'); sm.textContent = '나'; nn.appendChild(sm); }
    const sv = document.createElement('span'); sv.className = 'sv'; sv.textContent = fmt(chips);
    const net = chips - s.buyins * T!.cfg.buyin;
    const nt = document.createElement('span'); nt.className = 'nt' + (net > 0 ? ' up' : net < 0 ? ' dn' : '');
    nt.textContent = (net > 0 ? '+' : net < 0 ? '−' : '±') + fmt(Math.abs(net));
    nt.title = `바이인 ${s.buyins}회`;
    li.append(nn, sv, nt); standEl.appendChild(li);
  }
  const L = T ? T.log : [];
  const sig = L.length ? L[0].i + ':' + L[L.length - 1].i : '';
  if (sig === logSig) return;
  logSig = sig;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.textContent = '';
  const frag = document.createDocumentFragment();
  for (const en of L) {
    const li = document.createElement('li');
    if (en.c) li.className = en.c;
    for (const seg of en.t) {
      if (typeof seg === 'string') li.appendChild(document.createTextNode(seg));
      else if (seg[0] === 'b') { const b = document.createElement('b'); b.textContent = String(seg[1]); li.appendChild(b); }
      else if (seg[0] === 'c' && Number.isInteger(seg[1]) && seg[1] >= 0 && seg[1] < 52) {
        const c = seg[1], sp = document.createElement('span');
        sp.className = 'ct' + (isRed(c) ? ' r' : ''); sp.textContent = RL[rk(c)] + SU[sk(c)];
        li.appendChild(document.createTextNode(' ')); li.appendChild(sp);
      }
    }
    frag.appendChild(li);
  }
  logEl.appendChild(frag);
  if (atBottom || L.length < 12) logEl.scrollTop = logEl.scrollHeight;
}

/* the turn clock only ticks locally; the server owns the real deadline */
function tick() {
  const h = hand();
  const left = turnLeft();
  seats.forEach(e => {
    if (e.timer.hidden || !h) return;
    const f = Math.max(0, Math.min(1, left / (h.turnSecs * 1000)));
    e.bar.style.transform = `scaleX(${f})`;
    e.timer.classList.toggle('low', left < 8000);
  });
  const t = document.getElementById('tLeft');
  if (t) t.textContent = String(Math.ceil(left / 1000));
}
setInterval(tick, 250);

/* ================= actions ================= */

function sendAct(type: 'fold' | 'check' | 'call' | 'raise', to = 0) {
  const ms = mySeat(), h = hand();
  if (!h || !isMyTurn(ms)) return;
  if (!send({ t: 'act', hand: h.id, seq: h.seq, type, to: Math.round(to) })) return;
  pending = { hand: h.id, seq: h.seq };
  render();
}

function openJoin(pref: number) {
  const ms = mySeat();
  renameMode = ms >= 0;
  joinPref = renameMode ? -1 : pref;
  $('#joinTitle').textContent = renameMode ? '표시할 이름을 바꿉니다' : joinPref >= 0 ? `${joinPref + 1}번 자리에 앉습니다` : '이름을 입력하고 자리에 앉으세요';
  $('#joinBtn').textContent = renameMode ? '저장' : '앉기';
  $('#joinSub').textContent = T ? `바이인 ${fmt(T.cfg.buyin)}칩 · 블라인드 ${fmt(T.cfg.sb)}/${fmt(T.cfg.bb)} · 최대 ${NSEAT}명` : `최대 ${NSEAT}명`;
  $('#joinNote').textContent = T ? `핸드가 진행 중이면 다음 핸드부터 참여합니다. 차례마다 ${T.cfg.turn}초 안에 행동하지 않으면 자동으로 체크 또는 폴드됩니다.` : '';
  let nm = renameMode && T ? T.seats[ms]!.name : '';
  if (!nm) { try { nm = localStorage.getItem('holdem.name') || ''; } catch { /* */ } }
  nameIn.value = nm;
  joinErr.hidden = true;
  ovJoin.hidden = false;
  setTimeout(() => nameIn.focus(), 30);
}
function closeJoin() { ovJoin.hidden = true; renameMode = false; }

$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const nm = cleanName(nameIn.value);
  if (!nm) { joinErr.textContent = '이름을 한 글자 이상 입력하세요.'; joinErr.hidden = false; nameIn.focus(); return; }
  try { localStorage.setItem('holdem.name', nm); } catch { /* */ }
  if (renameMode) { if (send({ t: 'rename', name: nm })) closeJoin(); return; }
  send({ t: 'sit', name: nm, seat: joinPref >= 0 ? joinPref : undefined });
  // the sheet closes when the server confirms the seat; a refusal shows inside it
});
$('#watchOnly').addEventListener('click', closeJoin);
ovJoin.addEventListener('click', e => { if (e.target === ovJoin) closeJoin(); });

bFold.addEventListener('click', () => sendAct('fold'));
bCall.addEventListener('click', () => { const ms = mySeat(); if (!isMyTurn(ms)) return; sendAct(sizing(ms).toCall === 0 ? 'check' : 'call'); });
bRaise.addEventListener('click', () => sendAct('raise', raiseTo));
presetBtns.forEach(b => b.addEventListener('click', () => {
  const ms = mySeat(); if (!isMyTurn(ms)) return;
  const z = sizing(ms), cur = hand()!.cur;
  let v = z.minTo;
  if (b.dataset.p === 'half') v = cur + 0.5 * (z.total + z.toCall);
  else if (b.dataset.p === 'pot') v = cur + (z.total + z.toCall);
  else if (b.dataset.p === 'all') v = z.maxTo;
  setRaise(v, ms);
}));
rRange.addEventListener('input', () => { const ms = mySeat(); if (isMyTurn(ms)) setRaise(Number(rRange.value), ms); });
rInput.addEventListener('change', () => { const ms = mySeat(); if (isMyTurn(ms)) setRaise(Number(rInput.value), ms); });
rInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const ms = mySeat();
  if (isMyTurn(ms)) { setRaise(Number(rInput.value), ms); sendAct('raise', raiseTo); }
});

btnJoin.addEventListener('click', () => openJoin(-1));
btnRename.addEventListener('click', () => openJoin(-1));
btnAway.addEventListener('click', () => {
  const s = T && mySeat() >= 0 ? T.seats[mySeat()] : null;
  if (!s) return;
  send(s.away || s.idle ? { t: 'back' } : { t: 'away' });
});
btnRebuy.addEventListener('click', () => send({ t: 'rebuy' }));
btnStand.addEventListener('click', () => {
  const h = hand(), ms = mySeat();
  const inPlay = !!h && h.phase === 'bet' && !!h.ps[ms] && !h.ps[ms]!.folded;
  if (inPlay && Date.now() > standArmed) {
    standArmed = Date.now() + 3000;
    btnStand.textContent = '한 번 더 누르면 폴드하고 일어납니다'; btnStand.classList.add('warn');
    setTimeout(() => { if (Date.now() >= standArmed) { btnStand.textContent = '일어나기'; btnStand.classList.remove('warn'); } }, 3050);
    return;
  }
  standArmed = 0; btnStand.textContent = '일어나기'; btnStand.classList.remove('warn');
  send({ t: 'leave' });
});
$('#btnCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); toast('링크를 복사했습니다 · 이 방 주소입니다'); }
  catch { toast(`이 주소를 보내세요: ${location.href}`); }
});

const RANK_EX: [string, string, string][] = [
  ['로열 플러시', '같은 무늬 A·K·Q·J·10', 'As Ks Qs Js Ts'],
  ['스트레이트 플러시', '같은 무늬로 연속된 다섯 장', '9h 8h 7h 6h 5h'],
  ['포카드', '같은 숫자 네 장', 'Qc Qd Qh Qs 4d'],
  ['풀하우스', '트리플 + 원페어', 'Ks Kh Kd 7c 7s'],
  ['플러시', '같은 무늬 다섯 장', 'Ad Jd 8d 6d 2d'],
  ['스트레이트', '연속된 숫자 다섯 장 (A-2-3-4-5 포함)', 'Tc 9d 8s 7h 6c'],
  ['트리플', '같은 숫자 세 장', '8s 8h 8d Kc 3s'],
  ['투페어', '페어 두 쌍', 'Jh Jc 4s 4d Ah'],
  ['원페어', '같은 숫자 두 장', 'Th Ts Kd 6c 2h'],
  ['하이카드', '조합이 없으면 가장 높은 카드로 비교', 'Ac Qd 9s 5h 3c'],
];
const parseCard = (s: string) => '23456789TJQKA'.indexOf(s[0]) * 4 + 'shdc'.indexOf(s[1]);
$('#ranksList').innerHTML = RANK_EX.map(([n, d, cs], i) =>
  `<li><span class="no">${i + 1}</span><span class="nm2">${n}<span class="ds">${d}</span></span><span class="cs">${
    cs.split(' ').map(parseCard).map(c => `<span class="card${isRed(c) ? ' red' : ''}" role="img" aria-label="${cardName(c)}">${faceHTML(c)}</span>`).join('')
  }</span></li>`).join('');
$('#btnRanks').addEventListener('click', () => { ovRanks.hidden = false; $('#closeRanks').focus(); });
$('#closeRanks').addEventListener('click', () => { ovRanks.hidden = true; });
ovRanks.addEventListener('click', e => { if (e.target === ovRanks) ovRanks.hidden = true; });

document.addEventListener('keydown', e => {
  if (!CODE) return;  // the lobby screen has no table to act on
  if (!ovRanks.hidden || !ovJoin.hidden) { if (e.key === 'Escape') { ovRanks.hidden = true; closeJoin(); } return; }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target === rInput) return;
  const ms = mySeat();
  if (!isMyTurn(ms)) return;
  if (e.code === 'KeyF') bFold.click();
  else if (e.code === 'KeyC') bCall.click();
  else if (e.code === 'KeyR') { if (!bRaise.disabled) bRaise.click(); }
  else return;
  e.preventDefault();
});

/* ================= locked and missing rooms ================= */

function showPw(err: string, waiting: boolean) {
  ovJoin.hidden = true;
  ovPw.hidden = false;
  pwErr.textContent = err;
  pwErr.hidden = !err;
  pwIn.disabled = waiting;
  $<HTMLButtonElement>('#pwBtn').disabled = waiting;
  if (!waiting) pwIn.focus();
}

function showGone() {
  dead = true;
  try { ws?.close(); } catch { /* already closed */ }
  ovPw.hidden = true; ovJoin.hidden = true; ovRanks.hidden = true;
  ovGone.hidden = false;
}

$<HTMLFormElement>('#pwForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = pwIn.value;
  if (!v) return;
  // Checked here so a short typo does not spend one of the five tries.
  if (v.length < 4) {
    pwErr.textContent = '비밀번호는 4자 이상입니다.';
    pwErr.hidden = false;
    return;
  }
  pw = v;
  try { sessionStorage.setItem('holdem.pw.' + CODE, v); } catch { /* private mode */ }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token: TOKEN, password: v } satisfies ClientMsg));
  } else {
    connect();
  }
});
$('#pwBack').addEventListener('click', () => { location.href = '/'; });
$('#goneBack').addEventListener('click', () => { location.href = '/'; });
$('#btnLobby').addEventListener('click', () => { location.href = '/'; });

if (CODE) {
  document.title = `Hold'em 테이블 · ${CODE}`;
  render();
  connect();
} else {
  startLobby();
}
