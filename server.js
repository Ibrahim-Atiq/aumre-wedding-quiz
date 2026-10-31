/**
 * ============================================================================
 * ALL-IN-ONE MULTIPLAYER WEDDING QUIZ: "HOW WELL DO YOU KNOW AUMRE & JOUDY?"
 * ============================================================================
 * 
 * Production-ready single-file Node.js app for 50-100+ concurrent players.
 * Designed for free-tier Render deployment (single port, zero database,
 * 20s WebSocket heartbeat, resilient mobile reconnects).
 *
 * Wedding Stationery Theme inspired by Aumre & Joudy's Seating Plan & Program:
 * - Luxury warm ivory / cream linen palette (#fbf8f2)
 * - Deep forest pine / botanical slate typography (#182f28)
 * - Warm gold foil accents (#b88d43, #c59b4e)
 * - Fine double hairline framing and diamond ornaments (◆)
 * - Automated game progression with host pause/resume controls
 * - Flexible host navigation (never get stuck between Question, Reveal & Leaderboard)
 * - Guest manager (live lobby list with kick capability)
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const HOST_PIN = process.env.HOST_PIN || "1234";

// Timing settings (seconds)
const QUESTION_TIMER_SECONDS = 20;
const REVEAL_TIMER_SECONDS = 8;
const LEADERBOARD_TIMER_SECONDS = 7;
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
  maxTime: QUESTION_TIMER_SECONDS,
  isPaused: false,
  autoFlow: true, // Auto progression enabled by default
  questionStartTime: null,
  totalPausedDuration: 0,
  pausedAt: null,
  lastRevealStats: null,
  answers: {} // playerId -> { answer: 'Aumre' | 'Joudy', timestamp: number, pointsEarned: number }
};

let timerInterval = null;

// --- TIMER & AUTOMATIC FLOW ENGINE ---
function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startPhaseTimer(seconds, onExpire) {
  stopTimer();
  gameState.timeRemaining = seconds;
  gameState.maxTime = seconds;
  broadcastTimerTick();

  timerInterval = setInterval(() => {
    if (gameState.isPaused) return; // Do not decrement while paused

    gameState.timeRemaining -= 1;
    if (gameState.timeRemaining <= 0) {
      stopTimer();
      gameState.timeRemaining = 0;
      broadcastTimerTick();
      if (gameState.autoFlow && onExpire) {
        onExpire();
      }
    } else {
      broadcastTimerTick();
    }
  }, 1000);
}

function launchQuestion(qIndex) {
  stopTimer();
  gameState.status = 'QUESTION';
  gameState.questionIndex = qIndex;
  gameState.answers = {};
  gameState.questionStartTime = Date.now();
  gameState.totalPausedDuration = 0;
  gameState.pausedAt = null;
  gameState.isPaused = false;

  broadcastGameState();

  // 20s question timer -> auto transitions to REVEAL
  startPhaseTimer(QUESTION_TIMER_SECONDS, () => {
    launchReveal();
  });
}

function launchReveal() {
  stopTimer();
  gameState.status = 'REVEAL';
  gameState.isPaused = false;
  gameState.pausedAt = null;

  const currentQ = QUESTIONS[gameState.questionIndex];
  const correct = currentQ.correctAnswer;

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

  const revealStats = {
    questionIndex: gameState.questionIndex,
    correctAnswer: correct,
    aumreVotes,
    joudyVotes,
    aumrePct,
    joudyPct,
    totalVotes
  };
  gameState.lastRevealStats = revealStats;

  broadcastReveal(revealStats);

  // 8s reveal timer -> auto transitions to LEADERBOARD
  startPhaseTimer(REVEAL_TIMER_SECONDS, () => {
    launchLeaderboard();
  });
}

function launchLeaderboard() {
  stopTimer();
  gameState.status = 'LEADERBOARD';
  gameState.isPaused = false;
  gameState.pausedAt = null;
  broadcastGameState();

  // 7s leaderboard timer -> auto transitions to NEXT QUESTION or FINAL
  startPhaseTimer(LEADERBOARD_TIMER_SECONDS, () => {
    if (gameState.questionIndex + 1 < QUESTIONS.length) {
      launchQuestion(gameState.questionIndex + 1);
    } else {
      launchFinal();
    }
  });
}

function launchFinal() {
  stopTimer();
  gameState.status = 'FINAL';
  gameState.isPaused = false;
  gameState.pausedAt = null;
  broadcastGameState();
}

// --- LEADERBOARD & STATS HELPERS ---
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

function getGuestList() {
  return Array.from(players.values()).map(p => ({
    id: p.id,
    nickname: p.nickname,
    score: p.score || 0,
    connected: p.connected,
    hasAnswered: !!gameState.answers[p.id]
  })).sort((a, b) => a.nickname.localeCompare(b.nickname));
}

function getHostStatePayload() {
  const currentQ = QUESTIONS[gameState.questionIndex] || null;
  const answeredCount = Object.keys(gameState.answers).length;
  const totalActivePlayers = Array.from(players.values()).filter(p => p.connected).length;
  const leaderboard = getLeaderboard(10);
  const guestList = getGuestList();

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
    maxTime: gameState.maxTime,
    isPaused: gameState.isPaused,
    autoFlow: gameState.autoFlow,
    answeredCount,
    totalActivePlayers,
    totalRegisteredPlayers: players.size,
    leaderboard: leaderboard.top,
    guestList,
    votingStats: {
      aumreVotes,
      joudyVotes,
      totalVotes,
      aumrePct: totalVotes > 0 ? Math.round((aumreVotes / totalVotes) * 100) : 0,
      joudyPct: totalVotes > 0 ? (100 - Math.round((aumreVotes / totalVotes) * 100)) : 0
    }
  };
}

function broadcastTimerTick() {
  const payload = JSON.stringify({
    type: 'TIMER_TICK',
    status: gameState.status,
    timeRemaining: gameState.timeRemaining,
    maxTime: gameState.maxTime,
    isPaused: gameState.isPaused
  });
  hostSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch (e) {}
    }
  });
}

function broadcastGameState() {
  const hostPayload = JSON.stringify(getHostStatePayload());
  hostSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(hostPayload); } catch (e) {}
    }
  });

  const currentQ = QUESTIONS[gameState.questionIndex];
  const leaderboard = getLeaderboard(players.size);

  players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      const answerRecord = gameState.answers[p.id];
      const myAnswer = answerRecord ? answerRecord.answer : null;
      const pointsEarned = answerRecord ? answerRecord.pointsEarned : 0;
      const myRank = leaderboard.rankings.findIndex(item => item.id === p.id) + 1;

      try {
        p.ws.send(JSON.stringify({
          type: 'PLAYER_STATE_UPDATE',
          status: gameState.status,
          questionIndex: gameState.questionIndex,
          totalQuestions: QUESTIONS.length,
          question: currentQ ? currentQ.question : '',
          timeRemaining: gameState.timeRemaining,
          maxTime: gameState.maxTime,
          isPaused: gameState.isPaused,
          score: p.score,
          myAnswer,
          pointsEarned,
          rank: myRank || 1,
          totalPlayers: leaderboard.totalPlayers,
          lastRevealStats: gameState.lastRevealStats || null
        }));
      } catch (e) {}
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
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(hostPayload); } catch (e) {}
    }
  });

  const leaderboard = getLeaderboard(players.size);

  players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      const answerRecord = gameState.answers[p.id];
      const myAnswer = answerRecord ? answerRecord.answer : null;
      const isCorrect = myAnswer === stats.correctAnswer;
      const pointsEarned = answerRecord ? answerRecord.pointsEarned : 0;
      const myRank = leaderboard.rankings.findIndex(item => item.id === p.id) + 1;

      try {
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
      } catch (e) {}
    }
  });
}

// --- EXPRESS APP SETUP ---
const app = express();
app.use(express.json());

app.get('/host', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HOST_HTML);
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PLAYER_HTML);
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', players: players.size });
});

// --- HTTP & WEBSOCKET SERVER ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('error', (err) => {
  console.error('WebSocketServer error:', err && err.message);
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('error', (err) => {
    console.error('WS client error:', err && err.message);
  });
  ws.on('pong', () => { ws.isAlive = true; });

  let clientType = 'UNKNOWN';
  let attachedPlayerId = null;

  ws.on('message', (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw);

      // --- HOST AUTH & ACTIONS ---
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

      // --- PLAYER JOIN & ACTIONS ---
      if (msg.type === 'PLAYER_JOIN') {
        const nickname = (msg.nickname || '').trim().slice(0, 18) || 'Guest';
        let pId = msg.playerId;

        if (pId && players.has(pId)) {
          const existing = players.get(pId);
          const oldWs = existing.ws;
          existing.ws = ws;
          existing.connected = true;
          existing.nickname = nickname || existing.nickname;
          attachedPlayerId = pId;
          if (oldWs && oldWs !== ws) {
            try { oldWs.terminate(); } catch (e) {}
          }
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
          const oldWs = p.ws;
          p.ws = ws;
          p.connected = true;
          attachedPlayerId = pId;
          clientType = 'PLAYER';
          if (oldWs && oldWs !== ws) {
            try { oldWs.terminate(); } catch (e) {}
          }

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
        if (gameState.isPaused) {
          ws.send(JSON.stringify({
            type: 'ANSWER_REJECTED_PAUSED',
            message: 'Game is currently paused by the host'
          }));
          return;
        }
        if (gameState.answers[attachedPlayerId]) return;

        const chosen = msg.answer;
        if (chosen !== 'Aumre' && chosen !== 'Joudy') return;

        const currentQ = QUESTIONS[gameState.questionIndex];
        const isCorrect = chosen === currentQ.correctAnswer;

        let points = 0;
        if (isCorrect) {
          const pausedTime = gameState.totalPausedDuration || 0;
          const effectiveElapsedMs = Math.max(0, (Date.now() - (gameState.questionStartTime || Date.now())) - pausedTime);
          const elapsedSec = effectiveElapsedMs / 1000;
          const speedFactor = Math.max(0, 1 - (elapsedSec / QUESTION_TIMER_SECONDS));
          points = Math.round(500 + (500 * speedFactor));
        }

        const p = players.get(attachedPlayerId);
        if (p) p.score = (p.score || 0) + points;

        gameState.answers[attachedPlayerId] = {
          answer: chosen,
          timestamp: Date.now(),
          pointsEarned: points
        };

        ws.send(JSON.stringify({
          type: 'ANSWER_ACCEPTED',
          answer: chosen,
          questionIndex: gameState.questionIndex
        }));

        // Send updated state to host
        const hostPayload = JSON.stringify(getHostStatePayload());
        hostSockets.forEach(h => {
          if (h.readyState === WebSocket.OPEN) {
            try { h.send(hostPayload); } catch (e) {}
          }
        });

        // Quorum-based auto-reveal: only if all registered answered, or >= 75% registered answered AND all connected answered
        const totalReg = players.size;
        const connectedPlayers = Array.from(players.values()).filter(pl => pl.connected);
        const ansCount = Object.keys(gameState.answers).length;

        const allRegisteredAnswered = totalReg > 0 && ansCount >= totalReg;
        const allConnectedAnswered = connectedPlayers.length > 0 && connectedPlayers.every(pl => !!gameState.answers[pl.id]);
        const quorumMet = totalReg > 0 && (ansCount / totalReg >= 0.75) && allConnectedAnswered;

        if ((allRegisteredAnswered || quorumMet) && gameState.autoFlow && !gameState.isPaused) {
          launchReveal();
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
      // Only null out if this closing socket is the player's active socket
      if (p.ws === ws) {
        p.connected = false;
        p.ws = null;
        const hostPayload = JSON.stringify(getHostStatePayload());
        hostSockets.forEach(h => {
          if (h.readyState === WebSocket.OPEN) {
            try { h.send(hostPayload); } catch (e) {}
          }
        });
      }
    }
  });
});

// --- HOST ACTION CONTROLLER ---
function handleHostAction(msg) {
  switch (msg.action) {
    case 'START_GAME':
      gameState.isPaused = false;
      launchQuestion(0);
      break;

    case 'REVEAL_NOW':
      // Move immediately to reveal
      launchReveal();
      break;

    case 'BACK_TO_QUESTION':
      // Return to question view, stop timer, and pause
      stopTimer();
      gameState.status = 'QUESTION';
      gameState.isPaused = true;
      gameState.pausedAt = Date.now();
      if (gameState.timeRemaining <= 0) {
        gameState.timeRemaining = QUESTION_TIMER_SECONDS;
        gameState.maxTime = QUESTION_TIMER_SECONDS;
      }
      broadcastGameState();
      break;

    case 'SHOW_LEADERBOARD':
      launchLeaderboard();
      break;

    case 'NEXT_QUESTION':
      if (gameState.status === 'LOBBY') {
        gameState.isPaused = false;
        launchQuestion(0);
      } else if (gameState.questionIndex + 1 < QUESTIONS.length) {
        launchQuestion(gameState.questionIndex + 1);
      } else {
        launchFinal();
      }
      break;

    case 'PREV_QUESTION':
      if (gameState.status === 'FINAL') {
        launchQuestion(QUESTIONS.length - 1);
      } else if (gameState.questionIndex > 0) {
        launchQuestion(gameState.questionIndex - 1);
      }
      break;

    case 'TOGGLE_PAUSE':
      if (!gameState.isPaused) {
        gameState.isPaused = true;
        gameState.pausedAt = Date.now();
      } else {
        gameState.isPaused = false;
        if (gameState.pausedAt) {
          gameState.totalPausedDuration = (gameState.totalPausedDuration || 0) + (Date.now() - gameState.pausedAt);
          gameState.pausedAt = null;
        }
        if (!timerInterval) {
          if (gameState.status === 'QUESTION') {
            const rem = gameState.timeRemaining > 0 ? gameState.timeRemaining : QUESTION_TIMER_SECONDS;
            startPhaseTimer(rem, () => { launchReveal(); });
          } else if (gameState.status === 'REVEAL') {
            const rem = gameState.timeRemaining > 0 ? gameState.timeRemaining : REVEAL_TIMER_SECONDS;
            startPhaseTimer(rem, () => { launchLeaderboard(); });
          } else if (gameState.status === 'LEADERBOARD') {
            const rem = gameState.timeRemaining > 0 ? gameState.timeRemaining : LEADERBOARD_TIMER_SECONDS;
            startPhaseTimer(rem, () => {
              if (gameState.questionIndex + 1 < QUESTIONS.length) {
                launchQuestion(gameState.questionIndex + 1);
              } else {
                launchFinal();
              }
            });
          }
        }
      }
      broadcastTimerTick();
      broadcastGameState();
      break;

    case 'RESET_GAME':
      stopTimer();
      gameState.status = 'LOBBY';
      gameState.questionIndex = 0;
      gameState.answers = {};
      gameState.isPaused = false;
      gameState.totalPausedDuration = 0;
      gameState.pausedAt = null;
      gameState.lastRevealStats = null;
      players.forEach(p => { p.score = 0; });
      broadcastGameState();
      break;

    case 'KICK_PLAYER':
      const targetId = msg.playerId;
      if (targetId && players.has(targetId)) {
        const target = players.get(targetId);
        if (target.ws && target.ws.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ type: 'KICKED', reason: 'Removed by host' }));
            target.ws.close();
          } catch(e) {}
        }
        delete gameState.answers[targetId];
        players.delete(targetId);
        broadcastGameState();
      }
      break;
  }
}

// --- RENDER FREE-TIER WEBSOCKET KEEPALIVE HEARTBEAT ---
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => { clearInterval(heartbeat); });

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
// Wedding Stationery Theme (Ivory Linen, Double Gold Hairlines, Pine Typography)
// ============================================================================
const HOST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Host Screen | Aumre & Joudy Wedding Quiz</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    :root {
      --bg-linen: #fbf8f2;
      --bg-card: #ffffff;
      --pine: #182f28;
      --pine-light: #2c493f;
      --text-muted: #5e6f66;
      --gold: #b88d43;
      --gold-light: #d8b773;
      --gold-subtle: #eedebc;
      --gold-border: rgba(184, 141, 67, 0.45);
      --groom-green: #17332c;
      --bride-rose: #7d2a3e;
      --shadow-stationery: 0 10px 35px rgba(24, 47, 40, 0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-linen);
      color: var(--pine);
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    /* Subtle luxury wedding stationery framing around entire screen */
    .stationery-frame {
      position: fixed;
      top: 10px; bottom: 10px; left: 10px; right: 10px;
      border: 1px solid var(--gold-border);
      outline: 1px solid rgba(184, 141, 67, 0.2);
      outline-offset: -5px;
      pointer-events: none;
      z-index: 100;
    }

    /* HEADER */
    header {
      padding: 1.2rem 3rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--gold-subtle);
      background: rgba(251, 248, 242, 0.95);
      backdrop-filter: blur(8px);
      z-index: 10;
    }
    .header-branding {
      display: flex;
      flex-direction: column;
    }
    .header-super {
      font-family: 'Cinzel', serif;
      font-size: 0.72rem;
      letter-spacing: 3px;
      color: var(--gold);
      text-transform: uppercase;
    }
    .header-title {
      font-family: 'Playfair Display', serif;
      font-size: 1.9rem;
      font-weight: 600;
      color: var(--pine);
      font-style: italic;
    }
    .header-title span {
      font-style: normal;
      color: var(--gold);
      font-family: 'Cinzel', serif;
      font-size: 1.4rem;
      margin: 0 0.3rem;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .pill-btn {
      background: #fff;
      border: 1px solid var(--gold-border);
      color: var(--pine);
      padding: 0.5rem 1.1rem;
      border-radius: 4px;
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      box-shadow: 0 2px 8px rgba(0,0,0,0.03);
      transition: all 0.2s;
    }
    .pill-btn:hover {
      border-color: var(--gold);
      background: #faf6ee;
    }
    .dot-live {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #10b981;
    }

    /* AUTO PROGRESS BAR */
    .flow-indicator {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.4rem 3rem;
      background: #f4ecdc;
      font-size: 0.82rem;
      color: var(--pine);
      font-weight: 600;
      border-bottom: 1px solid var(--gold-subtle);
    }
    .flow-bar {
      flex: 1;
      height: 4px;
      background: rgba(184, 141, 67, 0.2);
      margin: 0 1.5rem;
      border-radius: 2px;
      overflow: hidden;
    }
    .flow-bar-inner {
      height: 100%;
      background: var(--gold);
      width: 100%;
      transition: width 1s linear;
    }

    /* MAIN CONTAINER */
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 3.5rem;
      max-width: 1300px;
      margin: 0 auto;
      width: 100%;
      z-index: 10;
    }

    .view { display: none; width: 100%; }
    .view.active { display: flex; flex-direction: column; align-items: center; justify-content: center; }

    /* CARD STYLING (MATCHES INVITATION & SEATING PLAN) */
    .stationery-card {
      background: var(--bg-card);
      border: 1px solid var(--gold-border);
      box-shadow: inset 0 0 0 3px #fbf8f2, inset 0 0 0 4px var(--gold-border), var(--shadow-stationery);
      border-radius: 4px;
      padding: 3.5rem;
      width: 100%;
      position: relative;
    }

    .card-ornament {
      text-align: center;
      color: var(--gold);
      font-size: 0.9rem;
      letter-spacing: 5px;
      margin-bottom: 0.8rem;
    }

    /* 1. LOBBY VIEW */
    .lobby-layout {
      display: grid;
      grid-template-columns: 1fr 1.3fr;
      gap: 3.5rem;
      align-items: center;
    }
    .qr-box {
      background: #fbf9f4;
      border: 1px solid var(--gold-border);
      padding: 2rem;
      text-align: center;
      border-radius: 4px;
    }
    #qrcode {
      display: inline-block;
      padding: 10px;
      background: white;
      border: 1px solid var(--gold-subtle);
      margin-bottom: 1.2rem;
    }
    #qrcode img { display: block; margin: 0 auto; }
    .qr-caption {
      font-family: 'Cinzel', serif;
      font-size: 1rem;
      letter-spacing: 1.5px;
      color: var(--pine);
      font-weight: 700;
    }
    .qr-url {
      font-family: monospace;
      font-size: 0.9rem;
      color: var(--gold);
      margin-top: 0.4rem;
    }

    .lobby-details h1 {
      font-family: 'Playfair Display', serif;
      font-size: 3.2rem;
      line-height: 1.15;
      color: var(--pine);
      margin-bottom: 1rem;
      font-style: italic;
    }
    .lobby-details p {
      font-size: 1.15rem;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .guest-stat-box {
      display: flex;
      align-items: baseline;
      gap: 1rem;
      margin-bottom: 2.2rem;
    }
    .guest-stat-num {
      font-size: 4rem;
      font-weight: 700;
      color: var(--gold);
      font-family: 'Playfair Display', serif;
    }
    .guest-stat-label {
      font-family: 'Cinzel', serif;
      font-size: 1.1rem;
      letter-spacing: 1px;
      color: var(--pine);
    }
    .btn-gold-primary {
      background: var(--gold);
      color: #fff;
      border: 1px solid #9c732e;
      padding: 1rem 2.5rem;
      font-family: 'Cinzel', serif;
      font-size: 1.1rem;
      letter-spacing: 2px;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(184, 141, 67, 0.3);
      transition: all 0.2s;
    }
    .btn-gold-primary:hover {
      background: #a47b34;
      transform: translateY(-1px);
    }

    /* 2. QUESTION VIEW */
    .question-card-inner {
      text-align: center;
      max-width: 900px;
      margin: 0 auto;
    }
    .q-top-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--gold-subtle);
      padding-bottom: 1rem;
    }
    .q-counter-tag {
      font-family: 'Cinzel', serif;
      font-size: 0.95rem;
      letter-spacing: 2px;
      color: var(--gold);
      text-transform: uppercase;
    }
    .q-timer-badge {
      font-family: 'Playfair Display', serif;
      font-size: 1.8rem;
      color: var(--pine);
      font-weight: 700;
    }
    .question-statement {
      font-family: 'Playfair Display', serif;
      font-size: 3.4rem;
      line-height: 1.25;
      color: var(--pine);
      margin: 2.5rem 0;
      font-style: italic;
    }
    .live-voted-strip {
      background: #fbf9f4;
      border: 1px solid var(--gold-subtle);
      padding: 1rem 1.5rem;
      border-radius: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      color: var(--text-muted);
    }
    .voted-progress-track {
      flex: 1;
      height: 8px;
      background: #eee3cc;
      margin: 0 1.5rem;
      border-radius: 4px;
      overflow: hidden;
    }
    .voted-progress-fill {
      height: 100%;
      background: var(--pine);
      width: 0%;
      transition: width 0.3s ease;
    }

    /* 3. REVEAL VIEW */
    .reveal-header {
      text-align: center;
      margin-bottom: 2.5rem;
    }
    .official-answer-badge {
      font-family: 'Cinzel', serif;
      font-size: 0.85rem;
      letter-spacing: 3px;
      color: var(--gold);
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    .reveal-title {
      font-family: 'Playfair Display', serif;
      font-size: 3.6rem;
      color: var(--pine);
      font-style: italic;
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2.5rem;
    }
    .person-result-box {
      border: 1px solid var(--gold-border);
      padding: 2.5rem;
      text-align: center;
      background: #fcfaf6;
      border-radius: 4px;
      position: relative;
    }
    .person-result-box.is-official {
      background: #f7f1e4;
      border-color: var(--gold);
      box-shadow: inset 0 0 0 2px var(--gold);
    }
    .official-crown {
      display: none;
      position: absolute;
      top: 12px; right: 12px;
      font-family: 'Cinzel', serif;
      font-size: 0.75rem;
      letter-spacing: 1.5px;
      background: var(--gold);
      color: #fff;
      padding: 0.25rem 0.75rem;
      border-radius: 2px;
    }
    .person-result-box.is-official .official-crown { display: block; }
    .person-role {
      font-family: 'Cinzel', serif;
      font-size: 0.85rem;
      letter-spacing: 2px;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 0.3rem;
    }
    .person-name {
      font-family: 'Playfair Display', serif;
      font-size: 2.5rem;
      color: var(--pine);
      margin-bottom: 1rem;
    }
    .person-pct {
      font-size: 4.5rem;
      font-weight: 700;
      color: var(--pine);
      line-height: 1;
      margin-bottom: 0.5rem;
      font-family: 'Playfair Display', serif;
    }
    .person-votes {
      font-size: 1.05rem;
      color: var(--text-muted);
    }

    /* 4. LEADERBOARD VIEW */
    .lb-wrapper {
      max-width: 820px;
      margin: 0 auto;
    }
    .lb-header-box {
      text-align: center;
      margin-bottom: 2rem;
    }
    .lb-header-box h2 {
      font-family: 'Playfair Display', serif;
      font-size: 2.8rem;
      color: var(--pine);
      font-style: italic;
    }
    .lb-table {
      display: flex;
      flex-direction: column;
      gap: 0.7rem;
    }
    .lb-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.9rem 1.6rem;
      background: #fcfaf6;
      border: 1px solid var(--gold-subtle);
      border-radius: 4px;
      font-size: 1.15rem;
      font-weight: 600;
    }
    .lb-item:nth-child(1) {
      background: #f7efe0;
      border-color: var(--gold);
    }
    .lb-item-rank {
      font-family: 'Cinzel', serif;
      width: 35px;
      color: var(--gold);
      font-weight: 700;
    }
    .lb-item-name {
      color: var(--pine);
      flex: 1;
      padding-left: 0.5rem;
    }
    .lb-item-score {
      font-family: 'Playfair Display', serif;
      font-size: 1.3rem;
      color: var(--pine);
      font-weight: 700;
    }

    /* 5. FINAL PODIUM VIEW */
    .podium-screen-inner {
      text-align: center;
    }
    .podium-stage-row {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      gap: 1.5rem;
      margin-top: 2rem;
    }
    .podium-col {
      flex: 1;
      max-width: 250px;
      background: #fcfaf6;
      border: 1px solid var(--gold-border);
      border-radius: 4px 4px 0 0;
      padding: 1.5rem 1rem;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .podium-1 {
      height: 360px;
      background: #f7efe0;
      border-color: var(--gold);
      box-shadow: inset 0 0 0 2px var(--gold);
    }
    .podium-2 { height: 280px; }
    .podium-3 { height: 220px; }
    .podium-medal { font-size: 2.5rem; margin-bottom: 0.5rem; }
    .podium-guest-name {
      font-family: 'Playfair Display', serif;
      font-size: 1.5rem;
      color: var(--pine);
      font-weight: 700;
    }
    .podium-guest-score {
      font-size: 1.15rem;
      color: var(--gold);
      font-weight: 600;
      margin-top: 0.4rem;
    }

    /* HOST CONTROLS BAR (ALWAYS ACCESSIBLE, NEVER GET STUCK) */
    footer {
      padding: 0.9rem 3rem;
      background: #fff;
      border-top: 1px solid var(--gold-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 10;
    }
    .ctrl-group {
      display: flex;
      gap: 0.6rem;
      align-items: center;
    }
    .btn-toolbar {
      background: #fbf8f2;
      border: 1px solid var(--gold-border);
      color: var(--pine);
      padding: 0.55rem 1rem;
      border-radius: 3px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.15s;
    }
    .btn-toolbar:hover {
      background: #f4ecdc;
      border-color: var(--gold);
    }
    .btn-toolbar.active-state {
      background: var(--pine);
      color: #fff;
      border-color: var(--pine);
    }
    .btn-toolbar.gold {
      background: var(--gold);
      color: #fff;
      border-color: #9c732e;
    }

    /* GUESTS MANAGER DRAWER / MODAL */
    .drawer-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(24, 47, 40, 0.4);
      backdrop-filter: blur(4px);
      z-index: 200;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .drawer-content {
      background: #fff;
      border: 1px solid var(--gold);
      box-shadow: var(--shadow-stationery);
      border-radius: 4px;
      padding: 2.5rem;
      width: 100%;
      max-width: 580px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
    }
    .drawer-title {
      font-family: 'Playfair Display', serif;
      font-size: 1.8rem;
      color: var(--pine);
      margin-bottom: 0.3rem;
      font-style: italic;
    }
    .guest-list-scroll {
      flex: 1;
      overflow-y: auto;
      margin: 1.2rem 0;
      border: 1px solid var(--gold-subtle);
      border-radius: 4px;
    }
    .guest-list-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.2rem;
      border-bottom: 1px solid #f4ecdc;
    }
    .guest-list-row:last-child { border-bottom: none; }
    .btn-kick {
      background: #fff0f0;
      color: #b91c1c;
      border: 1px solid #fca5a5;
      padding: 0.3rem 0.7rem;
      border-radius: 3px;
      font-size: 0.78rem;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-kick:hover { background: #fee2e2; }

    /* AUTH PIN MODAL */
    #pinModal {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(24, 47, 40, 0.6);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 300;
    }
    .pin-card {
      background: #fff;
      border: 1px solid var(--gold);
      padding: 3rem;
      text-align: center;
      max-width: 420px;
      border-radius: 4px;
      box-shadow: var(--shadow-stationery);
    }
  </style>
</head>
<body>
  <div class="stationery-frame"></div>

  <!-- PIN AUTH MODAL -->
  <div id="pinModal">
    <div class="pin-card">
      <div class="card-ornament">◆ ✦ ◆</div>
      <h2 style="font-family: 'Playfair Display', serif; font-size: 2.2rem; margin-bottom: 0.5rem; font-style: italic;">Host Access</h2>
      <p style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 1.5rem;">Enter Host PIN to manage the wedding quiz</p>
      <form onsubmit="event.preventDefault(); submitHostPin();">
        <input type="password" id="pinInput" style="width: 100%; border: 1px solid var(--gold-border); padding: 0.8rem; font-size: 1.6rem; text-align: center; letter-spacing: 5px; outline: none; margin-bottom: 1.5rem;" placeholder="••••" autofocus>
        <button type="submit" class="btn-gold-primary" style="width: 100%;">Unlock Host</button>
      </form>
      <div id="pinError" style="color: #b91c1c; font-size: 0.9rem; font-weight: 600; margin-top: 1rem; display: none;">Invalid PIN</div>
    </div>
  </div>

  <!-- GUEST MANAGER DRAWER -->
  <div id="drawerGuests" class="drawer-overlay" onclick="closeGuestDrawer(event)">
    <div class="drawer-content" onclick="event.stopPropagation()">
      <div class="card-ornament">◆ ✦ ◆</div>
      <h2 class="drawer-title">Joined Guests</h2>
      <p style="color: var(--text-muted); font-size: 0.9rem;">Review registered players or remove inappropriate entries</p>
      <div class="guest-list-scroll" id="guestListContainer">
        <!-- Dynamically rendered -->
      </div>
      <button class="pill-btn" style="justify-content: center;" onclick="closeGuestDrawer()">Close</button>
    </div>
  </div>

  <!-- HEADER -->
  <header>
    <div class="header-branding">
      <span class="header-super">Welcome to the Wedding of</span>
      <h1 class="header-title">Aumre <span>&amp;</span> Joudy</h1>
    </div>
    <div class="header-actions">
      <button class="pill-btn" onclick="openGuestDrawer()">
        <span class="dot-live"></span>
        <span id="headerPlayerCount">0 Guests</span>
      </button>
      <button class="pill-btn" id="soundBtn" onclick="toggleSound()">🔊 Sound: ON</button>
      <button class="pill-btn" onclick="toggleFullscreen()">⛶ Fullscreen</button>
    </div>
  </header>

  <!-- AUTO-FLOW INDICATOR BAR -->
  <div class="flow-indicator">
    <span id="flowPhaseLabel">LOBBY</span>
    <div class="flow-bar">
      <div class="flow-bar-inner" id="flowBarProgress"></div>
    </div>
    <span id="flowTimerNumber">Ready</span>
  </div>

  <!-- MAIN VIEWS -->
  <main>
    <!-- 1. LOBBY VIEW -->
    <div id="viewLobby" class="view active">
      <div class="stationery-card lobby-layout">
        <div class="qr-box">
          <div id="qrcode"></div>
          <div class="qr-caption">Scan with Phone to Join</div>
          <div class="qr-url" id="qrUrlText">Loading...</div>
        </div>
        <div class="lobby-details">
          <div class="card-ornament" style="text-align: left;">◆ ✦ ◆</div>
          <h1>How Well Do You Know Aumre &amp; Joudy?</h1>
          <p>Scan the QR code on your mobile device, enter your name, and answer each question for points!</p>
          <div class="guest-stat-box">
            <span class="guest-stat-num" id="lobbyCount">0</span>
            <span class="guest-stat-label">Guests in Lobby</span>
          </div>
          <button class="btn-gold-primary" onclick="hostAction('START_GAME')">Start Quiz &rarr;</button>
        </div>
      </div>
    </div>

    <!-- 2. QUESTION VIEW -->
    <div id="viewQuestion" class="view">
      <div class="stationery-card question-card-inner">
        <div class="card-ornament">◆ ✦ ◆</div>
        <div class="q-top-meta">
          <span class="q-counter-tag" id="questionBadge">Question 1 of 20</span>
          <span class="q-timer-badge" id="questionTimer">20s</span>
        </div>
        <h2 class="question-statement" id="questionText">Who is more likely to...?</h2>
        <div class="live-voted-strip">
          <span>Live Responses</span>
          <div class="voted-progress-track">
            <div class="voted-progress-fill" id="answeredProgressFill"></div>
          </div>
          <span id="answeredRatio">0 / 0 Answered</span>
        </div>
      </div>
    </div>

    <!-- 3. REVEAL VIEW -->
    <div id="viewReveal" class="view">
      <div class="stationery-card" style="max-width: 950px; margin: 0 auto;">
        <div class="card-ornament">◆ ✦ ◆</div>
        <div class="reveal-header">
          <div class="official-answer-badge">Official Answer</div>
          <h2 class="reveal-title" id="revealTitle">It's Joudy!</h2>
        </div>
        <div class="comparison-grid">
          <!-- Aumre -->
          <div class="person-result-box" id="cardAumre">
            <div class="official-crown">👑 Official Answer</div>
            <div class="person-role">The Groom 🤵</div>
            <div class="person-name">Aumre</div>
            <div class="person-pct" id="pctAumre">0%</div>
            <div class="person-votes" id="votesAumre">0 votes</div>
          </div>
          <!-- Joudy -->
          <div class="person-result-box" id="cardJoudy">
            <div class="official-crown">👑 Official Answer</div>
            <div class="person-role">The Bride 👰</div>
            <div class="person-name">Joudy</div>
            <div class="person-pct" id="pctJoudy">0%</div>
            <div class="person-votes" id="votesJoudy">0 votes</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. LEADERBOARD VIEW -->
    <div id="viewLeaderboard" class="view">
      <div class="stationery-card lb-wrapper">
        <div class="card-ornament">◆ ✦ ◆</div>
        <div class="lb-header-box">
          <div class="official-answer-badge">Wedding Standings</div>
          <h2>Top Guests</h2>
        </div>
        <div class="lb-table" id="leaderboardList">
          <!-- Dynamically populated -->
        </div>
      </div>
    </div>

    <!-- 5. FINAL PODIUM VIEW -->
    <div id="viewFinal" class="view">
      <div class="stationery-card podium-screen-inner" style="max-width: 900px; margin: 0 auto;">
        <div class="card-ornament">◆ ✦ ◆</div>
        <div class="official-answer-badge">Congratulations</div>
        <h2 style="font-family: 'Playfair Display', serif; font-size: 3.2rem; color: var(--pine); font-style: italic;">
          Grand Winners!
        </h2>
        <div class="podium-stage-row">
          <div class="podium-col podium-2">
            <div class="podium-medal">🥈</div>
            <div class="podium-guest-name" id="podium2Name">-</div>
            <div class="podium-guest-score" id="podium2Score">0 pts</div>
          </div>
          <div class="podium-col podium-1">
            <div class="podium-medal">👑</div>
            <div class="podium-guest-name" id="podium1Name">-</div>
            <div class="podium-guest-score" id="podium1Score">0 pts</div>
          </div>
          <div class="podium-col podium-3">
            <div class="podium-medal">🥉</div>
            <div class="podium-guest-name" id="podium3Name">-</div>
            <div class="podium-guest-score" id="podium3Score">0 pts</div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- ALWAYS-ACCESSIBLE HOST CONTROLS BAR (NEVER GET STUCK) -->
  <footer>
    <div class="ctrl-group">
      <button class="btn-toolbar" onclick="hostAction('TOGGLE_PAUSE')" id="pauseBtn">⏸ Pause Auto-Flow</button>
      <button class="btn-toolbar" onclick="hostAction('BACK_TO_QUESTION')" id="btnNavQ">&#8592; Back to Question</button>
      <button class="btn-toolbar" onclick="hostAction('REVEAL_NOW')" id="btnNavReveal">⚡ Reveal Official Answer</button>
      <button class="btn-toolbar" onclick="hostAction('SHOW_LEADERBOARD')" id="btnNavLB">🏆 Leaderboard</button>
    </div>
    <div class="ctrl-group">
      <button class="btn-toolbar" onclick="hostAction('PREV_QUESTION')">&#9664; Prev Q</button>
      <button class="btn-toolbar gold" onclick="hostAction('NEXT_QUESTION')">Next Q &rarr;</button>
      <button class="btn-toolbar" style="color: #b91c1c;" onclick="confirmReset()">Reset</button>
    </div>
  </footer>

  <script>
    let ws = null;
    let soundEnabled = true;
    let audioCtx = null;
    let currentHostState = null;
    let guestListCache = [];
    let lastRenderedStatus = null;
    let lastRenderedQuestionIndex = null;

    const urlParams = new URLSearchParams(window.location.search);
    let currentPin = urlParams.get('pin') || localStorage.getItem('wedding_host_pin') || '';

    function unlockAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }
    window.addEventListener('click', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true });

    function initAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }

    function playTone(freq, duration = 0.1, type = 'sine') {
      if (!soundEnabled) return;
      try {
        initAudio();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      } catch(e) {}
    }

    function playTick() { playTone(784, 0.05, 'triangle'); }
    function playReveal() {
      playTone(523.25, 0.2);
      setTimeout(() => playTone(659.25, 0.2), 100);
      setTimeout(() => playTone(783.99, 0.3), 200);
      setTimeout(() => playTone(1046.50, 0.5), 300);
    }
    function playFanfare() {
      [440, 554.37, 659.25, 880, 1108.73].forEach((f, i) => {
        setTimeout(() => playTone(f, 0.3, 'triangle'), i * 140);
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
          colorDark: "#182f28",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
      } else {
        qrEl.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(playerUrl) + '" alt="QR Code">';
      }
    }

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
          handleServerMessage(JSON.parse(event.data));
        } catch (e) {
          console.error(e);
        }
      };

      ws.onclose = () => { setTimeout(connectWS, 2000); };
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
        updateTimerBar(msg);
        return;
      }
      if (msg.type === 'HOST_STATE_UPDATE') {
        currentHostState = msg;
        renderHostState(msg);
      }
    }

    function updateTimerBar(tick) {
      const timeRemaining = tick.timeRemaining;
      const maxTime = tick.maxTime || 20;
      const pct = maxTime > 0 ? (timeRemaining / maxTime) * 100 : 0;
      document.getElementById('flowBarProgress').style.width = pct + '%';
      
      const pausedText = tick.isPaused ? ' (PAUSED)' : '';
      document.getElementById('flowTimerNumber').textContent = timeRemaining + 's' + pausedText;
      document.getElementById('questionTimer').textContent = timeRemaining + 's';

      if (tick.status === 'QUESTION' && timeRemaining <= 5 && timeRemaining > 0 && !tick.isPaused) {
        playTick();
      }
    }

    function switchView(viewId) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const target = document.getElementById(viewId);
      if (target) target.classList.add('active');
    }

    function renderHostState(data) {
      const statusChanged = data.status !== lastRenderedStatus;
      const questionChanged = data.questionIndex !== lastRenderedQuestionIndex;

      document.getElementById('headerPlayerCount').textContent = data.totalActivePlayers + ' Guests Online';
      document.getElementById('lobbyCount').textContent = data.totalRegisteredPlayers;
      guestListCache = data.guestList || [];
      renderGuestDrawerList();

      // Update Pause button text
      const pauseBtn = document.getElementById('pauseBtn');
      if (data.isPaused) {
        pauseBtn.textContent = '▶ Resume Auto-Flow';
        pauseBtn.classList.add('gold');
      } else {
        pauseBtn.textContent = '⏸ Pause Auto-Flow';
        pauseBtn.classList.remove('gold');
      }

      // Update navigation active highlight in footer
      document.getElementById('btnNavQ').classList.toggle('active-state', data.status === 'QUESTION');
      document.getElementById('btnNavReveal').classList.toggle('active-state', data.status === 'REVEAL');
      document.getElementById('btnNavLB').classList.toggle('active-state', data.status === 'LEADERBOARD');

      // Update flow phase label
      document.getElementById('flowPhaseLabel').textContent = data.status + (data.isPaused ? ' (PAUSED)' : '');

      if (data.status === 'LOBBY') switchView('viewLobby');
      if (data.status === 'QUESTION') {
        switchView('viewQuestion');
        document.getElementById('questionBadge').textContent = 'Question ' + (data.questionIndex + 1) + ' of ' + data.totalQuestions;
        document.getElementById('questionText').textContent = data.currentQuestion ? data.currentQuestion.question : '';
        const totalReg = data.totalRegisteredPlayers || data.totalActivePlayers || 1;
        const ratio = data.answeredCount + ' / ' + totalReg + ' Answered (' + data.totalActivePlayers + ' Online)';
        document.getElementById('answeredRatio').textContent = ratio;
        const pct = totalReg > 0 ? (data.answeredCount / totalReg) * 100 : 0;
        document.getElementById('answeredProgressFill').style.width = Math.min(100, pct) + '%';
      }

      if (data.status === 'REVEAL') {
        switchView('viewReveal');
        if (statusChanged || questionChanged) {
          playReveal();
        }
        const correct = data.currentQuestion.correctAnswer;
        document.getElementById('revealTitle').textContent = "Official Answer: " + correct;

        const aumreCard = document.getElementById('cardAumre');
        const joudyCard = document.getElementById('cardJoudy');
        aumreCard.classList.toggle('is-official', correct === 'Aumre');
        joudyCard.classList.toggle('is-official', correct === 'Joudy');

        document.getElementById('pctAumre').textContent = data.votingStats.aumrePct + '%';
        document.getElementById('votesAumre').textContent = data.votingStats.aumreVotes + ' votes';
        document.getElementById('pctJoudy').textContent = data.votingStats.joudyPct + '%';
        document.getElementById('votesJoudy').textContent = data.votingStats.joudyVotes + ' votes';
      }

      if (data.status === 'LEADERBOARD') {
        switchView('viewLeaderboard');
        const lbEl = document.getElementById('leaderboardList');
        lbEl.innerHTML = '';
        data.leaderboard.forEach((p, idx) => {
          const row = document.createElement('div');
          row.className = 'lb-item';
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '#' + (idx + 1);
          row.innerHTML = \`
            <span class="lb-item-rank">\${medal}</span>
            <span class="lb-item-name">\${escapeHtml(p.nickname)}</span>
            <span class="lb-item-score">\${p.score.toLocaleString()} pts</span>
          \`;
          lbEl.appendChild(row);
        });
      }

      if (data.status === 'FINAL') {
        switchView('viewFinal');
        if (statusChanged) {
          if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 80 });
          playFanfare();
        }
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

      lastRenderedStatus = data.status;
      lastRenderedQuestionIndex = data.questionIndex;
    }

    function renderGuestDrawerList() {
      const el = document.getElementById('guestListContainer');
      if (!el) return;
      if (!guestListCache || guestListCache.length === 0) {
        el.innerHTML = '<div style="padding: 1.5rem; text-align: center; color: var(--text-muted);">No guests connected yet.</div>';
        return;
      }
      el.innerHTML = '';
      guestListCache.forEach(g => {
        const row = document.createElement('div');
        row.className = 'guest-list-row';
        row.innerHTML = \`
          <div>
            <span style="font-weight: 700; color: var(--pine);">\${escapeHtml(g.nickname)}</span>
            <span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 0.5rem;">(\${g.score} pts \${g.connected ? '• online' : '• offline'})</span>
          </div>
          <button class="btn-kick" onclick="kickGuest('\${g.id}')">Kick</button>
        \`;
        el.appendChild(row);
      });
    }

    function openGuestDrawer() { document.getElementById('drawerGuests').style.display = 'flex'; }
    function closeGuestDrawer() { document.getElementById('drawerGuests').style.display = 'none'; }

    function kickGuest(playerId) {
      if (confirm('Kick this player from the game?')) {
        hostAction('KICK_PLAYER', { playerId });
      }
    }

    function hostAction(action, extra = {}) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action, ...extra }));
      }
    }

    function confirmReset() {
      if (confirm("Reset the wedding quiz back to lobby? All scores will reset!")) {
        hostAction('RESET_GAME');
      }
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>"']/g, function(m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
      });
    }

    function advanceStage() {
      if (!currentHostState) return;
      const s = currentHostState.status;
      if (s === 'LOBBY') {
        hostAction('START_GAME');
      } else if (s === 'QUESTION') {
        hostAction('REVEAL_NOW');
      } else if (s === 'REVEAL') {
        hostAction('SHOW_LEADERBOARD');
      } else if (s === 'LEADERBOARD') {
        hostAction('NEXT_QUESTION');
      }
    }

    // Keyboard & Presenter Clicker Remote:
    // Spacebar / ArrowRight / PageDown / ArrowDown: Advance game stages
    // ArrowLeft / PageUp / ArrowUp: Previous question
    // 'P': Pause / Resume
    // 'F': Fullscreen
    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return;
      const modal = document.getElementById('pinModal');
      if (modal && modal.style.display !== 'none') return;

      const isNext = e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'PageDown' || e.code === 'ArrowDown' ||
                     e.key === ' ' || e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'ArrowDown';
      const isPrev = e.code === 'ArrowLeft' || e.code === 'PageUp' || e.code === 'ArrowUp' ||
                     e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp';
      const isPause = e.code === 'KeyP' || e.key === 'p' || e.key === 'P';
      const isFull = e.code === 'KeyF' || e.key === 'f' || e.key === 'F';

      if (isNext) {
        e.preventDefault();
        advanceStage();
      } else if (isPrev) {
        e.preventDefault();
        hostAction('PREV_QUESTION');
      } else if (isPause) {
        e.preventDefault();
        hostAction('TOGGLE_PAUSE');
      } else if (isFull) {
        e.preventDefault();
        toggleFullscreen();
      }
    });

    const pinInput = document.getElementById('pinInput');
    if (pinInput) {
      pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitHostPin();
        }
      });
    }

    function checkHostReconnect() {
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connectWS();
      } else if (ws.readyState === WebSocket.OPEN && currentPin) {
        ws.send(JSON.stringify({ type: 'HOST_AUTH', pin: currentPin }));
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkHostReconnect();
    });
    window.addEventListener('focus', checkHostReconnect);
    window.addEventListener('online', checkHostReconnect);

    connectWS();
  </script>
</body>
</html>`;


// ============================================================================
// FRONTEND: MOBILE PLAYER VIEW (/)
// Luxury Wedding Stationery (Ivory, Gold Hairline, Forest Slate & Dusty Rose)
// ============================================================================
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aumre & Joudy Wedding Quiz</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#fbf8f2">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,500;1,600&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #fbf8f2;
      --card-bg: #ffffff;
      --pine: #182f28;
      --text-muted: #5e6f66;
      --gold: #b88d43;
      --gold-light: #eedebc;
      --gold-border: rgba(184, 141, 67, 0.45);
      --groom-green: #17332c;
      --bride-rose: #7d2a3e;
      --shadow-mobile: 0 4px 20px rgba(24, 47, 40, 0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      background: var(--bg);
      color: var(--pine);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      min-height: 100vh;
      min-height: 100dvh;
      min-height: -webkit-fill-available;
      display: flex;
      flex-direction: column;
      user-select: none;
      -webkit-user-select: none;
      padding-top: env(safe-area-inset-top, 0px);
      padding-bottom: env(safe-area-inset-bottom, 0px);
      padding-left: env(safe-area-inset-left, 0px);
      padding-right: env(safe-area-inset-right, 0px);
    }

    #reconnectBanner {
      display: none;
      background: #eedebc;
      color: var(--pine);
      font-size: 0.8rem;
      font-weight: 700;
      text-align: center;
      padding: 0.35rem;
      border-bottom: 1px solid var(--gold);
    }

    /* HEADER */
    header {
      padding: 0.85rem 1.2rem;
      background: rgba(251, 248, 242, 0.95);
      border-bottom: 1px solid var(--gold-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(8px);
    }
    .header-logo {
      display: flex;
      flex-direction: column;
    }
    .header-super {
      font-family: 'Cinzel', serif;
      font-size: 0.6rem;
      letter-spacing: 2px;
      color: var(--gold);
      text-transform: uppercase;
    }
    .header-names {
      font-family: 'Playfair Display', serif;
      font-size: 1.25rem;
      font-weight: 600;
      font-style: italic;
      color: var(--pine);
    }
    .header-badge {
      background: #fff;
      border: 1px solid var(--gold-border);
      padding: 0.3rem 0.75rem;
      border-radius: 3px;
      font-size: 0.82rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .header-badge .score { color: var(--gold); }

    /* SCREENS */
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
      animation: fadeIn 0.25s ease;
    }
    .screen.active { display: flex; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* STATIONERY CARD */
    .mobile-stationery-card {
      background: #fff;
      border: 1px solid var(--gold-border);
      box-shadow: inset 0 0 0 2px #fbf8f2, inset 0 0 0 3px var(--gold-border), var(--shadow-mobile);
      border-radius: 4px;
      padding: 1.8rem 1.4rem;
      text-align: center;
    }

    .card-stars {
      color: var(--gold);
      font-size: 0.75rem;
      letter-spacing: 4px;
      margin-bottom: 0.5rem;
    }

    /* 1. JOIN SCREEN */
    .join-container { margin: auto 0; }
    .join-title {
      font-family: 'Playfair Display', serif;
      font-size: 2.1rem;
      color: var(--pine);
      font-style: italic;
      line-height: 1.2;
      margin-bottom: 0.5rem;
    }
    .join-subtitle {
      color: var(--text-muted);
      font-size: 0.92rem;
      margin-bottom: 1.8rem;
    }
    .name-input {
      width: 100%;
      background: #fcfaf6;
      border: 1px solid var(--gold-border);
      border-radius: 3px;
      padding: 0.95rem;
      font-size: 1.2rem;
      font-weight: 700;
      color: var(--pine);
      text-align: center;
      outline: none;
      margin-bottom: 1.2rem;
    }
    .name-input:focus { border-color: var(--gold); background: #fff; }
    .btn-gold-mobile {
      width: 100%;
      background: var(--gold);
      color: #fff;
      border: 1px solid #9c732e;
      padding: 1rem;
      font-family: 'Cinzel', serif;
      font-size: 1rem;
      letter-spacing: 1.5px;
      border-radius: 3px;
      cursor: pointer;
      font-weight: 700;
    }

    /* 2. LOBBY SCREEN */
    .waiting-box {
      margin: auto 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
    }

    /* 3. QUESTION SCREEN & TWO LARGE VOTE BUTTONS */
    .q-screen-header {
      text-align: center;
      margin-bottom: 1rem;
    }
    .q-meta-tag {
      font-family: 'Cinzel', serif;
      font-size: 0.75rem;
      letter-spacing: 2px;
      color: var(--gold);
      text-transform: uppercase;
      margin-bottom: 0.3rem;
    }
    .q-statement {
      font-family: 'Playfair Display', serif;
      font-size: 1.65rem;
      line-height: 1.3;
      color: var(--pine);
      font-style: italic;
    }

    .vote-options-stack {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      flex: 1;
      justify-content: center;
      margin-bottom: 0.8rem;
    }

    .btn-option {
      flex: 1;
      border-radius: 4px;
      border: 1px solid var(--gold-border);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      touch-action: manipulation;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      transition: transform 0.1s ease, opacity 0.2s, box-shadow 0.2s;
      position: relative;
    }
    .btn-option:active { transform: scale(0.97); }

    /* Groom Option - Deep Forest Green Tuxedo */
    .btn-option.groom {
      background: var(--groom-green);
      color: #fff;
      box-shadow: inset 0 0 0 2px #183d34, 0 6px 18px rgba(23, 51, 44, 0.25);
    }
    /* Bride Option - Luxury Rose Velvet */
    .btn-option.bride {
      background: var(--bride-rose);
      color: #fff;
      box-shadow: inset 0 0 0 2px #8d3146, 0 6px 18px rgba(125, 42, 62, 0.25);
    }

    .btn-option .role-sub {
      font-family: 'Cinzel', serif;
      font-size: 0.8rem;
      letter-spacing: 2px;
      color: #eedebc;
      text-transform: uppercase;
      margin-bottom: 0.25rem;
    }
    .btn-option .name-main {
      font-family: 'Playfair Display', serif;
      font-size: 2.3rem;
      font-weight: 700;
      color: #fff;
      letter-spacing: 0.5px;
    }

    .btn-option.is-selected {
      border: 2px solid #fff;
      box-shadow: 0 0 0 3px var(--gold), 0 8px 25px rgba(0,0,0,0.3);
    }
    .btn-option.is-dimmed {
      opacity: 0.35;
      filter: grayscale(30%);
    }

    .vote-confirmation-strip {
      display: none;
      background: #f4ecdc;
      border: 1px solid var(--gold);
      padding: 0.8rem;
      border-radius: 3px;
      text-align: center;
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--pine);
    }

    /* 4. REVEAL / RESULT SCREEN */
    .result-card-inner { margin: auto 0; }
    .result-icon { font-size: 3.5rem; margin-bottom: 0.5rem; }
    .result-outcome-title {
      font-family: 'Playfair Display', serif;
      font-size: 2.2rem;
      color: var(--pine);
      font-style: italic;
      margin-bottom: 0.3rem;
    }
    .result-points-pill {
      font-size: 1.25rem;
      font-weight: 800;
      color: var(--gold);
      margin-bottom: 1rem;
    }
    .official-ans-label {
      background: #fbf8f2;
      border: 1px solid var(--gold-subtle);
      padding: 0.75rem;
      border-radius: 3px;
      font-size: 0.95rem;
      color: var(--pine);
      margin-bottom: 1.2rem;
    }
    .rank-score-row {
      display: flex;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: #fcfaf6;
      border: 1px solid var(--gold-subtle);
      border-radius: 3px;
      margin-top: 0.5rem;
      font-size: 0.95rem;
      font-weight: 700;
    }

    /* 5. FINAL SCREEN */
    .final-card-inner { margin: auto 0; }
  </style>
</head>
<body>
  <div id="reconnectBanner">Reconnecting to game...</div>

  <header id="mobileHeader" style="display: none;">
    <div class="header-logo">
      <span class="header-super">The Wedding Of</span>
      <span class="header-names">Aumre &amp; Joudy</span>
    </div>
    <div class="header-badge">
      <span id="playerNick">Guest</span>
      <span class="score" id="playerScore">0 pts</span>
    </div>
  </header>

  <main>
    <!-- 1. JOIN SCREEN -->
    <div id="screenJoin" class="screen active">
      <div class="mobile-stationery-card join-container">
        <div class="card-stars">◆ ✦ ◆</div>
        <h1 class="join-title">Aumre &amp; Joudy</h1>
        <p class="join-subtitle">Enter your name to join tonight's wedding quiz!</p>
        <form onsubmit="event.preventDefault(); joinGame();">
          <input type="text" id="nicknameInput" class="name-input" placeholder="Your Name" maxlength="16" autocomplete="off" autocapitalize="words">
          <button type="submit" class="btn-gold-mobile">Join Game &rarr;</button>
        </form>
      </div>
    </div>

    <!-- 2. LOBBY WAITING SCREEN -->
    <div id="screenLobby" class="screen">
      <div class="mobile-stationery-card waiting-box">
        <div class="card-stars">◆ ✦ ◆</div>
        <div style="font-size: 3rem;">💍✨</div>
        <h2 style="font-family: 'Playfair Display', serif; font-size: 2rem; font-style: italic; color: var(--pine);">You're In!</h2>
        <p style="color: var(--text-muted); font-size: 0.95rem; line-height: 1.5;">Waiting for the MC to start the quiz on the big screen...</p>
      </div>
    </div>

    <!-- 3. QUESTION SCREEN -->
    <div id="screenQuestion" class="screen">
      <div class="q-screen-header">
        <div class="q-meta-tag" id="mobileQBadge">Question 1 of 20</div>
        <h2 class="q-statement" id="mobileQText">Who is more likely to...?</h2>
      </div>

      <div class="vote-options-stack">
        <!-- Aumre -->
        <button class="btn-option groom" id="optAumre" onclick="submitAnswer('Aumre')">
          <span class="role-sub">The Groom 🤵</span>
          <span class="name-main">AUMRE</span>
        </button>
        <!-- Joudy -->
        <button class="btn-option bride" id="optJoudy" onclick="submitAnswer('Joudy')">
          <span class="role-sub">The Bride 👰</span>
          <span class="name-main">JOUDY</span>
        </button>
      </div>

      <div class="vote-confirmation-strip" id="voteSubmittedBar">
        ✓ Answer Locked: <span id="votedNameSpan"></span>! Awaiting official answer...
      </div>
    </div>

    <!-- 4. REVEAL RESULT SCREEN -->
    <div id="screenResult" class="screen">
      <div class="mobile-stationery-card result-card-inner">
        <div class="card-stars">◆ ✦ ◆</div>
        <div class="result-icon" id="resIcon">🎉</div>
        <h2 class="result-outcome-title" id="resTitle">Splendid!</h2>
        <div class="result-points-pill" id="resPoints">+950 pts</div>
        <div class="official-ans-label" id="resOfficialAnswerText">Official Answer: Joudy</div>
        <div class="rank-score-row">
          <span>Total Score</span>
          <span id="resTotalScore" style="color: var(--gold);">0 pts</span>
        </div>
        <div class="rank-score-row">
          <span>Current Standing</span>
          <span id="resRank">#1 of 0</span>
        </div>
      </div>
    </div>

    <!-- 5. FINAL SCREEN -->
    <div id="screenFinal" class="screen">
      <div class="mobile-stationery-card final-card-inner">
        <div class="card-stars">◆ ✦ ◆</div>
        <div style="font-size: 3rem;">🏆🥂</div>
        <h2 style="font-family: 'Playfair Display', serif; font-size: 2.2rem; font-style: italic; color: var(--pine);">Quiz Completed!</h2>
        <p style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 1.2rem;">Thank you for being here with us tonight!</p>
        <div class="rank-score-row">
          <span>Final Score</span>
          <span id="finalScore" style="color: var(--gold);">0 pts</span>
        </div>
        <div class="rank-score-row">
          <span>Final Standing</span>
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
      document.getElementById('mobileHeader').style.display = 'flex';
      document.getElementById('playerNick').textContent = nick;
      document.getElementById('playerScore').textContent = (score || 0) + ' pts';
    }

    function connectWS() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host);

      ws.onopen = () => {
        document.getElementById('reconnectBanner').style.display = 'none';
        if (playerId) {
          ws.send(JSON.stringify({ type: 'PLAYER_REJOIN', playerId, nickname }));
        }
      };

      ws.onmessage = (event) => {
        try {
          handleServerMessage(JSON.parse(event.data));
        } catch(e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        document.getElementById('reconnectBanner').style.display = 'block';
        setTimeout(connectWS, 1500);
      };
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>"']/g, function(m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
      });
    }

    function checkAndReconnect() {
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connectWS();
      } else if (ws.readyState === WebSocket.OPEN && playerId) {
        try {
          ws.send(JSON.stringify({ type: 'PLAYER_REJOIN', playerId, nickname }));
        } catch (e) {
          connectWS();
        }
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkAndReconnect();
      }
    });

    window.addEventListener('pageshow', () => {
      checkAndReconnect();
    });

    window.addEventListener('focus', checkAndReconnect);
    window.addEventListener('online', checkAndReconnect);

    document.addEventListener('touchstart', () => {}, { passive: true });

    function joinGame() {
      const input = document.getElementById('nicknameInput');
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      nickname = name;
      localStorage.setItem('wedding_nickname', name);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'PLAYER_JOIN', playerId, nickname }));
      }
    }

    function submitAnswer(choice) {
      if (hasAnsweredCurrent) return;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        checkAndReconnect();
        alert('Reconnecting to server... Please tap your answer again in a second.');
        return;
      }

      hasAnsweredCurrent = true;
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch (e) {}
      }

      const btnA = document.getElementById('optAumre');
      const btnJ = document.getElementById('optJoudy');
      if (choice === 'Aumre') {
        btnA.classList.add('is-selected');
        btnJ.classList.add('is-dimmed');
      } else {
        btnJ.classList.add('is-selected');
        btnA.classList.add('is-dimmed');
      }

      document.getElementById('votedNameSpan').textContent = choice;
      const bar = document.getElementById('voteSubmittedBar');
      bar.innerHTML = '✓ Answer Locked: <span>' + escapeHtml(choice) + '</span>! Awaiting official answer...';
      bar.style.display = 'block';
      bar.style.background = '#f4ecdc';

      try {
        ws.send(JSON.stringify({ type: 'SUBMIT_ANSWER', answer: choice }));
      } catch (e) {
        hasAnsweredCurrent = false;
        btnA.classList.remove('is-selected', 'is-dimmed');
        btnJ.classList.remove('is-selected', 'is-dimmed');
        bar.style.display = 'none';
        checkAndReconnect();
      }
    }

    function handleServerMessage(msg) {
      if (msg.type === 'KICKED') {
        localStorage.removeItem('wedding_player_id');
        alert('You have been removed from the quiz lobby.');
        location.reload();
        return;
      }

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
        if (nickname) {
          const input = document.getElementById('nicknameInput');
          if (input) input.value = nickname;
        }
        switchScreen('screenJoin');
        return;
      }

      if (msg.type === 'ANSWER_ACCEPTED') {
        hasAnsweredCurrent = true;
        const bar = document.getElementById('voteSubmittedBar');
        bar.innerHTML = '✓ Answer Locked: <span>' + escapeHtml(msg.answer) + '</span>! Awaiting official answer...';
        bar.style.display = 'block';
        bar.style.background = '#f4ecdc';
        return;
      }

      if (msg.type === 'ANSWER_REJECTED_PAUSED') {
        hasAnsweredCurrent = false;
        const btnA = document.getElementById('optAumre');
        const btnJ = document.getElementById('optJoudy');
        if (btnA) btnA.classList.remove('is-selected', 'is-dimmed');
        if (btnJ) btnJ.classList.remove('is-selected', 'is-dimmed');
        const banner = document.getElementById('voteSubmittedBar');
        if (banner) {
          banner.textContent = '⏸ Quiz paused by MC — tap your answer once resumed!';
          banner.style.display = 'block';
          banner.style.background = '#eedebc';
        }
        return;
      }

      if (msg.type === 'REVEAL_RESULT') {
        switchScreen('screenResult');
        initHeader(nickname, msg.newScore);

        const icon = document.getElementById('resIcon');
        const title = document.getElementById('resTitle');
        const pts = document.getElementById('resPoints');
        const offAns = document.getElementById('resOfficialAnswerText');

        if (msg.isCorrect) {
          icon.textContent = '🎉';
          title.textContent = 'Splendid!';
          title.style.color = '#182f28';
          pts.textContent = '+' + msg.pointsEarned.toLocaleString() + ' pts';
        } else {
          icon.textContent = '😅';
          title.textContent = 'Not quite!';
          title.style.color = '#7d2a3e';
          pts.textContent = '+0 pts';
        }

        offAns.textContent = 'Official Answer: ' + msg.correctAnswer;
        document.getElementById('resTotalScore').textContent = msg.newScore.toLocaleString() + ' pts';
        document.getElementById('resRank').textContent = '#' + msg.rank + ' of ' + msg.totalPlayers;
        return;
      }

      if (msg.type === 'PLAYER_STATE_UPDATE') {
        if (!playerId) return;
        initHeader(nickname, msg.score);

        if (msg.status === 'LOBBY') {
          switchScreen('screenLobby');
        } else if (msg.status === 'QUESTION') {
          switchScreen('screenQuestion');
          document.getElementById('mobileQBadge').textContent = 'Question ' + (msg.questionIndex + 1) + ' of ' + msg.totalQuestions;
          document.getElementById('mobileQText').textContent = msg.question;

          const btnA = document.getElementById('optAumre');
          const btnJ = document.getElementById('optJoudy');
          const banner = document.getElementById('voteSubmittedBar');

          if (msg.myAnswer) {
            hasAnsweredCurrent = true;
            if (msg.myAnswer === 'Aumre') {
              btnA.classList.add('is-selected');
              btnJ.classList.add('is-dimmed');
            } else {
              btnJ.classList.add('is-selected');
              btnA.classList.add('is-dimmed');
            }
            document.getElementById('votedNameSpan').textContent = msg.myAnswer;
            banner.innerHTML = '✓ Answer Locked: <span>' + escapeHtml(msg.myAnswer) + '</span>! Awaiting official answer...';
            banner.style.display = 'block';
            banner.style.background = '#f4ecdc';
          } else {
            hasAnsweredCurrent = false;
            btnA.classList.remove('is-selected', 'is-dimmed');
            btnJ.classList.remove('is-selected', 'is-dimmed');
            if (msg.isPaused) {
              banner.textContent = '⏸ Quiz paused by MC — waiting to resume...';
              banner.style.display = 'block';
              banner.style.background = '#eedebc';
            } else {
              banner.style.display = 'none';
            }
          }
        } else if (msg.status === 'REVEAL' || msg.status === 'LEADERBOARD') {
          if (msg.myAnswer && msg.lastRevealStats) {
            switchScreen('screenResult');
            const icon = document.getElementById('resIcon');
            const title = document.getElementById('resTitle');
            const pts = document.getElementById('resPoints');
            const offAns = document.getElementById('resOfficialAnswerText');

            const isCorrect = msg.myAnswer === msg.lastRevealStats.correctAnswer;
            if (isCorrect) {
              icon.textContent = '🎉';
              title.textContent = 'Splendid!';
              title.style.color = '#182f28';
              pts.textContent = '+' + (msg.pointsEarned || 0).toLocaleString() + ' pts';
            } else {
              icon.textContent = '😅';
              title.textContent = 'Not quite!';
              title.style.color = '#7d2a3e';
              pts.textContent = '+0 pts';
            }

            offAns.textContent = 'Official Answer: ' + msg.lastRevealStats.correctAnswer;
            document.getElementById('resTotalScore').textContent = (msg.score || 0).toLocaleString() + ' pts';
            document.getElementById('resRank').textContent = '#' + (msg.rank || 1) + ' of ' + (msg.totalPlayers || 1);
          } else {
            switchScreen('screenLobby');
          }
        } else if (msg.status === 'FINAL') {
          switchScreen('screenFinal');
          document.getElementById('finalScore').textContent = (msg.score || 0).toLocaleString() + ' pts';
          document.getElementById('finalRank').textContent = '#' + (msg.rank || 1) + ' of ' + (msg.totalPlayers || 1);
        }
      }
    }

    window.addEventListener('DOMContentLoaded', () => {
      const nameInput = document.getElementById('nicknameInput');
      if (nameInput) {
        if (nickname) {
          nameInput.value = nickname;
        }
        nameInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            joinGame();
          }
        });
      }
      connectWS();
    });
  </script>
</body>
</html>`;
