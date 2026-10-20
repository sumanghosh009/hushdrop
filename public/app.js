const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let pin = '', ws, role = null, created = 0, expires = 0, minutes = 60, left = true, tick, ping;

const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

function toast(t) {
  const el = $('#toast');
  el.textContent = t; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3200);
}

async function api(url, opt) {
  try { const r = await fetch(url, opt); return { ok: r.ok, d: await r.json() }; }
  catch { return { ok: false, d: { error: 'No connection. Check your internet.' } }; }
}

/* ---------- Home: create or join ---------- */
$$('.chip').forEach(c => c.onclick = () => {
  $$('.chip').forEach(x => x.classList.toggle('on', x === c));
  minutes = +c.dataset.min;
});

$('#create').onclick = async () => {
  const { ok, d } = await api('/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes }) });
  ok ? enter(d.pin) : toast(d.error);
};

$('#pin').oninput = e => e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
$('#pin').onkeydown = e => { if (e.key === 'Enter') $('#join').click(); };
$('#join').onclick = async () => {
  const p = $('#pin').value;
  if (p.length !== 6) return toast('Enter all 6 digits.');
  const { ok, d } = await api('/api/check/' + p);
  ok ? enter(p) : toast(d.error);
};

/* ---------- Room ---------- */
function enter(p) {
  pin = p; left = false;
  $('#home').hidden = true; $('#room').hidden = false;
  $('#digits').innerHTML = [...p].map((d, i) => `<span style="--i:${i}">${d}</span>`).join('');
  connect();
}

function home(msg) {
  left = true; clearInterval(tick); clearInterval(ping);
  if (ws) ws.close();
  $('#room').hidden = true; $('#home').hidden = false; $('#pin').value = '';
  if (msg) toast(msg);
}

function connect() {
  const sock = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?pin=' + pin);
  sock.onopen = () => { clearInterval(ping); ping = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 25000); };
  sock.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'init') {
      created = m.createdAt; expires = m.expiresAt; role = m.role;
      $('#feed').innerHTML = ''; m.items.forEach(addItem); showEmpty();
      drawGame(m.game); drawRps(m.rps); run();
    } else if (m.type === 'item') addItem(m.item);
    else if (m.type === 'game') drawGame(m.game);
    else if (m.type === 'rps') drawRps(m.rps);
    else if (m.type === 'expired') end();
  };
  sock.onclose = ev => {
    if (sock !== ws || left || ev.code === 4001) return;
    if (ev.code === 4000) return end('That PIN is no longer valid.');
    setTimeout(() => !left && sock === ws && connect(), 1500); // connection dropped: try again
  };
}

const end = msg => { if (!left) home(msg || 'This PIN expired and everything was deleted.'); };
$('#leave').onclick = () => home();
$('#pincopy').onclick = () => navigator.clipboard.writeText(pin).then(() => toast('PIN copied'), () => toast('Could not copy the PIN.'));

