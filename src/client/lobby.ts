/* The lobby screen: the list of open rooms, and the form that makes one.
   It owns its own socket to /lobby/ws. Moving to a table is a real page
   navigation, so nothing here has to be torn down. */

import { PROTOCOL, type LobbyClientMsg, type LobbyServerMsg, type RoomBrief } from '../shared/protocol';

const $ = <E extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as E;

let ws: WebSocket | null = null;
let retry = 0;
let pingTimer = 0;
let rooms: RoomBrief[] = [];
let connected = false;

export function startLobby(): void {
  $('#tableApp').hidden = true;
  $('#lobbyApp').hidden = false;
  document.title = "Hold'em 대기실";

  $('#btnNew').addEventListener('click', openNew);
  $('#newCancel').addEventListener('click', closeNew);
  $('#ovNew').addEventListener('click', e => { if (e.target === $('#ovNew')) closeNew(); });
  $<HTMLFormElement>('#newForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $<HTMLInputElement>('#roomIn').value;
    const password = $<HTMLInputElement>('#roomPw').value;
    if (!send({ t: 'create', name, ...(password ? { password } : {}) })) return;
    $<HTMLButtonElement>('#newBtn').disabled = true;
  });

  render();
  connect();
}

/* ---------------- connection ---------------- */

function connect() {
  const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/lobby/ws`);
  ws = s;
  s.onopen = () => {
    retry = 0; connected = true;
    s.send(JSON.stringify({ t: 'hello', v: PROTOCOL } satisfies LobbyClientMsg));
    clearInterval(pingTimer);
    // Answered by the runtime, so the lobby object stays asleep.
    pingTimer = window.setInterval(() => { if (s.readyState === WebSocket.OPEN) s.send('ping'); }, 25000);
  };
  s.onmessage = e => {
    if (e.data === 'pong') return;
    let m: LobbyServerMsg;
    try { m = JSON.parse(e.data); } catch { return; }
    onMsg(m);
  };
  s.onclose = () => {
    if (ws !== s) return;
    connected = false; clearInterval(pingTimer); render();
    const d = [800, 1500, 3000, 6000, 12000][Math.min(retry++, 4)];
    setTimeout(connect, d);
  };
}

function send(m: LobbyClientMsg): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(m)); return true; }
  showErr('대기실과 연결이 끊겨 있습니다. 다시 연결되면 눌러 주세요.');
  return false;
}

function onMsg(m: LobbyServerMsg) {
  switch (m.t) {
    case 'rooms':
      rooms = m.rooms;
      render();
      return;
    case 'created':
      location.href = '/t/' + m.code;
      return;
    case 'error':
      $<HTMLButtonElement>('#newBtn').disabled = false;
      showErr(m.msg);
      return;
    case 'reload':
      location.reload();
      return;
  }
}

/* ---------------- the list ---------------- */

function render() {
  const list = $('#rooms');
  list.textContent = '';
  $('#lCount').textContent = String(rooms.length);

  for (const r of rooms) {
    const li = document.createElement('li');

    const nm = document.createElement('span');
    nm.className = 'rn';
    nm.textContent = r.name;        // textContent only: room names are typed by anyone
    li.appendChild(nm);

    if (r.hasPw) {
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.textContent = '잠김';
      lock.title = '비밀번호가 필요한 방입니다';
      li.appendChild(lock);
    }

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.seated ? `${r.seated}명 플레이 중` : '비어 있음';
    li.appendChild(who);

    const go = document.createElement('button');
    go.className = 'tbtn go';
    go.type = 'button';
    go.textContent = '들어가기';
    go.addEventListener('click', () => { location.href = '/t/' + r.code; });
    li.appendChild(go);

    list.appendChild(li);
  }

  const note = $('#lobbyNote');
  if (!connected) note.textContent = '대기실에 연결하는 중입니다';
  else if (!rooms.length) note.textContent = '아직 열린 방이 없습니다 · 먼저 하나 만들어 보세요';
  else note.textContent = '방을 고르면 바로 앉을 수 있습니다';
}

/* ---------------- making a room ---------------- */

function openNew() {
  $('#ovNew').hidden = false;
  $('#newErr').hidden = true;
  $<HTMLButtonElement>('#newBtn').disabled = false;
  $<HTMLInputElement>('#roomIn').focus();
}

function closeNew() {
  $('#ovNew').hidden = true;
}

function showErr(msg: string) {
  const e = $('#newErr');
  if ($('#ovNew').hidden) return;
  e.textContent = msg;
  e.hidden = false;
}
