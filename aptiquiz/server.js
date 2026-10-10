'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 50;
const DEFAULT_SECONDS = 15;
const QUESTIONS_FILE = path.join(__dirname, 'data', 'questions.json');
const STORE_FILE = path.join(__dirname, 'data', 'store.json');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 20000 });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
let store = loadStore();
const rooms = new Map();
const socketPlayer = new Map();
const timers = new Map();
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return { players: {}, colleges: {} }; }
}
function saveStore() {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}
function safeName(value, max = 28) { return String(value || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, max); }
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function shuffle(array) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function publicQuestion(q, player) {
  // Freeze each player's option permutation for the entire question; room updates must not reshuffle it.
  if (!player.optionMap) player.optionMap = shuffle(q.options.map((_, originalIndex) => originalIndex));
  return { id: q.id, text: q.text, options: player.optionMap.map(index => q.options[index]), topic: q.topic, difficulty: q.difficulty };
}
function sortedPlayers(room) {
  return [...room.players.values()].sort((a, b) => b.score - a.score || a.totalAnswerMs - b.totalAnswerMs || a.name.localeCompare(b.name));
}
function leaderboard(room) {
  return sortedPlayers(room).map((p, i) => ({ id: p.id, name: p.name, college: p.college, score: p.score, rank: i + 1, answered: p.answeredCount, correct: p.correctCount }));
}
function snapshot(room, player) {
  const base = { code: room.code, status: room.status, hostId: room.hostId, players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, college: p.college, score: p.score, connected: p.connected })), leaderboard: leaderboard(room), questionNumber: room.questionIndex + 1, totalQuestions: room.questionIds.length, secondsPerQuestion: room.secondsPerQuestion };
  if (room.status === 'playing' && room.currentQuestion) {
    const q = questions.find(x => x.id === room.currentQuestion);
    base.question = player ? publicQuestion(q, player) : { text: q.text, topic: q.topic, difficulty: q.difficulty };
    base.deadline = room.deadline;
    base.answered = player ? player.answeredCurrent : false;
  }
  if (room.status === 'reveal' && room.currentQuestion) {
    const q = questions.find(x => x.id === room.currentQuestion);
    base.reveal = { question: q.text, correctAnswer: q.options[q.answerIndex], explanation: q.explanation || '', topic: q.topic, scores: leaderboard(room) };
  }
  if (room.status === 'finished') base.results = resultsFor(room);
  return base;
}
function emitRoom(room, event = 'room:update') {
  for (const p of room.players.values()) {
    if (p.socketId && p.connected) io.to(p.socketId).emit(event, snapshot(room, p));
  }
  io.to(`spectator:${room.code}`).emit(event, snapshot(room, null));
}
function stopTimer(code) { if (timers.has(code)) clearTimeout(timers.get(code)); timers.delete(code); }
function resultsFor(room) {
  return sortedPlayers(room).map((p, i) => ({ rank: i + 1, name: p.name, college: p.college, score: p.score, answered: p.answeredCount, correct: p.correctCount, accuracy: p.answeredCount ? Math.round(p.correctCount / p.answeredCount * 100) : 0, averageSpeedMs: p.answeredCount ? Math.round(p.totalAnswerMs / p.answeredCount) : null, topicStats: p.topicStats }));
}
function updateLeague(room) {
  for (const p of room.players.values()) {
    const key = `${p.name.toLowerCase()}|${p.college.toLowerCase()}`;
    if (!store.players[key]) store.players[key] = { name: p.name, college: p.college, points: 0, games: 0, wins: 0, correct: 0, answered: 0 };
    const record = store.players[key];
    record.points += p.score; record.games += 1; record.correct += p.correctCount; record.answered += p.answeredCount;
    if (sortedPlayers(room)[0]?.id === p.id) record.wins += 1;
    const collegeKey = p.college.toLowerCase();
    if (!store.colleges[collegeKey]) store.colleges[collegeKey] = { name: p.college, points: 0, games: 0, players: {} };
    store.colleges[collegeKey].points += p.score; store.colleges[collegeKey].games += 1;
    store.colleges[collegeKey].players[p.name] = (store.colleges[collegeKey].players[p.name] || 0) + p.score;
  }
  saveStore();
}
function finishRoom(room) {
  stopTimer(room.code); room.status = 'finished'; room.deadline = null; updateLeague(room); emitRoom(room); io.to(room.code).emit('game:finished', snapshot(room, null));
}
function revealQuestion(room) {
  if (room.status !== 'playing') return;
  stopTimer(room.code); room.status = 'reveal'; room.deadline = null;
  const q = questions.find(x => x.id === room.currentQuestion);
  for (const p of room.players.values()) {
    if (p.answeredCurrent && p.currentAnswerOriginal === q.answerIndex) {
      p.correctCount++;
      p.score += Math.max(100, Math.round(1000 * (1 - Math.min(p.currentAnswerMs, room.secondsPerQuestion * 1000) / (room.secondsPerQuestion * 1000))));
      p.topicStats[q.topic] ||= { correct: 0, answered: 0 };
      p.topicStats[q.topic].correct++;
    }
    if (p.answeredCurrent) { p.answeredCount++; p.totalAnswerMs += p.currentAnswerMs; p.topicStats[q.topic] ||= { correct: 0, answered: 0 }; p.topicStats[q.topic].answered++; }
  }
  room.lastReveal = { correctAnswer: q.options[q.answerIndex] };
  emitRoom(room);
  timers.set(room.code, setTimeout(() => nextQuestion(room), 4500));
}
function startQuestion(room) {
  stopTimer(room.code);
  if (room.questionIndex >= room.questionIds.length) return finishRoom(room);
  room.status = 'playing'; room.currentQuestion = room.questionIds[room.questionIndex]; room.deadline = Date.now() + room.secondsPerQuestion * 1000;
  for (const p of room.players.values()) { p.answeredCurrent = false; p.currentAnswerMs = null; p.currentAnswerOriginal = null; p.optionMap = null; }
  emitRoom(room);
  timers.set(room.code, setTimeout(() => revealQuestion(room), room.secondsPerQuestion * 1000));
}
function nextQuestion(room) { room.questionIndex++; startQuestion(room); }
function getPlayer(socket) { const ref = socketPlayer.get(socket.id); if (!ref) return null; const room = rooms.get(ref.code); return room ? { room, player: room.players.get(ref.playerId) } : null; }
function error(socket, message) { socket.emit('app:error', { message }); }

