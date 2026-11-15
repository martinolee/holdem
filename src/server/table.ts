import { DurableObject } from 'cloudflare:workers';
import { best5, catName, cleanName, fmt, handName } from '../shared/engine';
import {
  NSEAT, PROTOCOL,
  type ActType, type Cfg, type ClientMsg, type HandView, type LogEntry, type LogSeg,
  type Result, type ServerMsg, type TableView,
} from '../shared/protocol';
import type { Env } from './worker';

/* One Durable Object = one table. It is the dealer: it shuffles, keeps every hole card,
   runs the betting, and sends each connection a view that holds only that person's cards.
   All state lives in `this.s` and is written to storage after every change, so the object
   can hibernate or restart between messages and pick up where it left off. All delays
   (turn clock, street pauses, next hand) go through the single storage alarm. */

interface Seat {
  token: string;      // secret from the player's browser; never sent to anyone
  name: string;
  stack: number;
  buyins: number;
  away: boolean;
  idle: boolean;      // set after two missed turns in a row
  missed: number;
  leaving: boolean;
  lastSeen: number;
}

interface P {
  bet: number; total: number; folded: boolean; allIn: boolean; needs: boolean;
  label: string; shown: number[] | null; won: number; win: boolean;
}

interface Hand {
  id: string; no: number; dealer: number; sbS: number; bbS: number; order: number[];
  phase: 'bet' | 'over';
  street: HandView['street'];
  board: number[];
  deck: number[];                 // server only
  holes: Record<number, number[]>; // server only
  dp: number;
  pot: number; cur: number; minR: number; raises: number;
  toAct: number; seq: number; turnAt: number;
  ps: (P | null)[];
  hl: number[] | null; results: Result[] | null; verdict: string; runout: boolean;
}

type Why = 'timeout' | 'away' | 'leave';
interface Timer { at: number; kind: 'start' | 'proceed' | 'street' | 'turn' | 'auto'; hand?: string; seq?: number; last?: number; why?: Why }

interface State {
  v: 1;
  seats: (Seat | null)[];
  handNo: number;
  dealer: number;
  hand: Hand | null;
  log: LogEntry[];
  logN: number;
  timer: Timer | null;
}

const fresh = (): State => ({ v: 1, seats: Array(NSEAT).fill(null), handNo: 0, dealer: -1, hand: null, log: [], logN: 0, timer: null });
const STREET_KO: Record<string, string> = { flop: '플롭', turn: '턴', river: '리버' };
const RECONNECT_GRACE = 20_000;   // still dealt in for this long after a disconnect
const SEAT_EXPIRY = 3 * 60_000;   // seat cleared after this long offline, at the next hand
const MAX_SOCKETS = 60;

