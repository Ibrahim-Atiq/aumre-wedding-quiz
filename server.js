/**
 * ============================================================================
 * ALL-IN-ONE MULTIPLAYER WEDDING QUIZ: "HOW WELL DO YOU KNOW AUMRE & JOUDY?"
 * ============================================================================
 * 
 * Production-ready single-file Node.js app for 50-100+ concurrent players.
 * Designed for free-tier Render deployment (single port, zero database,
 * 20s WebSocket heartbeat, resilient mobile reconnects).
 *
 * ----------------------------------------------------------------------------
 * PACKAGE.JSON BLUEPRINT:
 * ----------------------------------------------------------------------------
 * {
 *   "name": "aumre-joudy-wedding-quiz",
 *   "version": "1.0.0",
 *   "description": "Multiplayer Wedding Quiz for Aumre & Joudy",
 *   "main": "server.js",
 *   "scripts": {
 *     "start": "node server.js"
 *   },
 *   "dependencies": {
 *     "express": "^4.21.2",
 *     "ws": "^8.18.0"
 *   }
 * }
 * ----------------------------------------------------------------------------
 * 
 * QUICK START:
 * 1. npm install express ws
 * 2. node server.js
 * 3. Open http://localhost:3000/host for Host/MC Screen (Projector/TV)
 * 4. Open http://localhost:3000/ for Mobile Guests
 *
 * HOST PIN: 1234 (can be changed via HOST_PIN env var or in code below)
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const HOST_PIN = process.env.HOST_PIN || "1234";
const QUESTION_TIMER_SECONDS = 20;
const HEARTBEAT_INTERVAL = 20000; // 20s Render WS keepalive ping

// --- 20 OFFICIAL QUESTIONS & ANSWER KEY (COUPLE: AUMRE & JOUDY) ---
const QUESTIONS = [
  { id: 1,  question: "Who is the early bird?", correctAnswer: "Joudy" },
  { id: 2,  question: "Who is more likely to lose their keys or phone?", correctAnswer: "Joudy" },
  { id: 3,  question: "Who is the more optimistic one?", correctAnswer: "Aumre" },
  { id: 4,  question: "Who is more likely to overthink a decision?", correctAnswer: "Joudy" },
  { id: 5,  question: "Who is more likely to plan ahead?", correctAnswer: "Joudy" },
  { id: 6,  question: "Who is more likely to be the peacemaker in an argument?", correctAnswer: "Aumre" },
  { id: 7,  question: "Who is more likely to hold a grudge?", correctAnswer: "Joudy" },
  { id: 8,  question: "Who is more likely to say \"I told you so\"?", correctAnswer: "Aumre" },
  { id: 9,  question: "Who handles stress better?", correctAnswer: "Aumre" },
  { id: 10, question: "Who is more likely to get emotional at a wedding?", correctAnswer: "Joudy" },
  { id: 11, question: "Who is more likely to be late?", correctAnswer: "Aumre" },
  { id: 12, question: "Who is the big-picture thinker?", correctAnswer: "Joudy" },
  { id: 13, question: "Who is more likely to take a risk on a new experience?", correctAnswer: "Aumre" },
  { id: 14, question: "Who is more likely to be sentimental about old memories?", correctAnswer: "Aumre" },
  { id: 15, question: "Who is more likely to remember birthdays?", correctAnswer: "Aumre" },
  { id: 16, question: "Who is more likely to give advice before being asked?", correctAnswer: "Aumre" },
  { id: 17, question: "Who is more likely to need alone time after a busy day?", correctAnswer: "Aumre" },
  { id: 18, question: "Who bounces back faster after a bad day?", correctAnswer: "Aumre" },
  { id: 19, question: "Who has the bigger sweet tooth?", correctAnswer: "Joudy" },
  { id: 20, question: "Who is the more introverted one in a crowd?", correctAnswer: "Joudy" }
];

// --- IN-MEMORY GAME STATE ---
const players = new Map(); // playerId -> { id, nickname, score, ws, connected: bool, answers: {} }
let hostSockets = new Set();

let gameState = {
  status: 'LOBBY', // 'LOBBY' | 'QUESTION' | 'REVEAL' | 'LEADERBOARD' | 'FINAL'
  questionIndex: 0,
  timeRemaining: QUESTION_TIMER_SECONDS,
  isTimerRunning: false,
  questionStartTime: null,
  answers: {} // playerId -> { answer: 'Aumre' | 'Joudy', timestamp: number, pointsEarned: number }
};

let timerInterval = null;

// --- TIMER CONTROLLER ---
function startTimer() {
  stopTimer();
  gameState.isTimerRunning = true;
  gameState.questionStartTime = Date.now();
  gameState.timeRemaining = QUESTION_TIMER_SECONDS;

  broadcastGameState();

  timerInterval = setInterval(() => {
    gameState.timeRemaining -= 1;
    if (gameState.timeRemaining <= 0) {
      stopTimer();
      gameState.timeRemaining = 0;
      handleTimerExpired();
    } else {
      broadcastTimerTick();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  gameState.isTimerRunning = false;
}

function handleTimerExpired() {
  revealCurrentQuestion();
}

// --- SCORING & REVEAL LOGIC ---
function revealCurrentQuestion() {
  stopTimer();
  gameState.status = 'REVEAL';

  const currentQ = QUESTIONS[gameState.questionIndex];
  const correct = currentQ.correctAnswer;

  // Calculate vote counts
  let aumreVotes = 0;
  let joudyVotes = 0;

  for (const pid in gameState.answers) {
    const ans = gameState.answers[pid].answer;
    if (ans === 'Aumre') aumreVotes++;
    if (ans === 'Joudy') joudyVotes++;
  }

  const totalVotes = aumreVotes + joudyVotes;
  const aumrePct = totalVotes > 0 ? Math.round((aumreVotes / totalVotes) * 100) : 50;
  const joudyPct = totalVotes > 0 ? (100 - aumrePct) : 50;

  // Send personalized results to players and general results to host
  broadcastReveal({
    questionIndex: gameState.questionIndex,
    correctAnswer: correct,
    aumreVotes,
    joudyVotes,
    aumrePct,
    joudyPct,
    totalVotes
  });
}

function getLeaderboard(limit = 10) {
  const list = Array.from(players.values())
    .map(p => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score || 0,
      connected: p.connected
    }))
    .sort((a, b) => b.score - a.score);

  return {
    top: list.slice(0, limit),
    totalPlayers: list.length,
    rankings: list
  };
}

// --- BROADCAST HELPERS ---
function broadcastToAll(messageObj) {
  const payload = JSON.stringify(messageObj);
  // Send to host
  hostSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
  // Send to players
  players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
  });
}

function broadcastTimerTick() {
  const payload = JSON.stringify({
    type: 'TIMER_TICK',
    timeRemaining: gameState.timeRemaining
  });
  hostSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
  players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
  });
}

function getHostStatePayload() {
  const currentQ = QUESTIONS[gameState.questionIndex] || null;
  const answeredCount = Object.keys(gameState.answers).length;
  const totalActivePlayers = Array.from(players.values()).filter(p => p.connected).length;
  const leaderboard = getLeaderboard(10);

  let aumreVotes = 0;
  let joudyVotes = 0;
  for (const pid in gameState.answers) {
    if (gameState.answers[pid].answer === 'Aumre') aumreVotes++;
    if (gameState.answers[pid].answer === 'Joudy') joudyVotes++;
  }
  const totalVotes = aumreVotes + joudyVotes;

  return {
    type: 'HOST_STATE_UPDATE',
    status: gameState.status,
    questionIndex: gameState.questionIndex,
    totalQuestions: QUESTIONS.length,
    currentQuestion: currentQ,
    timeRemaining: gameState.timeRemaining,
    isTimerRunning: gameState.isTimerRunning,
    answeredCount,
    totalActivePlayers,
    totalRegisteredPlayers: players.size,
    leaderboard: leaderboard.top,
    votingStats: {
      aumreVotes,
      joudyVotes,
      totalVotes,
      aumrePct: totalVotes > 0 ? Math.round((aumreVotes / totalVotes) * 100) : 0,
      joudyPct: totalVotes > 0 ? (100 - Math.round((aumreVotes / totalVotes) * 100)) : 0
    }
  };
}

function broadcastGameState() {
  // Update Host
  const hostPayload = JSON.stringify(getHostStatePayload());
  hostSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(hostPayload);
  });

  // Update Players
  const currentQ = QUESTIONS[gameState.questionIndex];
  const leaderboard = getLeaderboard(players.size);

  players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      const myAnswer = gameState.answers[p.id] ? gameState.answers[p.id].answer : null;
      const myRank = leaderboard.rankings.findIndex(item => item.id === p.id) + 1;

      p.ws.send(JSON.stringify({
        type: 'PLAYER_STATE_UPDATE',
        status: gameState.status,
        questionIndex: gameState.questionIndex,
        totalQuestions: QUESTIONS.length,
        question: currentQ ? currentQ.question : '',
        timeRemaining: gameState.timeRemaining,
        score: p.score,
        myAnswer,
        rank: myRank || 1,
        totalPlayers: leaderboard.totalPlayers
      }));
    }
  });
}

function broadcastReveal(stats) {
  const hostPayload = JSON.stringify({
    ...getHostStatePayload(),
    type: 'HOST_STATE_UPDATE',
    status: 'REVEAL'
  });
  hostSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(hostPayload);
  });

  const leaderboard = getLeaderboard(players.size);

  players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      const answerRecord = gameState.answers[p.id];
      const myAnswer = answerRecord ? answerRecord.answer : null;
      const isCorrect = myAnswer === stats.correctAnswer;
      const pointsEarned = answerRecord ? answerRecord.pointsEarned : 0;
      const myRank = leaderboard.rankings.findIndex(item => item.id === p.id) + 1;

      p.ws.send(JSON.stringify({
        type: 'REVEAL_RESULT',
        questionIndex: gameState.questionIndex,
        correctAnswer: stats.correctAnswer,
        myAnswer,
        isCorrect,
        pointsEarned,
        newScore: p.score,
        rank: myRank,
        totalPlayers: leaderboard.totalPlayers,
        aumrePct: stats.aumrePct,
        joudyPct: stats.joudyPct
      }));
    }
  });
}

// --- EXPRESS APP SETUP ---
const app = express();
app.use(express.json());

// 1. HOST ROUTE: /host
app.get('/host', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HOST_HTML);
});

// 2. PLAYER ROUTE: /
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PLAYER_HTML);
});

// Health check for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', players: players.size });
});

// --- HTTP & WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let clientType = 'UNKNOWN'; // 'HOST' | 'PLAYER'
  let attachedPlayerId = null;

  ws.on('message', (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw);

      // --- HOST MESSAGES ---
      if (msg.type === 'HOST_AUTH') {
        if (msg.pin === HOST_PIN) {
          clientType = 'HOST';
          hostSockets.add(ws);
          ws.send(JSON.stringify({ type: 'HOST_AUTH_OK' }));
          ws.send(JSON.stringify(getHostStatePayload()));
        } else {
          ws.send(JSON.stringify({ type: 'HOST_AUTH_FAIL', error: 'Invalid PIN' }));
        }
        return;
      }

      if (clientType === 'HOST') {
        handleHostAction(msg);
        return;
      }

      // --- PLAYER MESSAGES ---
      if (msg.type === 'PLAYER_JOIN') {
        const nickname = (msg.nickname || '').trim().slice(0, 18) || 'Guest';
        let pId = msg.playerId;

        // Reconnect existing or register new
        if (pId && players.has(pId)) {
          const existing = players.get(pId);
          existing.ws = ws;
          existing.connected = true;
          existing.nickname = nickname || existing.nickname;
          attachedPlayerId = pId;
        } else {
          pId = crypto.randomUUID();
          attachedPlayerId = pId;
          players.set(pId, {
            id: pId,
            nickname,
            score: 0,
            ws,
            connected: true,
            answers: {}
          });
        }

        clientType = 'PLAYER';

        ws.send(JSON.stringify({
          type: 'JOIN_CONFIRMED',
          playerId: pId,
          nickname: players.get(pId).nickname,
          score: players.get(pId).score
        }));

        broadcastGameState();
        return;
      }

      if (msg.type === 'PLAYER_REJOIN') {
        const pId = msg.playerId;
        if (pId && players.has(pId)) {
          const p = players.get(pId);
          p.ws = ws;
          p.connected = true;
          attachedPlayerId = pId;
          clientType = 'PLAYER';

          ws.send(JSON.stringify({
            type: 'REJOIN_CONFIRMED',
            playerId: p.id,
            nickname: p.nickname,
            score: p.score
          }));

          broadcastGameState();
        } else {
          ws.send(JSON.stringify({ type: 'REJOIN_EXPIRED' }));
        }
        return;
      }

      if (msg.type === 'SUBMIT_ANSWER' && attachedPlayerId) {
        if (gameState.status !== 'QUESTION') return;
        if (gameState.answers[attachedPlayerId]) return; // already answered this question

        const chosen = msg.answer;
        if (chosen !== 'Aumre' && chosen !== 'Joudy') return;

        const currentQ = QUESTIONS[gameState.questionIndex];
        const isCorrect = chosen === currentQ.correctAnswer;

        // Speed scoring: 500 base points + up to 500 speed bonus
        let points = 0;
        if (isCorrect) {
          const elapsedSec = (Date.now() - (gameState.questionStartTime || Date.now())) / 1000;
          const speedFactor = Math.max(0, 1 - (elapsedSec / QUESTION_TIMER_SECONDS));
          points = Math.round(500 + (500 * speedFactor));
        }

        const p = players.get(attachedPlayerId);
        if (p) {
          p.score = (p.score || 0) + points;
        }

        gameState.answers[attachedPlayerId] = {
          answer: chosen,
          timestamp: Date.now(),
          pointsEarned: points
        };

        // Confirm to player immediately
        ws.send(JSON.stringify({
          type: 'ANSWER_ACCEPTED',
          answer: chosen,
          questionIndex: gameState.questionIndex
        }));

        // Notify host about answered count update
        const hostPayload = JSON.stringify(getHostStatePayload());
        hostSockets.forEach(h => {
          if (h.readyState === WebSocket.OPEN) h.send(hostPayload);
        });

        // If everyone answered, notify host
        const activeCount = Array.from(players.values()).filter(pl => pl.connected).length;
        const ansCount = Object.keys(gameState.answers).length;
        if (activeCount > 0 && ansCount >= activeCount) {
          // All active players answered
          hostSockets.forEach(h => {
            if (h.readyState === WebSocket.OPEN) {
              h.send(JSON.stringify({ type: 'ALL_ANSWERED' }));
            }
          });
        }
      }

    } catch (e) {
      console.error('Error handling WS message:', e);
    }
  });

  ws.on('close', () => {
    if (clientType === 'HOST') {
      hostSockets.delete(ws);
    } else if (attachedPlayerId && players.has(attachedPlayerId)) {
      const p = players.get(attachedPlayerId);
      p.connected = false;
      p.ws = null;
      // Update host screen active player count
      const hostPayload = JSON.stringify(getHostStatePayload());
      hostSockets.forEach(h => {
        if (h.readyState === WebSocket.OPEN) h.send(hostPayload);
      });
    }
  });
});

// --- HOST ACTION CONTROLLER ---
function handleHostAction(msg) {
  switch (msg.action) {
    case 'START_GAME':
      gameState.status = 'QUESTION';
      gameState.questionIndex = 0;
      gameState.answers = {};
      startTimer();
      break;

    case 'REVEAL_NOW':
      if (gameState.status === 'QUESTION') {
        revealCurrentQuestion();
      }
      break;

    case 'SHOW_LEADERBOARD':
      stopTimer();
      gameState.status = 'LEADERBOARD';
      broadcastGameState();
      break;

    case 'NEXT_QUESTION':
      if (gameState.questionIndex + 1 < QUESTIONS.length) {
        gameState.questionIndex += 1;
        gameState.answers = {};
        gameState.status = 'QUESTION';
        startTimer();
      } else {
        stopTimer();
        gameState.status = 'FINAL';
        broadcastGameState();
      }
      break;

    case 'PREV_QUESTION':
      if (gameState.questionIndex > 0) {
        gameState.questionIndex -= 1;
        gameState.answers = {};
        gameState.status = 'QUESTION';
        startTimer();
      }
      break;

    case 'SHOW_FINAL':
      stopTimer();
      gameState.status = 'FINAL';
      broadcastGameState();
      break;

    case 'RESET_GAME':
      stopTimer();
      gameState.status = 'LOBBY';
      gameState.questionIndex = 0;
      gameState.answers = {};
      players.forEach(p => { p.score = 0; });
      broadcastGameState();
      break;

    case 'PAUSE_RESUME_TIMER':
      if (gameState.isTimerRunning) {
        stopTimer();
      } else if (gameState.status === 'QUESTION' && gameState.timeRemaining > 0) {
        gameState.isTimerRunning = true;
        gameState.questionStartTime = Date.now() - ((QUESTION_TIMER_SECONDS - gameState.timeRemaining) * 1000);
        timerInterval = setInterval(() => {
          gameState.timeRemaining -= 1;
          if (gameState.timeRemaining <= 0) {
            stopTimer();
            gameState.timeRemaining = 0;
            handleTimerExpired();
          } else {
            broadcastTimerTick();
          }
        }, 1000);
      }
      broadcastGameState();
      break;
  }
}

// --- RENDER FREE-TIER WEBSOCKET KEEPALIVE HEARTBEAT ---
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
  clearInterval(heartbeat);
});

// Start Server
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` 💍 AUMRE & JOUDY WEDDING QUIZ SERVER RUNNING!`);
  console.log(` ------------------------------------------------------`);
  console.log(` 🌐 Mobile Guest URL: http://localhost:${PORT}/`);
  console.log(` 📺 Host / MC Screen: http://localhost:${PORT}/host`);
  console.log(` 🔑 Host PIN:         ${HOST_PIN}`);
  console.log(`======================================================\n`);
});


// ============================================================================
// FRONTEND: HOST / MC DISPLAY TEMPLATE (/host)
// ============================================================================
const HOST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Host Screen | Aumre & Joudy Wedding Quiz</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,700;1,600&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    :root {
      --bg-dark: #0a0d14;
      --card-bg: rgba(18, 24, 38, 0.85);
      --gold: #d4af37;
      --gold-light: #f7e7b4;
      --groom-blue: #2563eb;
      --groom-dark: #1e3a8a;
      --bride-rose: #f43f5e;
      --bride-dark: #9f1239;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 20%, #171f33 0%, #080b11 100%);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Ambient Wedding Lights */
    .ambient-glow {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: 
        radial-gradient(circle at 15% 15%, rgba(212, 175, 55, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 85% 85%, rgba(244, 63, 94, 0.06) 0%, transparent 40%),
        radial-gradient(circle at 80% 20%, rgba(37, 99, 235, 0.08) 0%, transparent 40%);
      pointer-events: none;
      z-index: 0;
    }

    header {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.2rem 2.5rem;
      border-bottom: 1px solid rgba(212, 175, 55, 0.2);
      backdrop-filter: blur(12px);
      background: rgba(10, 13, 20, 0.6);
    }
    .brand {
      font-family: 'Cormorant Garamond', serif;
      font-size: 2.2rem;
      font-weight: 700;
      letter-spacing: 1px;
      color: var(--gold-light);
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .brand span { color: var(--gold); }
    .header-stats {
      display: flex;
      align-items: center;
      gap: 1.5rem;
    }
    .stat-pill {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 0.5rem 1.2rem;
      border-radius: 999px;
      font-size: 0.95rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .stat-pill .dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 10px #10b981;
    }

    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      z-index: 10;
      padding: 2rem 3rem;
      max-width: 1400px;
      margin: 0 auto;
      width: 100%;
    }

    /* Views */
    .view { display: none; width: 100%; height: 100%; animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
    .view.active { display: flex; flex-direction: column; align-items: center; justify-content: center; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    /* LOBBY VIEW */
    .lobby-container {
      display: grid;
      grid-template-columns: 1fr 1.1fr;
      gap: 3.5rem;
      align-items: center;
      background: var(--card-bg);
      border: 1px solid rgba(212, 175, 55, 0.3);
      border-radius: 28px;
      padding: 3.5rem;
      box-shadow: 0 25px 60px rgba(0,0,0,0.5), 0 0 30px rgba(212, 175, 55, 0.1);
      width: 100%;
    }
    .qr-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      background: white;
      padding: 2rem;
      border-radius: 20px;
      color: #0f172a;
    }
    #qrcode {
      margin-bottom: 1.2rem;
      padding: 10px;
      border-radius: 12px;
      background: white;
    }
    #qrcode img { display: block; }
    .qr-card p {
      font-size: 1.15rem;
      font-weight: 700;
      color: #1e293b;
    }
    .qr-card .url-pill {
      font-size: 0.95rem;
      color: #64748b;
      margin-top: 0.3rem;
      font-family: monospace;
      word-break: break-all;
    }
    .lobby-info {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    .lobby-title {
      font-family: 'Cormorant Garamond', serif;
      font-size: 3.6rem;
      line-height: 1.1;
      color: var(--gold-light);
    }
    .lobby-subtitle {
      font-size: 1.25rem;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .guest-counter {
      display: flex;
      align-items: baseline;
      gap: 0.8rem;
    }
    .guest-counter .num {
      font-size: 4rem;
      font-weight: 800;
      color: var(--gold);
    }
    .guest-counter .label {
      font-size: 1.2rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .btn-start {
      background: linear-gradient(135deg, #d4af37 0%, #aa8010 100%);
      color: #0b0f19;
      border: none;
      padding: 1.2rem 2.8rem;
      border-radius: 16px;
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: 0.5px;
      cursor: pointer;
      transition: all 0.25s ease;
      box-shadow: 0 10px 30px rgba(212, 175, 55, 0.35);
      align-self: flex-start;
    }
    .btn-start:hover {
      transform: translateY(-2px) scale(1.02);
      box-shadow: 0 14px 40px rgba(212, 175, 55, 0.5);
    }

    /* QUESTION VIEW */
    .question-screen {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2rem;
    }
    .q-top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
    }
    .q-counter-badge {
      font-size: 1.2rem;
      color: var(--gold);
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    .timer-circle {
      position: relative;
      width: 100px;
      height: 100px;
    }
    .timer-circle svg {
      transform: rotate(-90deg);
      width: 100px;
      height: 100px;
    }
    .timer-circle circle {
      fill: none;
      stroke-width: 8;
    }
    .timer-bg { stroke: rgba(255, 255, 255, 0.1); }
    .timer-progress {
      stroke: var(--gold);
      stroke-linecap: round;
      stroke-dasharray: 264;
      stroke-dashoffset: 0;
      transition: stroke-dashoffset 1s linear, stroke 0.3s ease;
    }
    .timer-text {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      font-size: 2.2rem;
      font-weight: 800;
      color: #fff;
    }
    .question-box {
      background: var(--card-bg);
      border: 1px solid rgba(212, 175, 55, 0.4);
      border-radius: 24px;
      padding: 3rem 4rem;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6);
      width: 100%;
      max-width: 1100px;
    }
    .question-box h2 {
      font-family: 'Cormorant Garamond', serif;
      font-size: 3.4rem;
      line-height: 1.2;
      color: #ffffff;
      margin-bottom: 0.5rem;
    }
    .live-progress-bar-container {
      width: 100%;
      max-width: 800px;
      margin-top: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .bar-labels {
      display: flex;
      justify-content: space-between;
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--text-muted);
    }
    .bar-track {
      background: rgba(255, 255, 255, 0.1);
      height: 16px;
      border-radius: 999px;
      overflow: hidden;
    }
    .bar-fill {
      background: linear-gradient(90deg, #10b981 0%, #34d399 100%);
      height: 100%;
      width: 0%;
      transition: width 0.3s ease;
      border-radius: 999px;
    }

    /* REVEAL SCREEN */
    .reveal-card {
      width: 100%;
      max-width: 1100px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2.5rem;
    }
    .winner-announcement {
      text-align: center;
    }
    .winner-announcement .badge {
      display: inline-block;
      padding: 0.4rem 1.4rem;
      background: rgba(212, 175, 55, 0.2);
      border: 1px solid var(--gold);
      color: var(--gold-light);
      border-radius: 999px;
      font-size: 1.1rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 0.8rem;
    }
    .winner-announcement h1 {
      font-family: 'Cormorant Garamond', serif;
      font-size: 4.2rem;
      color: #fff;
    }
    .voting-bars-container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2.5rem;
      width: 100%;
    }
    .candidate-card {
      background: var(--card-bg);
      border-radius: 24px;
      padding: 2.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
      overflow: hidden;
      border: 2px solid transparent;
      transition: transform 0.3s ease;
    }
    .candidate-card.groom { border-color: rgba(37, 99, 235, 0.5); }
    .candidate-card.bride { border-color: rgba(244, 63, 94, 0.5); }
    .candidate-card.is-winner {
      border-color: var(--gold);
      box-shadow: 0 0 40px rgba(212, 175, 55, 0.4);
      transform: scale(1.03);
    }
    .winner-ribbon {
      display: none;
      position: absolute;
      top: 15px; right: 15px;
      background: var(--gold);
      color: #000;
      padding: 0.3rem 0.9rem;
      border-radius: 999px;
      font-weight: 800;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .candidate-card.is-winner .winner-ribbon { display: block; }
    .candidate-name {
      font-size: 2.4rem;
      font-weight: 800;
      margin-bottom: 0.3rem;
    }
    .candidate-role {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 1.5rem;
    }
    .candidate-pct {
      font-size: 5rem;
      font-weight: 800;
      line-height: 1;
      margin-bottom: 0.6rem;
    }
    .groom .candidate-pct { color: #60a5fa; }
    .bride .candidate-pct { color: #fb7185; }
    .candidate-votes {
      font-size: 1.2rem;
      color: var(--text-muted);
      font-weight: 600;
    }

    /* LEADERBOARD VIEW */
    .leaderboard-container {
      width: 100%;
      max-width: 900px;
      background: var(--card-bg);
      border: 1px solid rgba(212, 175, 55, 0.3);
      border-radius: 28px;
      padding: 2.5rem 3.5rem;
      box-shadow: 0 25px 60px rgba(0,0,0,0.5);
    }
    .lb-header {
      text-align: center;
      margin-bottom: 2rem;
    }
    .lb-header h2 {
      font-family: 'Cormorant Garamond', serif;
      font-size: 3rem;
      color: var(--gold-light);
    }
    .lb-list {
      display: flex;
      flex-direction: column;
      gap: 0.8rem;
    }
    .lb-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.6rem;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 1.25rem;
      font-weight: 700;
      transition: all 0.3s ease;
    }
    .lb-row:nth-child(1) {
      background: linear-gradient(90deg, rgba(212, 175, 55, 0.25) 0%, rgba(255, 255, 255, 0.05) 100%);
      border-color: var(--gold);
      transform: scale(1.02);
    }
    .lb-row:nth-child(2) {
      background: linear-gradient(90deg, rgba(203, 213, 225, 0.2) 0%, rgba(255, 255, 255, 0.05) 100%);
      border-color: #cbd5e1;
    }
    .lb-row:nth-child(3) {
      background: linear-gradient(90deg, rgba(205, 127, 50, 0.2) 0%, rgba(255, 255, 255, 0.05) 100%);
      border-color: #cd7f32;
    }
    .lb-left {
      display: flex;
      align-items: center;
      gap: 1.2rem;
    }
    .lb-rank {
      width: 38px;
      font-size: 1.4rem;
      color: var(--gold);
    }
    .lb-name {
      color: #fff;
      font-weight: 700;
    }
    .lb-score {
      font-size: 1.4rem;
      color: var(--gold-light);
      font-weight: 800;
    }

    /* FINAL PODIUM */
    .podium-container {
      width: 100%;
      max-width: 1000px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2.5rem;
    }
    .podium-stage {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      gap: 1.5rem;
      width: 100%;
      margin-top: 1rem;
    }
    .podium-pillar {
      flex: 1;
      max-width: 260px;
      background: var(--card-bg);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 20px 20px 0 0;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
    }
    .pillar-1 {
      height: 380px;
      border-color: var(--gold);
      background: linear-gradient(180deg, rgba(212, 175, 55, 0.3) 0%, rgba(18, 24, 38, 0.9) 100%);
      box-shadow: 0 0 50px rgba(212, 175, 55, 0.4);
    }
    .pillar-2 {
      height: 300px;
      border-color: #94a3b8;
      background: linear-gradient(180deg, rgba(148, 163, 184, 0.2) 0%, rgba(18, 24, 38, 0.9) 100%);
    }
    .pillar-3 {
      height: 240px;
      border-color: #cd7f32;
      background: linear-gradient(180deg, rgba(205, 127, 50, 0.2) 0%, rgba(18, 24, 38, 0.9) 100%);
    }
    .podium-badge {
      font-size: 2.8rem;
      margin-bottom: 0.5rem;
    }
    .podium-name {
      font-size: 1.6rem;
      font-weight: 800;
      color: #fff;
      word-break: break-word;
    }
    .podium-score {
      font-size: 1.3rem;
      font-weight: 700;
      color: var(--gold-light);
      margin-top: 0.3rem;
    }

    /* HOST CONTROLS BAR (AT BOTTOM) */
    footer {
      position: relative;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 2.5rem;
      background: rgba(10, 13, 20, 0.8);
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(12px);
    }
    .controls-left, .controls-right {
      display: flex;
      gap: 0.8rem;
      align-items: center;
    }
    .btn-ctrl {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 0.65rem 1.4rem;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.2s ease;
    }
    .btn-ctrl:hover {
      background: rgba(255, 255, 255, 0.15);
      transform: translateY(-1px);
    }
    .btn-ctrl.primary {
      background: var(--gold);
      color: #0b0f19;
      border-color: var(--gold);
    }
    .btn-ctrl.primary:hover {
      background: var(--gold-light);
    }
    .btn-ctrl.danger {
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.3);
    }

    /* AUTH PIN MODAL */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-box {
      background: #111827;
      border: 1px solid var(--gold);
      border-radius: 24px;
      padding: 3rem;
      width: 100%;
      max-width: 420px;
      text-align: center;
      box-shadow: 0 25px 60px rgba(0,0,0,0.8);
    }
    .modal-box h2 {
      font-family: 'Cormorant Garamond', serif;
      font-size: 2.4rem;
      color: var(--gold-light);
      margin-bottom: 0.5rem;
    }
    .modal-box p {
      color: var(--text-muted);
      margin-bottom: 1.5rem;
    }
    .pin-input {
      width: 100%;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 12px;
      font-size: 1.8rem;
      text-align: center;
      color: #fff;
      padding: 0.8rem;
      letter-spacing: 6px;
      margin-bottom: 1.5rem;
      outline: none;
    }
    .pin-input:focus { border-color: var(--gold); }
  </style>
</head>
<body>
  <div class="ambient-glow"></div>

  <!-- PIN AUTH MODAL -->
  <div id="pinModal" class="modal-overlay">
    <div class="modal-box">
      <h2>Host Access</h2>
      <p>Enter Host PIN to manage the quiz</p>
      <input type="password" id="pinInput" class="pin-input" placeholder="••••" maxlength="8" autofocus>
      <button class="btn-start" style="width: 100%;" onclick="submitHostPin()">Unlock Host</button>
      <div id="pinError" style="color: #ef4444; margin-top: 1rem; font-weight: 600; display: none;">Invalid PIN</div>
    </div>
  </div>

  <header>
    <div class="brand">💍 Aumre &amp; Joudy <span>Quiz</span></div>
    <div class="header-stats">
      <div class="stat-pill">
        <span class="dot"></span>
        <span id="headerPlayerCount">0 Guests Online</span>
      </div>
      <button class="btn-ctrl" onclick="toggleSound()" id="soundBtn">🔊 Sound: ON</button>
      <button class="btn-ctrl" onclick="toggleFullscreen()">⛶ Fullscreen</button>
    </div>
  </header>

  <main>
    <!-- 1. LOBBY VIEW -->
    <div id="viewLobby" class="view active">
      <div class="lobby-container">
        <div class="qr-card">
          <div id="qrcode"></div>
          <p>Scan with your phone to join!</p>
          <div class="url-pill" id="qrUrlText">Loading...</div>
        </div>
        <div class="lobby-info">
          <h1 class="lobby-title">How Well Do You Know The Couple?</h1>
          <p class="lobby-subtitle">Connect on your smartphone, answer fast, and compete for the top of the wedding leaderboard!</p>
          <div class="guest-counter">
            <span class="num" id="lobbyCount">0</span>
            <span class="label">Guests in Lobby</span>
          </div>
          <button class="btn-start" onclick="hostAction('START_GAME')">Start Quiz &rarr;</button>
        </div>
      </div>
    </div>

    <!-- 2. QUESTION VIEW -->
    <div id="viewQuestion" class="view">
      <div class="question-screen">
        <div class="q-top-bar">
          <div class="q-counter-badge" id="questionBadge">Question 1 of 20</div>
          <div class="timer-circle">
            <svg>
              <circle class="timer-bg" cx="50" cy="50" r="42"></circle>
              <circle class="timer-progress" id="timerProgressCircle" cx="50" cy="50" r="42"></circle>
            </svg>
            <div class="timer-text" id="timerDisplay">20</div>
          </div>
        </div>

        <div class="question-box">
          <h2 id="questionText">Who is more likely to...?</h2>
        </div>

        <div class="live-progress-bar-container">
          <div class="bar-labels">
            <span>Live Guest Answers</span>
            <span id="answeredRatio">0 / 0 Answered</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" id="answeredProgressFill"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. REVEAL VIEW -->
    <div id="viewReveal" class="view">
      <div class="reveal-card">
        <div class="winner-announcement">
          <div class="badge">Official Couple Answer</div>
          <h1 id="revealVerdictTitle">It's Joudy!</h1>
        </div>

        <div class="voting-bars-container">
          <!-- AUMRE -->
          <div class="candidate-card groom" id="cardAumre">
            <div class="winner-ribbon">👑 Verified</div>
            <div class="candidate-name">🤵 Aumre</div>
            <div class="candidate-role">The Groom</div>
            <div class="candidate-pct" id="pctAumre">0%</div>
            <div class="candidate-votes" id="votesAumre">0 votes</div>
          </div>

          <!-- JOUDY -->
          <div class="candidate-card bride" id="cardJoudy">
            <div class="winner-ribbon">👑 Verified</div>
            <div class="candidate-name">👰 Joudy</div>
            <div class="candidate-role">The Bride</div>
            <div class="candidate-pct" id="pctJoudy">0%</div>
            <div class="candidate-votes" id="votesJoudy">0 votes</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. LEADERBOARD VIEW -->
    <div id="viewLeaderboard" class="view">
      <div class="leaderboard-container">
        <div class="lb-header">
          <h2>🏆 Top Guests</h2>
          <p style="color: var(--text-muted);">Points awarded for speed and accuracy!</p>
        </div>
        <div class="lb-list" id="leaderboardList">
          <!-- Dynamically populated -->
        </div>
      </div>
    </div>

    <!-- 5. FINAL PODIUM VIEW -->
    <div id="viewFinal" class="view">
      <div class="podium-container">
        <h1 style="font-family: 'Cormorant Garamond', serif; font-size: 3.8rem; color: var(--gold-light);">
          ✨ Grand Winners! ✨
        </h1>
        <div class="podium-stage">
          <!-- 2nd Place -->
          <div class="podium-pillar pillar-2">
            <div class="podium-badge">🥈</div>
            <div class="podium-name" id="podium2Name">-</div>
            <div class="podium-score" id="podium2Score">0 pts</div>
          </div>
          <!-- 1st Place -->
          <div class="podium-pillar pillar-1">
            <div class="podium-badge">👑</div>
            <div class="podium-name" id="podium1Name">-</div>
            <div class="podium-score" id="podium1Score">0 pts</div>
          </div>
          <!-- 3rd Place -->
          <div class="podium-pillar pillar-3">
            <div class="podium-badge">🥉</div>
            <div class="podium-name" id="podium3Name">-</div>
            <div class="podium-score" id="podium3Score">0 pts</div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <footer>
    <div class="controls-left">
      <button class="btn-ctrl danger" onclick="confirmReset()">🔄 Reset Game</button>
      <button class="btn-ctrl" onclick="hostAction('PREV_QUESTION')">&#9664; Prev</button>
      <button class="btn-ctrl" onclick="hostAction('PAUSE_RESUME_TIMER')">⏸ Pause/Play</button>
    </div>
    <div class="controls-right">
      <button class="btn-ctrl" onclick="hostAction('REVEAL_NOW')" id="ctrlRevealBtn">⚡ Reveal Now</button>
      <button class="btn-ctrl" onclick="hostAction('SHOW_LEADERBOARD')">🏆 Leaderboard</button>
      <button class="btn-ctrl primary" onclick="hostAction('NEXT_QUESTION')" id="ctrlNextBtn">Next Question &rarr;</button>
    </div>
  </footer>

  <script>
    let ws = null;
    let soundEnabled = true;
    let audioCtx = null;
    let lastStatus = '';

    // Auto-detect URL parameter ?pin=...
    const urlParams = new URLSearchParams(window.location.search);
    let currentPin = urlParams.get('pin') || localStorage.getItem('wedding_host_pin') || '';

    // --- SYNTHESIZED AUDIO (NO EXTERNAL AUDIO FILES) ---
    function initAudio() {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
    }

    function playTone(freq, duration = 0.1, type = 'sine') {
      if (!soundEnabled) return;
      try {
        initAudio();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      } catch(e) {}
    }

    function playTick() { playTone(880, 0.05, 'triangle'); }
    function playReveal() {
      playTone(523.25, 0.2); // C5
      setTimeout(() => playTone(659.25, 0.2), 120); // E5
      setTimeout(() => playTone(783.99, 0.4), 240); // G5
      setTimeout(() => playTone(1046.50, 0.6), 360); // C6
    }
    function playFanfare() {
      const notes = [440, 554.37, 659.25, 880, 1108.73];
      notes.forEach((freq, idx) => {
        setTimeout(() => playTone(freq, 0.35, 'triangle'), idx * 150);
      });
    }

    function toggleSound() {
      soundEnabled = !soundEnabled;
      document.getElementById('soundBtn').textContent = soundEnabled ? '🔊 Sound: ON' : '🔇 Sound: OFF';
    }

    function toggleFullscreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    }

    // --- QR CODE GENERATION ---
    function setupQRCode() {
      const playerUrl = window.location.origin + '/';
      document.getElementById('qrUrlText').textContent = playerUrl;
      const qrEl = document.getElementById('qrcode');
      qrEl.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        new QRCode(qrEl, {
          text: playerUrl,
          width: 200,
          height: 200,
          colorDark: "#0f172a",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
      } else {
        // Fallback to QR Image API if CDN fails
        qrEl.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(playerUrl) + '" alt="QR Code">';
      }
    }

    // --- WEBSOCKET CONNECTION ---
    function connectWS() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host);

      ws.onopen = () => {
        if (currentPin) {
          ws.send(JSON.stringify({ type: 'HOST_AUTH', pin: currentPin }));
        } else {
          document.getElementById('pinModal').style.display = 'flex';
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch (e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        setTimeout(connectWS, 2000);
      };
    }

    function submitHostPin() {
      const pin = document.getElementById('pinInput').value.trim();
      currentPin = pin;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'HOST_AUTH', pin }));
      }
    }

    function handleServerMessage(msg) {
      if (msg.type === 'HOST_AUTH_OK') {
        localStorage.setItem('wedding_host_pin', currentPin);
        document.getElementById('pinModal').style.display = 'none';
        document.getElementById('pinError').style.display = 'none';
        setupQRCode();
        return;
      }

      if (msg.type === 'HOST_AUTH_FAIL') {
        document.getElementById('pinError').style.display = 'block';
        return;
      }

      if (msg.type === 'TIMER_TICK') {
        updateTimer(msg.timeRemaining);
        if (msg.timeRemaining <= 5 && msg.timeRemaining > 0) playTick();
        return;
      }

      if (msg.type === 'ALL_ANSWERED') {
        // Subtle cue that all active players have finished answering
        document.getElementById('ctrlRevealBtn').style.boxShadow = '0 0 20px #10b981';
        return;
      }

      if (msg.type === 'HOST_STATE_UPDATE') {
        renderHostState(msg);
      }
    }

    function switchView(viewId) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const target = document.getElementById(viewId);
      if (target) target.classList.add('active');
    }

    function updateTimer(seconds) {
      document.getElementById('timerDisplay').textContent = seconds;
      const circle = document.getElementById('timerProgressCircle');
      const maxTime = 20;
      const circumference = 264;
      const offset = circumference - ((seconds / maxTime) * circumference);
      circle.style.strokeDashoffset = offset;
      if (seconds <= 5) {
        circle.style.stroke = '#ef4444';
      } else {
        circle.style.stroke = '#d4af37';
      }
    }

    function renderHostState(data) {
      // Header & Counts
      document.getElementById('headerPlayerCount').textContent = data.totalActivePlayers + ' Guests Online';
      document.getElementById('lobbyCount').textContent = data.totalRegisteredPlayers;

      // Switch views based on status
      if (data.status !== lastStatus) {
        lastStatus = data.status;
        if (data.status === 'LOBBY') switchView('viewLobby');
        if (data.status === 'QUESTION') switchView('viewQuestion');
        if (data.status === 'REVEAL') {
          switchView('viewReveal');
          playReveal();
        }
        if (data.status === 'LEADERBOARD') switchView('viewLeaderboard');
        if (data.status === 'FINAL') {
          switchView('viewFinal');
          triggerConfetti();
          playFanfare();
        }
      }

      // 1. QUESTION VIEW
      if (data.status === 'QUESTION') {
        document.getElementById('questionBadge').textContent = 'Question ' + (data.questionIndex + 1) + ' of ' + data.totalQuestions;
        document.getElementById('questionText').textContent = data.currentQuestion ? data.currentQuestion.question : '';
        updateTimer(data.timeRemaining);

        // Progress
        const ratioText = data.answeredCount + ' / ' + data.totalActivePlayers + ' Answered';
        document.getElementById('answeredRatio').textContent = ratioText;
        const pct = data.totalActivePlayers > 0 ? (data.answeredCount / data.totalActivePlayers) * 100 : 0;
        document.getElementById('answeredProgressFill').style.width = Math.min(100, pct) + '%';
      }

      // 2. REVEAL VIEW
      if (data.status === 'REVEAL') {
        const correct = data.currentQuestion.correctAnswer;
        document.getElementById('revealVerdictTitle').textContent = "It's " + correct + '!';

        const aumreCard = document.getElementById('cardAumre');
        const joudyCard = document.getElementById('cardJoudy');

        if (correct === 'Aumre') {
          aumreCard.classList.add('is-winner');
          joudyCard.classList.remove('is-winner');
        } else {
          joudyCard.classList.add('is-winner');
          aumreCard.classList.remove('is-winner');
        }

        document.getElementById('pctAumre').textContent = data.votingStats.aumrePct + '%';
        document.getElementById('votesAumre').textContent = data.votingStats.aumreVotes + ' votes';
        document.getElementById('pctJoudy').textContent = data.votingStats.joudyPct + '%';
        document.getElementById('votesJoudy').textContent = data.votingStats.joudyVotes + ' votes';
      }

      // 3. LEADERBOARD VIEW
      if (data.status === 'LEADERBOARD') {
        const lbEl = document.getElementById('leaderboardList');
        lbEl.innerHTML = '';
        data.leaderboard.forEach((p, idx) => {
          const row = document.createElement('div');
          row.className = 'lb-row';
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx + 1);
          row.innerHTML = \`
            <div class="lb-left">
              <span class="lb-rank">\${medal}</span>
              <span class="lb-name">\${escapeHtml(p.nickname)}</span>
            </div>
            <div class="lb-score">\${p.score.toLocaleString()} pts</div>
          \`;
          lbEl.appendChild(row);
        });
      }

      // 4. FINAL PODIUM VIEW
      if (data.status === 'FINAL') {
        const top = data.leaderboard;
        if (top[0]) {
          document.getElementById('podium1Name').textContent = top[0].nickname;
          document.getElementById('podium1Score').textContent = top[0].score.toLocaleString() + ' pts';
        }
        if (top[1]) {
          document.getElementById('podium2Name').textContent = top[1].nickname;
          document.getElementById('podium2Score').textContent = top[1].score.toLocaleString() + ' pts';
        }
        if (top[2]) {
          document.getElementById('podium3Name').textContent = top[2].nickname;
          document.getElementById('podium3Score').textContent = top[2].score.toLocaleString() + ' pts';
        }
      }
    }

    function hostAction(action) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action }));
      }
    }

    function confirmReset() {
      if (confirm("Reset the wedding quiz back to lobby? All current scores will reset!")) {
        hostAction('RESET_GAME');
      }
    }

    function triggerConfetti() {
      if (typeof confetti === 'function') {
        confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 } });
        setTimeout(() => confetti({ particleCount: 150, spread: 100, origin: { y: 0.4 } }), 500);
      }
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>"']/g, function(m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
      });
    }

    // Keyboard shortcuts for Host
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (lastStatus === 'LOBBY') hostAction('START_GAME');
        else if (lastStatus === 'QUESTION') hostAction('REVEAL_NOW');
        else if (lastStatus === 'REVEAL') hostAction('SHOW_LEADERBOARD');
        else if (lastStatus === 'LEADERBOARD') hostAction('NEXT_QUESTION');
      } else if (e.code === 'KeyF') {
        toggleFullscreen();
      }
    });

    // Start
    connectWS();
  </script>
</body>
</html>`;


// ============================================================================
// FRONTEND: MOBILE PLAYER VIEW (/)
// ============================================================================
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aumre & Joudy Wedding Quiz</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#0a0d14">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,600&family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090c12;
      --card: rgba(22, 28, 44, 0.9);
      --gold: #d4af37;
      --gold-light: #fef3c7;
      --groom: #2563eb;
      --groom-glow: rgba(37, 99, 235, 0.4);
      --bride: #f43f5e;
      --bride-glow: rgba(244, 63, 94, 0.4);
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      background: #090c12;
      color: var(--text);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      min-height: 100vh;
      min-height: -webkit-fill-available;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      user-select: none;
    }

    /* Connection Status Toast */
    #connectionBanner {
      display: none;
      background: #eab308;
      color: #000;
      text-align: center;
      padding: 0.4rem;
      font-size: 0.85rem;
      font-weight: 700;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    /* Header */
    header {
      padding: 0.9rem 1.2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(14, 19, 31, 0.7);
      backdrop-filter: blur(10px);
    }
    .header-title {
      font-family: 'Cormorant Garamond', serif;
      font-size: 1.45rem;
      font-weight: 700;
      color: var(--gold-light);
    }
    .player-chip {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      padding: 0.35rem 0.8rem;
      font-size: 0.85rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .player-chip .score { color: var(--gold); }

    /* Screen Container */
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 1.2rem;
      position: relative;
    }

    .screen {
      display: none;
      flex-direction: column;
      flex: 1;
      width: 100%;
      height: 100%;
      animation: fadeIn 0.3s ease;
    }
    .screen.active { display: flex; }
    @keyframes fadeIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }

    /* 1. JOIN SCREEN */
    .join-container {
      margin: auto 0;
      background: var(--card);
      border: 1px solid rgba(212, 175, 55, 0.25);
      border-radius: 24px;
      padding: 2rem 1.5rem;
      text-align: center;
      box-shadow: 0 15px 40px rgba(0,0,0,0.6);
    }
    .join-title {
      font-family: 'Cormorant Garamond', serif;
      font-size: 2.3rem;
      color: var(--gold-light);
      margin-bottom: 0.5rem;
    }
    .join-desc {
      color: var(--text-muted);
      font-size: 0.95rem;
      margin-bottom: 1.8rem;
    }
    .name-input {
      width: 100%;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 14px;
      padding: 1rem;
      font-size: 1.25rem;
      font-weight: 700;
      color: #fff;
      text-align: center;
      outline: none;
      margin-bottom: 1.2rem;
      transition: border-color 0.2s;
    }
    .name-input:focus { border-color: var(--gold); }
    .btn-join {
      width: 100%;
      background: linear-gradient(135deg, #d4af37 0%, #a67c00 100%);
      color: #0b0f19;
      border: none;
      border-radius: 14px;
      padding: 1.05rem;
      font-size: 1.15rem;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.3);
    }

    /* 2. LOBBY WAITING SCREEN */
    .waiting-box {
      margin: auto;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.2rem;
    }
    .pulse-rings {
      font-size: 4rem;
      animation: bounce 1.6s infinite ease-in-out;
    }
    @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
    .waiting-box h2 {
      font-family: 'Cormorant Garamond', serif;
      font-size: 2.2rem;
      color: var(--gold-light);
    }
    .waiting-box p {
      color: var(--text-muted);
      max-width: 280px;
      font-size: 1rem;
      line-height: 1.4;
    }

    /* 3. QUESTION SCREEN & VOTING BUTTONS */
    .question-info {
      text-align: center;
      margin-bottom: 1.2rem;
    }
    .q-meta {
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gold);
      margin-bottom: 0.4rem;
    }
    .q-title {
      font-family: 'Cormorant Garamond', serif;
      font-size: 1.85rem;
      line-height: 1.25;
      color: #fff;
    }

    .vote-buttons-grid {
      display: flex;
      flex-direction: column;
      gap: 1.1rem;
      flex: 1;
      justify-content: center;
      margin-bottom: 1rem;
    }

    .btn-vote {
      flex: 1;
      border-radius: 20px;
      border: 2px solid transparent;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      position: relative;
      touch-action: manipulation;
      transition: transform 0.12s ease, opacity 0.2s ease, border-color 0.2s;
    }
    .btn-vote:active {
      transform: scale(0.96);
    }
    .btn-vote.groom {
      background: linear-gradient(145deg, #1d4ed8 0%, #1e3a8a 100%);
      box-shadow: 0 10px 30px var(--groom-glow);
    }
    .btn-vote.bride {
      background: linear-gradient(145deg, #e11d48 0%, #9f1239 100%);
      box-shadow: 0 10px 30px var(--bride-glow);
    }
    .btn-vote .role-tag {
      font-size: 0.95rem;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
      opacity: 0.85;
      margin-bottom: 0.3rem;
    }
    .btn-vote .name-tag {
      font-size: 2.4rem;
      font-weight: 800;
      color: #fff;
    }

    /* Selected state */
    .btn-vote.selected {
      border-color: #fff;
      box-shadow: 0 0 35px #fff;
    }
    .btn-vote.dimmed {
      opacity: 0.35;
      filter: grayscale(40%);
    }

    .vote-status-banner {
      display: none;
      text-align: center;
      padding: 0.8rem;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid #10b981;
      border-radius: 12px;
      color: #34d399;
      font-weight: 700;
      font-size: 0.95rem;
      margin-top: 0.5rem;
    }

    /* 4. REVEAL / RESULT SCREEN */
    .result-card {
      margin: auto 0;
      background: var(--card);
      border-radius: 24px;
      padding: 2.2rem 1.5rem;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.2rem;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .result-icon { font-size: 4rem; }
    .result-title {
      font-family: 'Cormorant Garamond', serif;
      font-size: 2.4rem;
      line-height: 1.1;
    }
    .result-points {
      font-size: 1.3rem;
      font-weight: 800;
      color: var(--gold);
    }
    .result-answer-info {
      font-size: 1rem;
      color: var(--text-muted);
      line-height: 1.4;
    }
    .score-summary-pill {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 0.8rem 1.5rem;
      display: flex;
      justify-content: space-between;
      width: 100%;
      font-size: 1.1rem;
      font-weight: 700;
    }

    /* 5. FINAL / PODIUM SCREEN */
    .final-card {
      margin: auto 0;
      background: var(--card);
      border: 1px solid var(--gold);
      border-radius: 24px;
      padding: 2.5rem 1.5rem;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.2rem;
      box-shadow: 0 0 40px rgba(212, 175, 55, 0.2);
    }
  </style>
</head>
<body>
  <div id="connectionBanner">Reconnecting to quiz...</div>

  <header id="appHeader" style="display: none;">
    <div class="header-title">💍 Aumre &amp; Joudy</div>
    <div class="player-chip">
      <span id="headerNick">Guest</span>
      <span class="score" id="headerScore">0 pts</span>
    </div>
  </header>

  <main>
    <!-- 1. JOIN SCREEN -->
    <div id="screenJoin" class="screen active">
      <div class="join-container">
        <h1 class="join-title">Aumre &amp; Joudy's Wedding Quiz</h1>
        <p class="join-desc">Enter your nickname to join the live game!</p>
        <input type="text" id="nicknameInput" class="name-input" placeholder="Your Name" maxlength="16" autocomplete="off" autocapitalize="words">
        <button class="btn-join" onclick="joinGame()">Join Game</button>
      </div>
    </div>

    <!-- 2. LOBBY WAITING SCREEN -->
    <div id="screenLobby" class="screen">
      <div class="waiting-box">
        <div class="pulse-rings">💍✨</div>
        <h2>You're In!</h2>
        <p>Waiting for the MC to start the quiz on the big screen...</p>
      </div>
    </div>

    <!-- 3. QUESTION SCREEN -->
    <div id="screenQuestion" class="screen">
      <div class="question-info">
        <div class="q-meta" id="playerQMeta">Question 1 of 20</div>
        <h2 class="q-title" id="playerQTitle">Who is more likely to...?</h2>
      </div>

      <div class="vote-buttons-grid">
        <button class="btn-vote groom" id="btnAumre" onclick="submitVote('Aumre')">
          <span class="role-tag">The Groom 🤵</span>
          <span class="name-tag">AUMRE</span>
        </button>

        <button class="btn-vote bride" id="btnJoudy" onclick="submitVote('Joudy')">
          <span class="role-tag">The Bride 👰</span>
          <span class="name-tag">JOUDY</span>
        </button>
      </div>

      <div class="vote-status-banner" id="voteSubmittedBanner">
        ✓ Vote Registered: <span id="votedChoiceName"></span>! Waiting for reveal...
      </div>
    </div>

    <!-- 4. REVEAL / RESULT SCREEN -->
    <div id="screenResult" class="screen">
      <div class="result-card">
        <div class="result-icon" id="resIcon">🎉</div>
        <h2 class="result-title" id="resTitle">You Got It Right!</h2>
        <div class="result-points" id="resPoints">+920 pts</div>
        <p class="result-answer-info" id="resInfo">The correct answer was Joudy.</p>
        <div class="score-summary-pill">
          <span>Your Total Score</span>
          <span id="resTotalScore" style="color: var(--gold);">0 pts</span>
        </div>
        <div class="score-summary-pill">
          <span>Current Rank</span>
          <span id="resRank">#1</span>
        </div>
      </div>
    </div>

    <!-- 5. FINAL SCREEN -->
    <div id="screenFinal" class="screen">
      <div class="final-card">
        <div style="font-size: 3.5rem;">🏆🥂</div>
        <h2 style="font-family: 'Cormorant Garamond', serif; font-size: 2.2rem; color: var(--gold-light);">Quiz Completed!</h2>
        <p style="color: var(--text-muted);">Thank you for celebrating with Aumre &amp; Joudy!</p>
        <div class="score-summary-pill">
          <span>Final Score</span>
          <span id="finalScore" style="color: var(--gold);">0 pts</span>
        </div>
        <div class="score-summary-pill">
          <span>Final Rank</span>
          <span id="finalRank">#1</span>
        </div>
      </div>
    </div>
  </main>

  <script>
    let ws = null;
    let playerId = localStorage.getItem('wedding_player_id');
    let nickname = localStorage.getItem('wedding_nickname') || '';
    let hasAnsweredCurrent = false;

    function switchScreen(screenId) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const target = document.getElementById(screenId);
      if (target) target.classList.add('active');
    }

    function initHeader(nick, score) {
      document.getElementById('appHeader').style.display = 'flex';
      document.getElementById('headerNick').textContent = nick;
      document.getElementById('headerScore').textContent = (score || 0) + ' pts';
    }

    // --- RECONNECT & WEBSOCKET ENGINE ---
    function connectWS() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host);

      ws.onopen = () => {
        document.getElementById('connectionBanner').style.display = 'none';
        // Auto rejoin if returning
        if (playerId) {
          ws.send(JSON.stringify({
            type: 'PLAYER_REJOIN',
            playerId,
            nickname
          }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch(e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        document.getElementById('connectionBanner').style.display = 'block';
        setTimeout(connectWS, 1500); // Silent robust reconnect
      };
    }

    function joinGame() {
      const input = document.getElementById('nicknameInput');
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      nickname = name;
      localStorage.setItem('wedding_nickname', name);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'PLAYER_JOIN',
          playerId,
          nickname
        }));
      }
    }

    function submitVote(choice) {
      if (hasAnsweredCurrent) return;
      hasAnsweredCurrent = true;

      // Haptic feedback
      if (navigator.vibrate) navigator.vibrate(40);

      // UI locking
      const btnA = document.getElementById('btnAumre');
      const btnJ = document.getElementById('btnJoudy');
      if (choice === 'Aumre') {
        btnA.classList.add('selected');
        btnJ.classList.add('dimmed');
      } else {
        btnJ.classList.add('selected');
        btnA.classList.add('dimmed');
      }

      document.getElementById('votedChoiceName').textContent = choice;
      document.getElementById('voteSubmittedBanner').style.display = 'block';

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'SUBMIT_ANSWER',
          answer: choice
        }));
      }
    }

    function handleServerMessage(msg) {
      if (msg.type === 'JOIN_CONFIRMED' || msg.type === 'REJOIN_CONFIRMED') {
        playerId = msg.playerId;
        nickname = msg.nickname;
        localStorage.setItem('wedding_player_id', playerId);
        initHeader(nickname, msg.score);
        return;
      }

      if (msg.type === 'REJOIN_EXPIRED') {
        localStorage.removeItem('wedding_player_id');
        playerId = null;
        switchScreen('screenJoin');
        return;
      }

      if (msg.type === 'ANSWER_ACCEPTED') {
        hasAnsweredCurrent = true;
        return;
      }

      if (msg.type === 'REVEAL_RESULT') {
        switchScreen('screenResult');
        initHeader(nickname, msg.newScore);

        const icon = document.getElementById('resIcon');
        const title = document.getElementById('resTitle');
        const pts = document.getElementById('resPoints');
        const info = document.getElementById('resInfo');

        if (msg.isCorrect) {
          icon.textContent = '🎉';
          title.textContent = 'Correct!';
          title.style.color = '#34d399';
          pts.textContent = '+' + msg.pointsEarned.toLocaleString() + ' pts';
        } else {
          icon.textContent = '😅';
          title.textContent = 'Not quite!';
          title.style.color = '#fb7185';
          pts.textContent = '+0 pts';
        }

        info.textContent = 'Verified answer was ' + msg.correctAnswer + '.';
        document.getElementById('resTotalScore').textContent = msg.newScore.toLocaleString() + ' pts';
        document.getElementById('resRank').textContent = '#' + msg.rank + ' of ' + msg.totalPlayers;
        return;
      }

      if (msg.type === 'PLAYER_STATE_UPDATE') {
        if (!playerId) return; // not joined yet
        initHeader(nickname, msg.score);

        if (msg.status === 'LOBBY') {
          switchScreen('screenLobby');
        } else if (msg.status === 'QUESTION') {
          switchScreen('screenQuestion');
          document.getElementById('playerQMeta').textContent = 'Question ' + (msg.questionIndex + 1) + ' of ' + msg.totalQuestions;
          document.getElementById('playerQTitle').textContent = msg.question;

          // Check if already answered
          const btnA = document.getElementById('btnAumre');
          const btnJ = document.getElementById('btnJoudy');
          const banner = document.getElementById('voteSubmittedBanner');

          if (msg.myAnswer) {
            hasAnsweredCurrent = true;
            if (msg.myAnswer === 'Aumre') {
              btnA.classList.add('selected');
              btnJ.classList.add('dimmed');
            } else {
              btnJ.classList.add('selected');
              btnA.classList.add('dimmed');
            }
            document.getElementById('votedChoiceName').textContent = msg.myAnswer;
            banner.style.display = 'block';
          } else {
            hasAnsweredCurrent = false;
            btnA.classList.remove('selected', 'dimmed');
            btnJ.classList.remove('selected', 'dimmed');
            banner.style.display = 'none';
          }
        } else if (msg.status === 'FINAL') {
          switchScreen('screenFinal');
          document.getElementById('finalScore').textContent = (msg.score || 0).toLocaleString() + ' pts';
          document.getElementById('finalRank').textContent = '#' + (msg.rank || 1) + ' of ' + (msg.totalPlayers || 1);
        }
      }
    }

    // Auto-focus input on open
    window.addEventListener('DOMContentLoaded', () => {
      if (nickname && !playerId) {
        document.getElementById('nicknameInput').value = nickname;
      }
      connectWS();
    });
  </script>
</body>
</html>`;
