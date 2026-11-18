const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data', 'quizzes.json');
const RESULT_DELAY_MS = 600; // small grace for late network packets

// ---------- Storage (JSON file) ----------
function loadQuizzes() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function saveQuizzes(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
let quizzes = loadQuizzes();

function validateQuiz(q) {
  if (!q || typeof q.title !== 'string' || !q.title.trim()) return 'Thiếu tên quiz';
  if (!Array.isArray(q.questions) || q.questions.length === 0) return 'Cần ít nhất 1 câu hỏi';
  for (const [i, qs] of q.questions.entries()) {
    if (!qs.text || !qs.text.trim()) return `Câu ${i + 1}: thiếu nội dung`;
    if (!Array.isArray(qs.options) || qs.options.length < 2 || qs.options.length > 4) return `Câu ${i + 1}: cần 2–4 đáp án`;
    if (qs.options.some(o => !String(o).trim())) return `Câu ${i + 1}: đáp án không được để trống`;
    if (!(qs.correct >= 0 && qs.correct < qs.options.length)) return `Câu ${i + 1}: chưa chọn đáp án đúng`;
    if (![5, 10, 20, 30, 60, 90, 120].includes(Number(qs.time))) return `Câu ${i + 1}: thời gian không hợp lệ`;
  }
  return null;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.get('x-admin-key') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Sai mật khẩu admin' });
  next();
}

app.post('/api/login', (req, res) => {
  if (req.body && req.body.password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Sai mật khẩu' });
});
app.get('/api/quizzes', requireAdmin, (req, res) => {
  res.json(quizzes.map(q => ({ id: q.id, title: q.title, count: q.questions.length, updatedAt: q.updatedAt })));
});
app.get('/api/quizzes/:id', requireAdmin, (req, res) => {
  const q = quizzes.find(x => x.id === req.params.id);
  q ? res.json(q) : res.status(404).json({ error: 'Không tìm thấy' });
});
app.post('/api/quizzes', requireAdmin, (req, res) => {
  const err = validateQuiz(req.body);
  if (err) return res.status(400).json({ error: err });
  const quiz = { id: crypto.randomUUID(), title: req.body.title.trim(), questions: sanitizeQuestions(req.body.questions), updatedAt: Date.now() };
  quizzes.push(quiz); saveQuizzes(quizzes);
  res.json(quiz);
});
app.put('/api/quizzes/:id', requireAdmin, (req, res) => {
  const idx = quizzes.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Không tìm thấy' });
  const err = validateQuiz(req.body);
  if (err) return res.status(400).json({ error: err });
  quizzes[idx] = { ...quizzes[idx], title: req.body.title.trim(), questions: sanitizeQuestions(req.body.questions), updatedAt: Date.now() };
  saveQuizzes(quizzes);
  res.json(quizzes[idx]);
});
app.delete('/api/quizzes/:id', requireAdmin, (req, res) => {
  quizzes = quizzes.filter(x => x.id !== req.params.id); saveQuizzes(quizzes);
  res.json({ ok: true });
});
// Backup / restore (free hosts wipe the disk on restart)
app.get('/api/export', requireAdmin, (req, res) => res.json(quizzes));
app.post('/api/import', requireAdmin, (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [req.body];
  let added = 0;
  for (const q of list) {
    if (validateQuiz(q)) continue;
    const id = q.id && !quizzes.some(x => x.id === q.id) ? q.id : crypto.randomUUID();
    if (q.id && quizzes.some(x => x.id === q.id)) continue; // already present
    quizzes.push({ id, title: q.title.trim(), questions: sanitizeQuestions(q.questions), updatedAt: q.updatedAt || Date.now() });
    added++;
  }
  saveQuizzes(quizzes);
  res.json({ added });
});
function sanitizeQuestions(list) {
  return list.map(q => ({
    text: String(q.text).trim(),
    image: typeof q.image === 'string' && q.image.startsWith('data:image/') ? q.image : null,
    options: q.options.map(o => String(o).trim()),
    correct: Number(q.correct),
    time: Number(q.time),
  }));
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- Realtime game ----------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });
const games = new Map(); // pin -> game

function newPin() {
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); } while (games.has(pin));
  return pin;
}