function rnd(n: number): number { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
function newDeck(): number[] {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const tokenOk = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(t);

interface Attachment { token: string | null }

export class Table extends DurableObject<Env> {
  s: State = fresh();
  cfg: Cfg;
  rate = new Map<WebSocket, { n: number; t: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const bb = num(env.BB, 20);
    this.cfg = { sb: num(env.SB, Math.max(1, Math.floor(bb / 2))), bb, buyin: num(env.BUYIN, 100 * bb), turn: num(env.TURN_SECS, 30) };
    // Pings from the browser are answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<State>('s');
      if (saved && saved.v === 1) this.s = saved;
    });
  }

  /* ---------------- connections ---------------- */

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket 연결만 받습니다.', { status: 426 });
    if (this.open().length >= MAX_SOCKETS) return new Response('이 테이블은 접속자가 너무 많습니다.', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ token: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string' || data.length > 2048) return;
    const now = Date.now();
    const r = this.rate.get(ws) ?? { n: 0, t: now };
    if (now - r.t > 5000) { r.n = 0; r.t = now; }
    r.n += 1; this.rate.set(ws, r);
    if (r.n > 30) return; // more than 30 messages in 5 s: drop silently
    let m: ClientMsg;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
    await this.handle(ws, m);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  private async gone(ws: WebSocket) {
    this.rate.delete(ws);
    const tok = this.att(ws).token;
    const i = tok ? this.seatOf(tok, ws) : -1;
    if (i >= 0) {
      const s = this.s.seats[i]!;
      s.lastSeen = Date.now();
      // Their turn and nobody of theirs is still connected: don't make the table wait the full clock.
      const h = this.s.hand, t = this.s.timer;
      if (h && h.phase === 'bet' && h.toAct === i && !this.online(s.token, ws) && t && t.hand === h.id && t.seq === h.seq) {
        const at = Date.now() + 5000;
        if (at < t.at) this.s.timer = { at, kind: 'auto', hand: h.id, seq: h.seq, why: 'away' };
      }
      await this.commit(ws);
    } else this.broadcast(ws);
  }

  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { token: null };
  }
  private open(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter(w => w !== except && w.readyState === WebSocket.READY_STATE_OPEN);
  }
  private online(token: string, except?: WebSocket): boolean {
    return this.open(except).some(w => this.att(w).token === token);
  }
  private seatOf(token: string | null, _ws?: WebSocket): number {
    if (!token) return -1;
    return this.s.seats.findIndex(s => !!s && s.token === token);
  }

  /* ---------------- messages ---------------- */

  private async handle(ws: WebSocket, m: ClientMsg) {
    if (m.t === 'hello') {
      if (m.v !== PROTOCOL) { this.send(ws, { t: 'reload' }); return; }
      if (!tokenOk(m.token)) { this.send(ws, { t: 'error', code: 'token', msg: '접속 정보가 올바르지 않습니다. 페이지를 새로고침해 주세요.' }); return; }
      ws.serializeAttachment({ token: m.token } satisfies Attachment);
      const i = this.seatOf(m.token);
      if (i >= 0) {
        this.s.seats[i]!.lastSeen = Date.now();
        this.maybeStart(); // a returning player may be the second one the table was waiting for
        await this.commit();
      } else this.broadcast();
      return;
    }
    const token = this.att(ws).token;
    if (!token) return;
    const i = this.seatOf(token);
    const seat = i >= 0 ? this.s.seats[i]! : null;
    if (seat) seat.lastSeen = Date.now();
    const h = this.s.hand;
    const inPlay = !!h && h.phase === 'bet' && !!seat && !!h.ps[i] && !h.ps[i]!.folded;

    switch (m.t) {
      case 'sit': {
        const name = cleanName(m.name);
        if (!name) return this.err(ws, 'name', '이름을 한 글자 이상 입력하세요.');
        if (seat) { seat.name = name; break; }
        const pref = Number.isInteger(m.seat) && m.seat! >= 0 && m.seat! < NSEAT && !this.s.seats[m.seat!] ? m.seat! : this.s.seats.findIndex(x => !x);
        if (pref < 0) return this.err(ws, 'full', '빈 자리가 없습니다. 자리가 나면 다시 시도해 주세요.');
        this.s.seats[pref] = { token, name, stack: this.cfg.buyin, buyins: 1, away: false, idle: false, missed: 0, leaving: false, lastSeen: Date.now() };
        this.log([['b', name], ' 님이 앉았습니다'], 'n');
        this.maybeStart();
        break;
      }
      case 'rename': {
        const name = cleanName(m.name);
        if (!seat || !name) return;
        seat.name = name;
        break;
      }
      case 'act': {
        if (!seat || !h || h.phase !== 'bet' || h.toAct !== i || m.hand !== h.id || m.seq !== h.seq) return;
        if (!['fold', 'check', 'call', 'raise'].includes(m.type)) return;
        this.apply(i, m.type, Number(m.to) || 0, false);
        break;
      }
      case 'away': {
        if (!seat || seat.away) return;
        seat.away = true;
        if (h && h.phase === 'bet' && h.toAct === i) this.s.timer = { at: Date.now() + 500, kind: 'auto', hand: h.id, seq: h.seq, why: 'away' };
        break;
      }
      case 'back': {
        if (!seat) return;
        seat.away = false; seat.idle = false; seat.missed = 0;
        if (seat.leaving && !inPlay) seat.leaving = false;
        this.maybeStart();
        break;
      }
      case 'rebuy': {
        if (!seat || seat.stack > 0 || (h && h.phase === 'bet' && h.ps[i])) return;
        seat.stack = this.cfg.buyin; seat.buyins += 1;
        this.log([['b', seat.name], ` 다시 바이인 ${fmt(this.cfg.buyin)}`], 'n');
        this.maybeStart();
        break;
      }
      case 'leave': {
        if (!seat) return;
        if (h && h.phase === 'bet' && h.ps[i]) {
          seat.leaving = true;
          const p = h.ps[i]!;
          if (!p.folded) {
            if (h.toAct === i) { this.apply(i, 'fold', 0, true); }
            else {
              p.folded = true; p.needs = false; p.label = '폴드';
              this.log([['b', seat.name], ' 폴드 · 자리를 떠남'], 'f');
              this.proceed();
            }
          }
        } else {
          this.s.seats[i] = null;
          this.log([['b', seat.name], ' 님이 자리에서 일어났습니다'], 'n');
        }
        break;
      }
      default: return;
    }
    await this.commit();
  }

  private err(ws: WebSocket, code: string, msg: string) { this.send(ws, { t: 'error', code, msg }); }
  private send(ws: WebSocket, m: ServerMsg) { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } }

  /* ---------------- persistence + fan-out ---------------- */

  private async commit(except?: WebSocket) {
    await this.ctx.storage.put('s', this.s);
    if (this.s.timer) await this.ctx.storage.setAlarm(this.s.timer.at);
    else await this.ctx.storage.deleteAlarm();
    this.broadcast(except);
  }

  private broadcast(except?: WebSocket) {
    const socks = this.open(except);
    const table = this.tableView(socks.length);
    for (const ws of socks) {
      const tok = this.att(ws).token;
      const seat = this.seatOf(tok);
      const h = this.s.hand;
      const cards = seat >= 0 && h && h.ps[seat] && h.holes[seat] ? h.holes[seat] : null;
      this.send(ws, { t: 'state', table, you: { seat, cards } });
    }
  }

  private tableView(onlineCount: number): TableView {
    const h = this.s.hand;
    const now = Date.now();
    return {
      cfg: this.cfg,
      seats: this.s.seats.map(s => s && {
        name: s.name, stack: s.stack, buyins: s.buyins, away: s.away, idle: s.idle, leaving: s.leaving, online: this.online(s.token),
      }),
      handNo: this.s.handNo,
      hand: h && {
        id: h.id, no: h.no, dealer: h.dealer, order: h.order, phase: h.phase, street: h.street, board: h.board,
        pot: h.pot, cur: h.cur, minR: h.minR, toAct: h.toAct, seq: h.seq, turnSecs: this.cfg.turn,
        turnLeft: h.phase === 'bet' && h.toAct >= 0 ? Math.max(0, h.turnAt + this.cfg.turn * 1000 - now) : 0,
        ps: h.ps.map(p => p && { bet: p.bet, total: p.total, folded: p.folded, allIn: p.allIn, label: p.label, shown: p.shown, won: p.won, win: p.win }),
        hl: h.hl, results: h.results, verdict: h.verdict, runout: h.runout,
      },
      log: this.s.log,
      online: onlineCount,
    };
  }

  /* ---------------- timers ---------------- */

  async alarm(): Promise<void> {
    const t = this.s.timer;
    if (!t) return;
    if (Date.now() < t.at - 25) { await this.ctx.storage.setAlarm(t.at); return; }
    this.s.timer = null;
    const h = this.s.hand;
    const same = !!h && h.id === t.hand;
    switch (t.kind) {
      case 'start': this.startHand(); break;
      case 'proceed': if (same) this.proceed(t.last); break;
      case 'street': if (same) this.endStreet(); break;
      case 'turn':
      case 'auto': if (same && h!.seq === t.seq) this.autoAct(t.why ?? 'timeout'); break;
    }
    await this.commit();
  }

  private later(kind: Timer['kind'], ms: number, extra: Partial<Timer> = {}) {
    const h = this.s.hand;
    this.s.timer = { at: Date.now() + ms, kind, hand: h?.id, seq: h?.seq, ...extra };
  }

  /* ---------------- dealing ---------------- */

  private log(t: LogSeg[], c = '') {
    this.s.logN += 1;
    this.s.log.push({ i: this.s.logN, t, c });
    if (this.s.log.length > 90) this.s.log.splice(0, this.s.log.length - 90);
  }
  private nameOf(i: number) { return this.s.seats[i]?.name ?? '?'; }
  private nextIn(i: number, ok: (j: number) => boolean): number {
    for (let k = 1; k <= NSEAT; k++) { const j = (((i % NSEAT) + NSEAT) + k) % NSEAT; if (ok(j)) return j; }
    return -1;
  }
  private isAct(i: number) { const p = this.s.hand?.ps[i]; return !!p && !p.folded && !p.allIn; }
  private liveIdx(): number[] { const o: number[] = []; this.s.hand?.ps.forEach((p, i) => { if (p && !p.folded) o.push(i); }); return o; }
  private present(s: Seat) { return this.online(s.token) || Date.now() - s.lastSeen < RECONNECT_GRACE; }
  private seatOk(i: number) {
    const s = this.s.seats[i];
    return !!s && s.stack > 0 && !s.away && !s.idle && !s.leaving && this.present(s);
  }
  private chips(i: number, amt: number) {
    const s = this.s.seats[i], p = this.s.hand?.ps[i];
    if (!s || !p) return 0;
    const a = Math.max(0, Math.min(amt, s.stack));
    s.stack -= a; p.bet += a; p.total += a;
    if (s.stack === 0) p.allIn = true;
    return a;
  }

  private maybeStart() {
    const h = this.s.hand;
    if ((h && h.phase === 'bet') || this.s.timer) return;
    let n = 0;
    for (let i = 0; i < NSEAT; i++) if (this.seatOk(i)) n++;
    if (n >= 2) this.later('start', 1500);
  }

  private startHand() {
    if (this.s.hand && this.s.hand.phase === 'bet') return;
    const now = Date.now();
    // Clear seats whose owner left or has been gone for a while.
    for (let i = 0; i < NSEAT; i++) {
      const s = this.s.seats[i];
      if (!s) continue;
      if (s.leaving) { this.s.seats[i] = null; this.log([['b', s.name], ' 님이 자리에서 일어났습니다'], 'n'); }
      else if (!this.online(s.token) && now - s.lastSeen > SEAT_EXPIRY) { this.s.seats[i] = null; this.log([['b', s.name], ' 님의 연결이 끊겨 자리를 정리했습니다'], 'n'); }
    }
    const elig: number[] = [];
    for (let i = 0; i < NSEAT; i++) if (this.seatOk(i)) elig.push(i);
    if (elig.length < 2) { this.s.hand = null; return; }
    const inE = (i: number) => elig.includes(i);
    const dealer = this.nextIn(this.s.dealer < 0 ? rnd(NSEAT) : this.s.dealer, inE);
    let sbS: number, bbS: number;
    if (elig.length === 2) { sbS = dealer; bbS = this.nextIn(dealer, inE); }
    else { sbS = this.nextIn(dealer, inE); bbS = this.nextIn(sbS, inE); }
    const order: number[] = [];
    let j = dealer;
    for (let k = 0; k < elig.length; k++) { j = this.nextIn(j, inE); order.push(j); }
    const deck = newDeck(), holes: Record<number, number[]> = {};
    let dp = 0;
    for (let r = 0; r < 2; r++) for (const i of order) (holes[i] ??= []).push(deck[dp++]);
    this.s.handNo += 1;
    this.s.dealer = dealer;
    const ps: (P | null)[] = Array(NSEAT).fill(null);
    for (const i of elig) ps[i] = { bet: 0, total: 0, folded: false, allIn: false, needs: false, label: '', shown: null, won: 0, win: false };
    this.s.hand = {
      id: `h${this.s.handNo}-${crypto.randomUUID().slice(0, 8)}`, no: this.s.handNo, dealer, sbS, bbS, order,
      phase: 'bet', street: 'preflop', board: [], deck, holes, dp, pot: 0,
      cur: this.cfg.bb, minR: this.cfg.bb, raises: 0, toAct: -1, seq: 0, turnAt: 0, ps,
      hl: null, results: null, verdict: '', runout: false,
    };
    this.log([`핸드 #${this.s.handNo} · 딜러 `, ['b', this.nameOf(dealer)]], 'h');
    for (const [i, amt, t] of [[sbS, this.cfg.sb, 'SB'], [bbS, this.cfg.bb, 'BB']] as const) {
      const a = this.chips(i, amt);
      const p = ps[i]!;
      p.label = p.allIn ? `올인 ${fmt(a)}` : `${t} ${fmt(a)}`;
      this.log([['b', this.nameOf(i)], ` ${t} ${fmt(a)}`], 'n');
    }
    for (const p of ps) if (p) p.needs = !p.allIn;
    this.later('proceed', 420 + order.length * 2 * 85, { last: bbS });
  }

  private proceed(last?: number) {
    const h = this.s.hand;
    if (!h || h.phase !== 'bet') return;
    const L = this.liveIdx();
    if (L.length === 1) return this.winUncontested(L[0]);
    const able = L.filter(i => !h.ps[i]!.allIn);
    let done = able.length === 0 || (able.length === 1 && h.ps[able[0]]!.bet >= h.cur) || !able.some(i => h.ps[i]!.needs);
    let t = -1;
    if (!done) {
      const ok = (i: number) => this.isAct(i) && h.ps[i]!.needs;
      if (last !== undefined) t = this.nextIn(last, ok);
      else { t = h.toAct; if (t < 0 || !ok(t)) t = this.nextIn(t < 0 ? h.dealer : t, ok); }
      if (t < 0) done = true;
    }
    if (done) { h.toAct = -1; this.later('street', 650); return; }
    const fresh = last !== undefined || t !== h.toAct;
    h.toAct = t;
    if (fresh) { h.seq += 1; h.turnAt = Date.now(); this.armTurn(); }
  }

  private armTurn() {
    const h = this.s.hand!;
    const s = this.s.seats[h.toAct];
    if (!s || s.leaving) return this.later('auto', 500, { why: 'leave' });
    if (s.away || s.idle) return this.later('auto', 700, { why: 'away' });
    if (!this.online(s.token)) return this.later('auto', 4000, { why: 'away' });
    this.later('turn', this.cfg.turn * 1000 + 1200, { why: 'timeout' });
  }

  private autoAct(why: Why) {
    const h = this.s.hand;
    if (!h || h.phase !== 'bet' || h.toAct < 0) return;
    const i = h.toAct, p = h.ps[i]!, s = this.s.seats[i];
    if (why === 'timeout' && s) {
      s.missed += 1;
      this.log([['b', s.name], ' 시간 초과'], 'n');
      if (s.missed >= 2) { s.idle = true; this.log([['b', s.name], ' 자리 비움으로 전환'], 'n'); }
    }
    this.apply(i, why === 'leave' || h.cur - p.bet > 0 ? 'fold' : 'check', 0, true);
  }

  private apply(i: number, type: ActType, to: number, auto: boolean) {
    const h = this.s.hand!, p = h.ps[i], s = this.s.seats[i];
    if (!p || !s) return;
    const toCall = Math.max(0, h.cur - p.bet);
    if (type === 'check' && toCall > 0) type = 'call';
    if (type === 'raise') {
      const maxTo = p.bet + s.stack;
      if (s.stack <= toCall || maxTo <= h.cur) type = toCall > 0 ? 'call' : 'check';
      else {
        const minTo = Math.min(maxTo, h.cur === 0 ? this.cfg.bb : h.cur + h.minR);
        to = Math.max(minTo, Math.min(maxTo, Math.round(to)));
      }
    }
    if (type === 'fold') { p.folded = true; p.label = '폴드'; }
    else if (type === 'check') { p.label = '체크'; }
    else if (type === 'call') { const a = this.chips(i, toCall); p.label = p.allIn ? `올인 ${fmt(p.bet)}` : `콜 ${fmt(a)}`; }
    else {
      const prev = h.cur;
      this.chips(i, to - p.bet);
      if (p.bet > prev) {
        const inc = p.bet - prev;
        if (inc >= h.minR) h.minR = inc;
        h.cur = p.bet; h.raises += 1;
        h.ps.forEach((o, j) => { if (o && j !== i && this.isAct(j) && o.bet < h.cur) o.needs = true; });
      }
      p.label = p.allIn ? `올인 ${fmt(p.bet)}` : `${prev === 0 ? '벳' : '레이즈'} ${fmt(p.bet)}`;
    }
    p.needs = false;
    if (!auto) s.missed = 0;
    this.log([['b', s.name], ' ' + p.label], type === 'fold' ? 'f' : '');
    this.proceed(i);
  }

  private endStreet() {
    const h = this.s.hand;
    if (!h || h.phase !== 'bet') return;
    for (const p of h.ps) if (p) { h.pot += p.bet; p.bet = 0; }
    const L = this.liveIdx();
    if (L.length === 1) return this.winUncontested(L[0]);
    if (h.street === 'river') return this.showdown();
    const able = L.filter(i => !h.ps[i]!.allIn);
    if (able.length <= 1 && !h.runout) {
      h.runout = true;
      for (const i of L) h.ps[i]!.shown = h.holes[i].slice();
      this.log(['더 이상 베팅이 없어 카드를 공개합니다'], 'n');
    }
    h.dp += 1; // burn
    const n = h.street === 'preflop' ? 3 : 1, dealt: number[] = [];
    for (let k = 0; k < n; k++) { const c = h.deck[h.dp++]; h.board.push(c); dealt.push(c); }
    h.street = h.street === 'preflop' ? 'flop' : h.street === 'flop' ? 'turn' : 'river';
    this.log([STREET_KO[h.street], ...dealt.map(c => ['c', c] as LogSeg)], 's');
    h.cur = 0; h.minR = this.cfg.bb; h.raises = 0; h.toAct = -1;
    h.ps.forEach((p, i) => { if (p) { p.needs = this.isAct(i); if (this.isAct(i)) p.label = ''; } });
    this.later('proceed', h.runout ? 1300 : 650 + n * 110, { last: h.dealer });
  }

  private refundUncalled() {
    const h = this.s.hand!;
    const idx = h.ps.map((_, i) => i).filter(i => h.ps[i] && h.ps[i]!.total > 0).sort((a, b) => h.ps[b]!.total - h.ps[a]!.total);
    if (idx.length < 2 || h.ps[idx[0]]!.folded) return;
    const top = h.ps[idx[0]]!, ex = top.total - h.ps[idx[1]]!.total;
    const seat = this.s.seats[idx[0]];
    if (ex > 0 && seat) { top.total -= ex; seat.stack += ex; h.pot -= ex; }
  }

  private finish(delay: number) {
    const h = this.s.hand!;
    h.phase = 'over'; h.toAct = -1;
    this.later('start', delay);
  }

  private winUncontested(i: number) {
    const h = this.s.hand!;
    for (const p of h.ps) if (p) { h.pot += p.bet; p.bet = 0; }
    this.refundUncalled();
    const amt = h.pot, p = h.ps[i]!;
    const seat = this.s.seats[i];
    if (seat) seat.stack += amt;
    p.won = amt; p.win = true; p.label = `+${fmt(amt)}`;
    h.pot = 0;
    h.verdict = `${this.nameOf(i)} 승리 +${fmt(amt)}`;
    h.results = [{ pot: '팟', amount: amt, names: [this.nameOf(i)], hand: '' }];
    this.log([['b', this.nameOf(i)], ` 팟 ${fmt(amt)} 획득 · 쇼다운 없음`], 'w');
    this.finish(3800);
  }

  private showdown() {
    const h = this.s.hand!;
    this.refundUncalled();
    h.street = 'showdown';
    const L = this.liveIdx();
    const score: Record<number, number> = {}, best: Record<number, number[]> = {};
    for (const i of L) {
      const hole = h.holes[i];
      h.ps[i]!.shown = hole.slice();
      const b = best5(hole.concat(h.board));
      score[i] = b.score; best[i] = b.cards;
      h.ps[i]!.label = catName(b.score);
      this.log([['b', this.nameOf(i)], ['c', hole[0]], ['c', hole[1]], ' · ' + handName(b.score)], 'n');
    }
    // Side pots: one level per distinct all-in total among players still in.
    const levels = [...new Set(L.map(i => h.ps[i]!.total).filter(t => t > 0))].sort((a, b) => a - b);
    const contrib = h.ps.map((_, i) => i).filter(i => h.ps[i] && h.ps[i]!.total > 0);
    const pots: { amount: number; elig: number[] }[] = [];
    let prev = 0;
    for (const lv of levels) {
      let amt = 0;
      for (const i of contrib) amt += Math.max(0, Math.min(h.ps[i]!.total, lv) - prev);
      pots.push({ amount: amt, elig: L.filter(i => h.ps[i]!.total >= lv) });
      prev = lv;
    }
    let left = 0;
    for (const i of contrib) left += Math.max(0, h.ps[i]!.total - prev);
    if (left && pots.length) pots[pots.length - 1].amount += left;
    const hl = new Set<number>(), results: Result[] = [];
    const seatOrder = [1, 2, 3, 4, 5, 6].map(k => (h.dealer + k) % NSEAT);
    const real = pots.filter(x => x.amount > 0);
    real.forEach((pot, idx) => {
      const max = Math.max(...pot.elig.map(i => score[i]));
      const ws = seatOrder.filter(i => pot.elig.includes(i) && score[i] === max);
      const share = Math.floor(pot.amount / ws.length);
      let rem = pot.amount - share * ws.length;
      for (const w of ws) {
        let a = share;
        if (rem > 0) { a += rem; rem = 0; } // odd chip to the first winner left of the button
        const seat = this.s.seats[w];
        if (seat) seat.stack += a;
        h.ps[w]!.won += a; h.ps[w]!.win = true;
      }
      if (idx === 0) for (const w of ws) for (const c of best[w]) hl.add(c);
      const potName = real.length === 1 ? '팟' : idx === 0 ? '메인 팟' : `사이드 팟 ${idx}`;
      results.push({ pot: potName, amount: pot.amount, names: ws.map(w => this.nameOf(w)), hand: handName(score[ws[0]]) });
      this.log([`${potName} ${fmt(pot.amount)} → `, ['b', ws.map(w => this.nameOf(w)).join(', ')], `${ws.length > 1 ? ' 분할' : ''} · ${handName(score[ws[0]])}`], 'w');
    });
    for (const p of h.ps) if (p && p.win) p.label = `+${fmt(p.won)}`;
    h.pot = 0;
    h.hl = [...hl]; h.results = results;
    const winners = [...new Set(results.flatMap(r => r.names))];
    const firstW = seatOrder.find(i => h.ps[i]?.win) ?? L[0];
    h.verdict = winners.length === 1 ? `${winners[0]} 승리 · ${catName(score[firstW])}`
      : results.length === 1 ? `팟 분할 · ${catName(score[firstW])}` : `${winners.join(' · ')} 승리`;
    this.finish(6500);
  }
}