app.get('/api/questions', (_req, res) => res.json(questions.map(q => ({ ...q }))));
app.post('/api/questions', (req, res) => {
  const { text, options, answerIndex, topic, difficulty, explanation, id } = req.body || {};
  if (!safeName(text, 500) || !Array.isArray(options) || options.length < 2 || options.length > 6 || options.some(o => !safeName(o, 200)) || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) return res.status(400).json({ error: 'Provide a question, 2–6 options and a valid correct-answer index.' });
  const q = { id: id || `q_${crypto.randomUUID()}`, text: safeName(text, 500), options: options.map(o => safeName(o, 200)), answerIndex, topic: safeName(topic || 'General', 40), difficulty: ['Easy','Medium','Hard'].includes(difficulty) ? difficulty : 'Easy', explanation: safeName(explanation || '', 500) };
  const index = questions.findIndex(x => x.id === q.id);
  if (index >= 0) questions[index] = q; else questions.push(q);
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2)); res.json(q);
});
app.put('/api/questions/order', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length !== questions.length || new Set(ids).size !== ids.length || ids.some(id => !questions.some(q => q.id === id))) return res.status(400).json({ error: 'Order must include every question ID exactly once.' });
  questions = ids.map(id => questions.find(q => q.id === id)); fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2)); res.json({ ok: true });
});
app.get('/api/league', (_req, res) => {
  const players = Object.values(store.players).sort((a,b) => b.points - a.points).slice(0, 100).map((p,i) => ({ rank:i+1,...p, accuracy:p.answered?Math.round(p.correct/p.answered*100):0 }));
  const colleges = Object.values(store.colleges).sort((a,b) => b.points - a.points).map((c,i) => ({ rank:i+1,name:c.name,points:c.points,games:c.games,players:Object.keys(c.players).length }));
  res.json({ players, colleges });
});
app.get('/api/health', (_req,res) => res.json({ ok:true, rooms:rooms.size, questions:questions.length, maxPlayers:MAX_PLAYERS }));