// Kahoot-style scoring: correct answer -> 1000 * (1 - (responseTime / questionTime) / 2)
// => answer instantly ≈ 1000 pts, answer at the last moment ≈ 500 pts, wrong/no answer = 0.
function calcPoints(responseMs, timeLimitSec) {
  const ratio = Math.min(Math.max(responseMs / (timeLimitSec * 1000), 0), 1);
  return Math.round(1000 * (1 - ratio / 2));
}

function leaderboard(game) {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, id: p.id }));
}
function playerList(game) {
  return [...game.players.values()].map(p => ({ id: p.id, name: p.name }));
}

function sendQuestion(game) {
  const q = game.quiz.questions[game.qIndex];
  game.state = 'question';
  game.answers = new Map();
  game.qStart = Date.now() + 3000; // 3s "get ready" countdown before answers open
  const payload = {
    index: game.qIndex, total: game.quiz.questions.length,
    text: q.text, image: q.image, options: q.options, time: q.time,
    startsAt: game.qStart, serverNow: Date.now(),
  };
  io.to(game.pin).emit('question', payload);
  clearTimeout(game.timer);
  game.timer = setTimeout(() => endQuestion(game), 3000 + q.time * 1000 + RESULT_DELAY_MS);
}

function endQuestion(game) {
  if (game.state !== 'question') return;
  clearTimeout(game.timer);
  game.state = 'result';
  const q = game.quiz.questions[game.qIndex];
  const counts = q.options.map(() => 0);
  for (const a of game.answers.values()) counts[a.choice]++;

  // Apply points
  for (const p of game.players.values()) {
    const a = game.answers.get(p.id);
    p.lastPoints = 0; p.lastCorrect = false;
    if (a && a.choice === q.correct) {
      p.lastPoints = calcPoints(a.ms, q.time);
      p.lastCorrect = true;
      p.score += p.lastPoints;
    }
  }
  const board = leaderboard(game);
  const isLast = game.qIndex >= game.quiz.questions.length - 1;
  io.to(game.hostId).emit('question:result', {
    correct: q.correct, counts, answered: game.answers.size, isLast,
    top: board.slice(0, 5),
  });
  for (const row of board) {
    const p = game.players.get(row.id);
    io.to(p.socketId).emit('question:result', {
      correct: p.lastCorrect, answered: game.answers.has(p.id),
      points: p.lastPoints, score: p.score, rank: row.rank, totalPlayers: board.length,
      correctText: q.options[q.correct],
    });
  }
}

function endGame(game) {
  game.state = 'ended';
  const board = leaderboard(game);
  const top5 = board.slice(0, 5).map(({ rank, name, score }) => ({ rank, name, score }));
  io.to(game.hostId).emit('game:over', { top5, totalPlayers: board.length });
  for (const row of board) {
    const p = game.players.get(row.id);
    io.to(p.socketId).emit('game:over', { top5, rank: row.rank, score: row.score, totalPlayers: board.length });
  }
}

