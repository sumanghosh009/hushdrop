const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

const MAX_FILE = 25 * 1024 * 1024; // 25 MB per file
const DURATIONS = [15, 60, 1440]; // minutes
const sessions = new Map(); // pin -> session (lives only in memory, so nothing is kept after expiry)
const fails = new Map(); // ip -> wrong-PIN counter
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

const newGame = () => ({ board: Array(9).fill(null), turn: 'X', winner: null, line: null });
const live = pin => { const s = sessions.get(pin); return s && s.expiresAt > Date.now() ? s : null; };
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (s, msg) => s.sockets.forEach(ws => send(ws, msg));

function blocked(ip) { const f = fails.get(ip); return f && f.count >= 10 && Date.now() < f.until; }
function fail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() > f.until) fails.set(ip, { count: 1, until: Date.now() + 10 * 60000 });
  else f.count++;
}

// 1. Create a PIN
app.post('/api/create', express.json(), (req, res) => {
  const minutes = Number(req.body && req.body.minutes);
  if (!DURATIONS.includes(minutes)) return res.status(400).json({ error: 'Pick 15 minutes, 1 hour or 24 hours.' });
  if (sessions.size >= 500) return res.status(503).json({ error: 'Server is busy. Try again soon.' });
  let pin;
  do { pin = String(crypto.randomInt(100000, 1000000)); } while (sessions.has(pin));
  const now = Date.now();
  sessions.set(pin, {
    createdAt: now, expiresAt: now + minutes * 60000,
    items: [], files: new Map(), sockets: new Set(),
    game: newGame(), players: { X: null, O: null }
  });
  res.json({ pin });
});

// 2. Check a PIN (wrong guesses are limited per IP)
app.get('/api/check/:pin', (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Too many wrong PINs. Wait a few minutes.' });
  if (!live(req.params.pin)) { fail(req.ip); return res.status(404).json({ error: 'That PIN is wrong or has expired.' }); }
  res.json({ ok: true });
});

// 3. Upload and download files
app.post('/api/upload/:pin', express.raw({ type: '*/*', limit: MAX_FILE }), (req, res) => {
  const s = live(req.params.pin);
  if (!s) return res.status(404).json({ error: 'This PIN has expired.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'That file is empty.' });
  if (s.files.size >= 15) return res.status(400).json({ error: 'Limit is 15 files per PIN.' });
  let name = 'file';
  try { name = decodeURIComponent(req.get('x-filename') || 'file'); } catch {}
  name = name.replace(/[\\/\r\n]/g, '_').slice(0, 120);
  const id = crypto.randomBytes(6).toString('hex');
  s.files.set(id, { name, buf: req.body });
  const item = { type: 'file', id, name, size: req.body.length, at: Date.now() };
  s.items.push(item);
  broadcast(s, { type: 'item', item });
  res.json({ ok: true });
});

app.get('/api/file/:pin/:id', (req, res) => {
  const s = live(req.params.pin);
  const f = s && s.files.get(req.params.id);
  if (!f) return res.status(404).send('This file is gone.');
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff'
  });
  res.send(f.buf);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.status === 413 ? 'That file is over 25 MB.' : 'Something went wrong.' });
});

// 4. Live connection: text, games
wss.on('connection', (ws, req) => {
  const pin = new URL(req.url, 'http://x').searchParams.get('pin');
  const s = live(pin);
  if (!s) return ws.close(4000, 'invalid');
  s.sockets.add(ws);
  ws.role = ['X', 'O'].find(r => !s.players[r]) || null;
  if (ws.role) s.players[ws.role] = ws;
  send(ws, { type: 'init', createdAt: s.createdAt, expiresAt: s.expiresAt, items: s.items, game: s.game, role: ws.role });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!live(pin)) return;
    if (m.type === 'text') {
      const text = String(m.text || '').trim().slice(0, 5000);
      if (!text || s.items.length >= 200) return;
      const item = { type: 'text', text, at: Date.now() };
      s.items.push(item);
      broadcast(s, { type: 'item', item });
    } else if (m.type === 'move') {
      const g = s.game, i = Number(m.i);
      if (g.winner || ws.role !== g.turn || !(i >= 0 && i < 9) || g.board[i]) return;
      g.board[i] = g.turn;
      const line = LINES.find(l => l.every(k => g.board[k] === g.turn));
      if (line) { g.winner = g.turn; g.line = line; }
      else if (g.board.every(Boolean)) g.winner = 'draw';
      else g.turn = g.turn === 'X' ? 'O' : 'X';
      broadcast(s, { type: 'game', game: g });
    } else if (m.type === 'reset') {
      s.game = newGame();
      broadcast(s, { type: 'game', game: s.game });
    }
  });

  ws.on('close', () => {
    s.sockets.delete(ws);
    if (ws.role && s.players[ws.role] === ws) s.players[ws.role] = null;
  });
});

// 5. Auto-delete: every 10 seconds, remove expired PINs with all their text and files
setInterval(() => {
  const now = Date.now();
  for (const [pin, s] of sessions) {
    if (s.expiresAt <= now) {
      broadcast(s, { type: 'expired' });
      s.sockets.forEach(w => w.close(4001, 'expired'));
      sessions.delete(pin);
    }
  }
  for (const [ip, f] of fails) if (f.until < now) fails.delete(ip);
}, 10000);

server.listen(process.env.PORT || 3000, () => console.log('Hushdrop is running'));