io.on('connection', socket => {
  socket.emit('app:ready', { maxPlayers: MAX_PLAYERS });
  socket.on('host:create', (data = {}) => {
    const hostName = safeName(data.name || 'Host'); const college = safeName(data.college || 'Independent');
    const requested = Array.isArray(data.questionIds) ? data.questionIds.filter(id => questions.some(q => q.id === id)) : questions.map(q => q.id);
    if (!requested.length) return error(socket, 'Choose at least one valid question.');
    const code = roomCode(); const hostId = crypto.randomUUID();
    const host = makePlayer({ id:hostId, name:hostName, college, socketId:socket.id, isHost:true });
    const room = { code, hostId, players:new Map([[hostId,host]]), questionIds:requested, questionIndex:0, currentQuestion:null, status:'lobby', deadline:null, secondsPerQuestion:Math.max(5,Math.min(60,Number(data.secondsPerQuestion)||DEFAULT_SECONDS)), createdAt:Date.now() };
    rooms.set(code, room); socketPlayer.set(socket.id,{code,playerId:hostId}); socket.join(code); socket.emit('host:created', snapshot(room,host)); emitRoom(room);
  });
  socket.on('player:join', (data = {}) => {
    const code = safeName(data.code,5).toUpperCase(); const name = safeName(data.name); const college = safeName(data.college || 'Independent');
    const room = rooms.get(code);
    if (!room) return error(socket,'Room code not found. Check the code and try again.');
    if (!name) return error(socket,'Enter a player name.');
    if (room.status === 'finished') return error(socket,'This game has finished. Join another room.');
    const existing = [...room.players.values()].find(p => p.name.toLowerCase() === name.toLowerCase() && p.college.toLowerCase() === college.toLowerCase());
    if (existing && !existing.connected) {
      existing.socketId = socket.id; existing.connected = true; socketPlayer.set(socket.id,{code,playerId:existing.id}); socket.join(code); socket.emit('player:joined', snapshot(room,existing)); emitRoom(room); return;
    }
    if (room.players.size >= MAX_PLAYERS) return error(socket,`Room is full (maximum ${MAX_PLAYERS} players).`);
    if (room.status !== 'lobby') return error(socket,'The game has already started. Reconnection is available using your original name and college.');
    if (existing) return error(socket,'That name is already being used in this room. Choose another name.');
    const player = makePlayer({id:crypto.randomUUID(),name,college,socketId:socket.id,isHost:false}); room.players.set(player.id,player); socketPlayer.set(socket.id,{code,playerId:player.id}); socket.join(code); socket.emit('player:joined',snapshot(room,player)); emitRoom(room);
  });
  socket.on('game:start', () => {
    const ref = socketPlayer.get(socket.id); const room = ref && rooms.get(ref.code);
    if (!room || room.hostId !== ref.playerId) return error(socket,'Only the host can start the game.');
    if (room.status !== 'lobby') return error(socket,'The game has already started.');
    if (room.players.size < 1) return error(socket,'At least one player is required.');
    startQuestion(room);
  });
  socket.on('answer:submit', data => {
    const found = getPlayer(socket); if (!found) return error(socket,'Join a room before answering.');
    const { room, player } = found;
    if (room.status !== 'playing' || player.answeredCurrent) return;
    if (!Number.isInteger(data?.optionIndex) || !player.optionMap || data.optionIndex < 0 || data.optionIndex >= player.optionMap.length) return error(socket,'Invalid answer option.');
    const now = Date.now();
    if (now > room.deadline) return; // Server deadline is authoritative; late answers are ignored.
    player.answeredCurrent = true; player.currentAnswerOriginal = player.optionMap[data.optionIndex];
    player.currentAnswerMs = Math.max(0,Math.min(room.secondsPerQuestion*1000, now - (room.deadline - room.secondsPerQuestion*1000)));
    // Small server receipt-time window makes same-moment answers less sensitive to tiny network jitter.
    player.currentAnswerMs = Math.max(0, player.currentAnswerMs - 150);
    socket.emit('answer:ack',{ accepted:true });
    const active = [...room.players.values()].filter(p => p.connected);
    if (active.length && active.every(p => p.answeredCurrent)) revealQuestion(room);
    else emitRoom(room);
  });
  socket.on('room:resume', (data = {}) => {
    const code = safeName(data.code,5).toUpperCase(); const name = safeName(data.name); const college = safeName(data.college || 'Independent'); const room = rooms.get(code);
    if (!room) return error(socket,'Room no longer exists on this server.');
    const p = [...room.players.values()].find(x => x.name.toLowerCase()===name.toLowerCase() && x.college.toLowerCase()===college.toLowerCase());
    if (!p) return error(socket,'No matching player was found. Rejoin from the lobby if the game has not started.');
    if (p.socketId) socketPlayer.delete(p.socketId); p.socketId=socket.id; p.connected=true; socketPlayer.set(socket.id,{code,playerId:p.id}); socket.join(code); socket.emit('player:joined',snapshot(room,p)); emitRoom(room);
  });
  socket.on('spectator:join', data => { const code=safeName(data.code,5).toUpperCase(); const room=rooms.get(code); if(!room)return error(socket,'Room code not found.'); socket.join(`spectator:${code}`); socket.emit('room:update',snapshot(room,null)); });
  socket.on('disconnect', () => {
    const ref=socketPlayer.get(socket.id); socketPlayer.delete(socket.id); if(!ref)return;
    const room=rooms.get(ref.code); const player=room?.players.get(ref.playerId); if(!player)return;
    player.connected=false; player.socketId=null; emitRoom(room);
    // Keep disconnected players and scores for the life of the room so refresh/network loss can recover.
  });
});
function makePlayer({id,name,college,socketId,isHost}) { return {id,name,college,socketId,isHost,connected:true,score:0,answeredCount:0,correctCount:0,totalAnswerMs:0,answeredCurrent:false,currentAnswerMs:null,currentAnswerOriginal:null,optionMap:null,topicStats:{}}; }
server.listen(PORT, () => console.log(`AptiQuiz running at http://localhost:${PORT}`));