io.on('connection', (socket) => {
  // ----- Host -----
  socket.on('host:create', ({ key, quizId }, cb) => {
    if (key !== ADMIN_PASSWORD) return cb({ error: 'Sai mật khẩu admin' });
    const quiz = quizzes.find(q => q.id === quizId);
    if (!quiz) return cb({ error: 'Không tìm thấy quiz' });
    const pin = newPin();
    const game = { pin, quiz, hostId: socket.id, players: new Map(), state: 'lobby', qIndex: -1, answers: new Map(), timer: null };
    games.set(pin, game);
    socket.join(pin);
    socket.data.hostPin = pin;
    cb({ pin, title: quiz.title, total: quiz.questions.length });
  });

  socket.on('host:kick', ({ playerId }) => {
    const game = games.get(socket.data.hostPin);
    if (!game) return;
    const p = game.players.get(playerId);
    if (!p) return;
    io.to(p.socketId).emit('kicked');
    io.sockets.sockets.get(p.socketId)?.leave(game.pin);
    game.players.delete(playerId);
    io.to(game.hostId).emit('players', playerList(game));
  });

  socket.on('host:start', () => {
    const game = games.get(socket.data.hostPin);
    if (!game || game.state !== 'lobby' || game.players.size === 0) return;
    game.qIndex = 0;
    sendQuestion(game);
  });

  socket.on('host:skip', () => {
    const game = games.get(socket.data.hostPin);
    if (game && game.state === 'question') endQuestion(game);
  });

  socket.on('host:next', () => {
    const game = games.get(socket.data.hostPin);
    if (!game || game.state !== 'result') return;
    if (game.qIndex >= game.quiz.questions.length - 1) return endGame(game);
    game.qIndex++;
    sendQuestion(game);
  });

  // ----- Player -----
  socket.on('player:join', ({ pin, name }, cb) => {
    pin = String(pin || '').trim();
    name = String(name || '').trim().slice(0, 20);
    const game = games.get(pin);
    if (!game) return cb({ error: 'Mã PIN không tồn tại' });
    if (game.state !== 'lobby') return cb({ error: 'Game đã bắt đầu' });
    if (!name) return cb({ error: 'Vui lòng nhập tên' });
    if ([...game.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) return cb({ error: 'Tên đã có người dùng' });
    const id = crypto.randomUUID();
    game.players.set(id, { id, name, socketId: socket.id, score: 0, lastPoints: 0, lastCorrect: false });
    socket.join(pin);
    socket.data.playerPin = pin; socket.data.playerId = id;
    io.to(game.hostId).emit('players', playerList(game));
    cb({ ok: true, name, title: game.quiz.title });
  });

  socket.on('player:answer', ({ choice }, cb) => {
    const game = games.get(socket.data.playerPin);
    const id = socket.data.playerId;
    if (!game || game.state !== 'question' || !game.players.has(id)) return cb && cb({ error: 'Không thể trả lời lúc này' });
    if (game.answers.has(id)) return cb && cb({ error: 'Bạn đã trả lời' });
    const q = game.quiz.questions[game.qIndex];
    const now = Date.now();
    if (now < game.qStart) return cb && cb({ error: 'Chưa mở đáp án' });
    const ms = now - game.qStart;
    if (ms > q.time * 1000 + RESULT_DELAY_MS) return cb && cb({ error: 'Hết giờ' });
    choice = Number(choice);
    if (!(choice >= 0 && choice < q.options.length)) return cb && cb({ error: 'Lựa chọn không hợp lệ' });
    game.answers.set(id, { choice, ms });
    cb && cb({ ok: true });
    io.to(game.hostId).emit('answer:count', { answered: game.answers.size, total: game.players.size });
    if (game.answers.size >= game.players.size) setTimeout(() => endQuestion(game), 300);
  });

  socket.on('disconnect', () => {
    if (socket.data.hostPin) {
      const game = games.get(socket.data.hostPin);
      if (game) {
        clearTimeout(game.timer);
        socket.to(game.pin).emit('game:closed');
        games.delete(game.pin);
      }
    }
    if (socket.data.playerPin) {
      const game = games.get(socket.data.playerPin);
      if (game && game.state === 'lobby') {
        game.players.delete(socket.data.playerId);
        io.to(game.hostId).emit('players', playerList(game));
      }
      // In-game disconnects keep their score on the leaderboard.
    }
  });
});

server.listen(PORT, () => {
  console.log(`Quiz server running:`);
  console.log(`  Player: http://localhost:${PORT}/`);
  console.log(`  Admin : http://localhost:${PORT}/admin   (password: ${ADMIN_PASSWORD === 'admin123' ? 'admin123 — đổi bằng biến ADMIN_PASSWORD' : '***'})`);
});
