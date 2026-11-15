// Hand evaluation shared by the server (deciding pots) and the client
// (showing "Two pair (K, 7)" and the optional win-rate estimate).
// Cards are integers 0..51: rank = (c >> 2) + 2 (2..14, ace = 14), suit = c & 3.

export const RL: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
export const rk = (c: number) => (c >> 2) + 2;
export const sk = (c: number) => c & 3;

function enc(cat: number, a: number[]): number {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (a[i] || 0);
  return v;
}

function straightHigh(p: number[]): number {
  for (let h = 14; h >= 5; h--) {
    let ok = true;
    for (let i = 0; i < 5; i++) {
      const r = h - i === 1 ? 14 : h - i;
      if (!p[r]) { ok = false; break; }
    }
    if (ok) return h;
  }
  return 0;
}

/** Score of the best 5-card hand among 5–7 cards; higher wins, equal ties. */
export function evaluate(cs: number[]): number {
  const rc = new Array<number>(15).fill(0);
  const sc = [0, 0, 0, 0];
  for (const c of cs) { rc[rk(c)]++; sc[sk(c)]++; }
  let fs = -1;
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) fs = s;
  let fr: number[] | null = null;
  if (fs >= 0) {
    fr = new Array<number>(15).fill(0);
    for (const c of cs) if (sk(c) === fs) fr[rk(c)] = 1;
    const h = straightHigh(fr);
    if (h) return enc(8, [h]);
  }
  const q: number[] = [], t: number[] = [], pr: number[] = [];
  for (let r = 14; r >= 2; r--) {
    const n = rc[r];
    if (n === 4) q.push(r); else if (n === 3) t.push(r); else if (n === 2) pr.push(r);
  }
  const kick = (ex: number[], n: number) => {
    const o: number[] = [];
    for (let r = 14; r >= 2 && o.length < n; r--) if (rc[r] && !ex.includes(r)) o.push(r);
    return o;
  };
  if (q.length) return enc(7, [q[0], ...kick([q[0]], 1)]);
  if (t.length && (t.length > 1 || pr.length)) return enc(6, [t[0], Math.max(t[1] || 0, pr[0] || 0)]);
  if (fs >= 0 && fr) {
    const o: number[] = [];
    for (let r = 14; r >= 2 && o.length < 5; r--) if (fr[r]) o.push(r);
    return enc(5, o);
  }
  const h = straightHigh(rc);
  if (h) return enc(4, [h]);
  if (t.length) return enc(3, [t[0], ...kick([t[0]], 2)]);
  if (pr.length > 1) return enc(2, [pr[0], pr[1], ...kick([pr[0], pr[1]], 1)]);
  if (pr.length) return enc(1, [pr[0], ...kick([pr[0]], 3)]);
  return enc(0, kick([], 5));
}

/** Best 5 cards out of 5–7, with their score (used to highlight winning cards). */
export function best5(cs: number[]): { score: number; cards: number[] } {
  let best = -1;
  let bc: number[] = [];
  const n = cs.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const h = [cs[a], cs[b], cs[c], cs[d], cs[e]];
      const s = evaluate(h);
      if (s > best) { best = s; bc = h; }
    }
  return { score: best, cards: bc };
}

const CAT = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시'];

function parts(score: number) {
  const k: number[] = [];
  let r = score;
  for (let i = 0; i < 5; i++) { k.unshift(r % 15); r = Math.floor(r / 15); }
  return { cat: r, k };
}

export function catName(score: number): string {
  const { cat, k } = parts(score);
  return cat === 8 && k[0] === 14 ? '로열 플러시' : CAT[cat];
}

export function handName(score: number): string {
  const { cat, k } = parts(score);
  const R = (r: number) => RL[r];
  switch (cat) {
    case 8: return k[0] === 14 ? '로열 플러시' : `스트레이트 플러시 (${R(k[0])} 하이)`;
    case 7: return `포카드 (${R(k[0])})`;
    case 6: return `풀하우스 (${R(k[0])}, ${R(k[1])})`;
    case 5: return `플러시 (${R(k[0])} 하이)`;
    case 4: return `스트레이트 (${R(k[0])} 하이)`;
    case 3: return `트리플 (${R(k[0])})`;
    case 2: return `투페어 (${R(k[0])}, ${R(k[1])})`;
    case 1: return `원페어 (${R(k[0])})`;
    default: return `하이카드 (${R(k[0])})`;
  }
}

/** Monte Carlo win rate against nOpp random hands (client-side helper only). */
export function equity(hole: number[], board: number[], nOpp: number, iters: number): number {
  const used = new Uint8Array(52);
  for (const c of hole) used[c] = 1;
  for (const c of board) used[c] = 1;
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!used[c]) deck.push(c);
  const n = deck.length, need = 5 - board.length;
  let wins = 0;
  for (let it = 0; it < iters; it++) {
    let top = 0;
    const draw = () => {
      const j = top + ((Math.random() * (n - top)) | 0);
      const t = deck[top]; deck[top] = deck[j]; deck[j] = t;
      return deck[top++];
    };
    const full = board.slice();
    for (let k = 0; k < need; k++) full.push(draw());
    const my = evaluate(hole.concat(full));
    let ties = 0, lost = false;
    for (let o = 0; o < nOpp; o++) {
      const s = evaluate([draw(), draw()].concat(full));
      if (s > my) { lost = true; break; }
      if (s === my) ties++;
    }
    if (!lost) wins += 1 / (ties + 1);
  }
  return wins / iters;
}

/** Names are typed by anyone with the link: strip control/invisible characters, cap at 12. */
export function cleanName(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
}

/** 12345 → "12,345" without depending on Intl locale data. */
export function fmt(n: number): string {
  const v = Math.round(n);
  const sign = v < 0 ? '-' : '';
  return sign + Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