function run() {
  clearInterval(tick);
  const arc = $('#arc'), C = 2 * Math.PI * 19;
  arc.style.strokeDasharray = C;
  const step = () => {
    const ms = expires - Date.now();
    if (ms <= 0) return end();
    arc.style.strokeDashoffset = C * (1 - ms / (expires - created));
    $('.timer').classList.toggle('low', ms < 60000);
    const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    $('#left').textContent = h ? `${h}h ${m}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
  };
  step(); tick = setInterval(step, 1000);
}

$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('on', x === t));
  $('#share').hidden = t.dataset.tab !== 'share';
  $('#games').hidden = t.dataset.tab !== 'games';
});

/* ---------- Share: text and files ---------- */
function showEmpty() {
  if (!$('#feed').children.length) $('#feed').innerHTML = '<li class="empty">Nothing here yet. Send something from either device.</li>';
}

function addItem(it) {
  const feed = $('#feed'), li = document.createElement('li');
  feed.querySelector('.empty')?.remove();
  li.className = 'item';
  if (it.type === 'text') {
    const p = document.createElement('p'), b = document.createElement('button');
    p.textContent = it.text;
    b.className = 'mini'; b.textContent = 'Copy';
    b.onclick = () => navigator.clipboard.writeText(it.text).then(() => toast('Copied'), () => toast('Could not copy. Select the text instead.'));
    li.append(p, b);
  } else {
    const d = document.createElement('div'), n = document.createElement('b'), s = document.createElement('small'), a = document.createElement('a');
    n.textContent = it.name; s.textContent = size(it.size);
    a.className = 'mini'; a.textContent = 'Download'; a.href = `/api/file/${pin}/${it.id}`; a.download = it.name;
    d.append(n, s);
    const w = document.createElement('div'); w.className = 'meta';
    if (/\.(png|jpe?g|gif|webp)$/i.test(it.name)) { // image preview
      const im = document.createElement('img'), u = `/api/file/${pin}/${it.id}?inline=1`;
      im.className = 'thumb'; im.src = u; im.alt = it.name; im.loading = 'lazy'; im.onclick = () => window.open(u, '_blank');
      w.append(im);
    }
    w.append(d); li.append(w, a);
  }
  feed.prepend(li);
}

$('#send').onclick = () => {
  const t = $('#msg').value.trim();
  if (!t) return;
  if (!ws || ws.readyState !== 1) return toast('Reconnecting. Try again in a moment.');
  ws.send(JSON.stringify({ type: 'text', text: t }));
  $('#msg').value = '';
};

$('#file').onchange = e => { [...e.target.files].forEach(upload); e.target.value = ''; };

function upload(f) {
  if (!f) return;
  if (f.size > 25 * 1024 * 1024) return toast('That file is over 25 MB.');
  const x = new XMLHttpRequest(), prog = $('#prog'), bar = $('#bar');
  x.open('POST', '/api/upload/' + pin);
  x.setRequestHeader('x-filename', encodeURIComponent(f.name));
  x.setRequestHeader('Content-Type', 'application/octet-stream');
  prog.hidden = false;
  x.upload.onprogress = ev => bar.style.width = (ev.loaded / ev.total * 100) + '%';
  x.onload = () => {
    prog.hidden = true; bar.style.width = 0;
    if (x.status !== 200) { let m = 'Upload failed.'; try { m = JSON.parse(x.responseText).error || m; } catch {} toast(m); }
  };
  x.onerror = () => { prog.hidden = true; toast('Upload failed. Check your connection.'); };
  x.send(f);
}

/* Drag and drop a file anywhere on the page */
let drag = 0;
addEventListener('dragenter', e => { if (!$('#room').hidden && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { drag++; $('#drop').hidden = false; } });
addEventListener('dragleave', () => { if (drag && !--drag) $('#drop').hidden = true; });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); drag = 0; $('#drop').hidden = true; if (!$('#room').hidden) [...e.dataTransfer.files].forEach(upload); });

/* ---------- Games: Tic-Tac-Toe ---------- */
function drawGame(g) {
  const b = $('#board');
  if (!b.children.length) for (let i = 0; i < 9; i++) {
    const c = document.createElement('button');
    c.className = 'cell'; c.setAttribute('aria-label', 'Square ' + (i + 1));
    c.onclick = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'move', i }));
    b.append(c);
  }
  [...b.children].forEach((c, i) => {
    c.textContent = g.board[i] || ''; c.dataset.v = g.board[i] || '';
    c.classList.toggle('win', !!g.line && g.line.includes(i));
  });
  $('#gstat').textContent = !role ? 'Two players are already playing. You are watching.'
    : g.winner === 'draw' ? "It's a draw."
    : g.winner ? (g.winner === role ? 'You won!' : 'The other player won this round.')
    : g.turn === role ? `Your turn. You are ${role}.` : `Waiting for the other player. You are ${role}.`;
}
$('#again').onclick = () => ws && ws.readyState === 1 && ws.send('{"type":"reset"}');

/* ---------- Games: switcher and Rock Paper Scissors ---------- */
$$('.gchip').forEach(c => c.onclick = () => {
  $$('.gchip').forEach(x => x.classList.toggle('on', x === c));
  $('#ttt').hidden = c.dataset.game !== 'ttt';
  $('#rps').hidden = c.dataset.game !== 'rps';
});
$$('[data-pick]').forEach(b => b.onclick = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'rps', pick: b.dataset.pick })));

function drawRps(r) {
  const me = role, them = me === 'X' ? 'O' : 'X', L = r.last;
  $$('[data-pick]').forEach(b => b.disabled = !me || r.picked[me]);
  $('#rstat').textContent = !me ? 'Two players are already playing. You are watching.'
    : r.picked[me] ? 'Locked in. Waiting for the other player…' : 'Pick one. The other player cannot see it.';
  $('#rscore').textContent = me
    ? (L ? `Last round: you ${L[me]}, they ${L[them]}. ${L.winner === 'draw' ? 'Draw.' : L.winner === me ? 'You won it.' : 'They won it.'} ` : '') + `Score: you ${r.score[me]}, them ${r.score[them]}`
    : `Score: X ${r.score.X}, O ${r.score.O}`;
}
