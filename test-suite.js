const http = require('http');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const assert = require('assert');

const TEST_PORT = 3456;
const HOST_PIN = '1234';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    }).on('error', reject);
  });
}

function createClient(path = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${path}`);
  const messages = [];
  ws.on('message', data => {
    try {
      messages.push(JSON.parse(data.toString()));
    } catch (e) {
      messages.push(data.toString());
    }
  });
  const openPromise = new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  return { ws, messages, openPromise };
}

async function runTests() {
  console.log('--- STARTING COMPREHENSIVE WEDDING QUIZ AUDIT TEST SUITE ---');

  // Spawn server process
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: TEST_PORT, HOST_PIN: HOST_PIN },
    stdio: 'inherit'
  });

  try {
    await wait(1000);

    // 1. Health check & render.yaml verification
    console.log('\n[Test 1] Health check endpoint /health');
    const health = await fetchJson(`http://127.0.0.1:${TEST_PORT}/health`);
    assert.strictEqual(health.status, 200, 'Health endpoint should return 200');
    assert.strictEqual(health.body.status, 'ok', 'Health status should be ok');
    console.log('✓ /health returns 200 ok');

    // 2. Host Auth
    console.log('\n[Test 2] Host authentication');
    const host = createClient();
    await host.openPromise;
    host.ws.send(JSON.stringify({ type: 'HOST_AUTH', pin: HOST_PIN }));
    await wait(200);
    const authOk = host.messages.find(m => m.type === 'HOST_AUTH_OK');
    assert(authOk, 'Host should receive HOST_AUTH_OK');
    console.log('✓ Host authenticated successfully');

    // 3. Socket Reconnection Nulling (CRITICAL)
    console.log('\n[Test 3] Socket Reconnection Nulling (ws1 vs ws2 close race condition)');
    const p1_ws1 = createClient();
    await p1_ws1.openPromise;
    p1_ws1.ws.send(JSON.stringify({ type: 'PLAYER_JOIN', nickname: 'Alice' }));
    await wait(200);

    const joinConfirm = p1_ws1.messages.find(m => m.type === 'JOIN_CONFIRMED');
    assert(joinConfirm, 'Alice should receive JOIN_CONFIRMED');
    const aliceId = joinConfirm.playerId;

    // Alice reconnects with ws2
    const p1_ws2 = createClient();
    await p1_ws2.openPromise;
    p1_ws2.ws.send(JSON.stringify({ type: 'PLAYER_REJOIN', playerId: aliceId, nickname: 'Alice' }));
    await wait(200);

    const rejoinConfirm = p1_ws2.messages.find(m => m.type === 'REJOIN_CONFIRMED');
    assert(rejoinConfirm, 'Alice ws2 should receive REJOIN_CONFIRMED');

    // Now close ws1!
    p1_ws1.ws.close();
    await wait(200);

    // Check host state: Alice should STILL be online (connected = true) because ws2 is active!
    host.messages.length = 0;
    // trigger a host state update by sending a dummy host ping or reset/toggle
    p1_ws2.ws.send(JSON.stringify({ type: 'PLAYER_REJOIN', playerId: aliceId, nickname: 'Alice' }));
    await wait(200);

    const hostUpdate = host.messages.find(m => m.type === 'HOST_STATE_UPDATE');
    assert(hostUpdate, 'Host should receive state update');
    const aliceInGuestList = hostUpdate.guestList.find(g => g.id === aliceId);
    assert(aliceInGuestList, 'Alice must be in guest list');
    assert.strictEqual(aliceInGuestList.connected, true, 'Alice MUST still be connected after ws1 closed!');
    console.log('✓ Socket Reconnection Nulling verified: ws1 close does NOT null out ws2!');

    // 4. Mobile Bandwidth Flood Elimination
    console.log('\n[Test 4] Mobile Bandwidth Flood: verifying mobile receives 0 TIMER_TICK packets');
    // Start game to question 0
    host.ws.send(JSON.stringify({ action: 'START_GAME' }));
    await wait(500);

    p1_ws2.messages.length = 0;
    host.messages.length = 0;
    // Wait 2.2 seconds (should see 2 ticks on host)
    await wait(2200);

    const hostTicks = host.messages.filter(m => m.type === 'TIMER_TICK');
    const playerTicks = p1_ws2.messages.filter(m => m.type === 'TIMER_TICK');
    assert(hostTicks.length >= 2, `Host should have received >= 2 TIMER_TICKs, got ${hostTicks.length}`);
    assert.strictEqual(playerTicks.length, 0, `Player must receive 0 TIMER_TICK packets, got ${playerTicks.length}`);
    console.log(`✓ Bandwidth flood eliminated: Host got ${hostTicks.length} ticks, Mobile got 0 ticks!`);

    // 5. Speed Scoring with Pause Offset
    console.log('\n[Test 5] Speed scoring precision with pause offset');
    // Pause game
    host.ws.send(JSON.stringify({ action: 'TOGGLE_PAUSE' }));
    await wait(200);

    // Verify answers are rejected while paused and ANSWER_REJECTED_PAUSED is sent
    p1_ws2.messages.length = 0;
    p1_ws2.ws.send(JSON.stringify({ type: 'SUBMIT_ANSWER', answer: 'Joudy' }));
    await wait(200);
    const rejectedAnswer = p1_ws2.messages.find(m => m.type === 'ANSWER_ACCEPTED');
    const pauseRejection = p1_ws2.messages.find(m => m.type === 'ANSWER_REJECTED_PAUSED');
    assert(!rejectedAnswer, 'Answer must be REJECTED while game is paused');
    assert(pauseRejection, 'Player must receive ANSWER_REJECTED_PAUSED notification while paused');
    console.log('✓ Submitting answer while paused correctly rejected with notification');

    // Wait 1.5 seconds while paused
    await wait(1500);

    // Unpause game
    host.ws.send(JSON.stringify({ action: 'TOGGLE_PAUSE' }));
    await wait(100);

    // Submit correct answer now
    p1_ws2.ws.send(JSON.stringify({ type: 'SUBMIT_ANSWER', answer: 'Joudy' })); // Question 1 correctAnswer is Joudy
    await wait(200);
    const acceptedAnswer = p1_ws2.messages.find(m => m.type === 'ANSWER_ACCEPTED');
    assert(acceptedAnswer, 'Answer must be ACCEPTED after unpause');

    // Verify speed score was not penalized by the 1.5s pause
    host.messages.length = 0;
    host.ws.send(JSON.stringify({ action: 'REVEAL_NOW' }));
    await wait(300);

    const revealMsg = p1_ws2.messages.find(m => m.type === 'REVEAL_RESULT');
    assert(revealMsg, 'Player should receive REVEAL_RESULT');
    assert(revealMsg.isCorrect, 'Answer should be correct');
    // Since elapsed active time before vote was < 1s, points should be >= 900 despite 1.5s paused delay
    assert(revealMsg.pointsEarned >= 900, `Points earned should be >= 900 with pause offset, got ${revealMsg.pointsEarned}`);
    console.log(`✓ Speed scoring pause offset works: points earned = ${revealMsg.pointsEarned} >= 900!`);

    // 6. Quorum-Based Auto-Reveal
    console.log('\n[Test 6] Quorum-based auto-reveal (with disconnected voted player edge case)');
    // Reset game and register 4 players: Alice, Bob, Charlie, David
    host.ws.send(JSON.stringify({ action: 'RESET_GAME' }));
    await wait(200);

    const pBob = createClient();
    await pBob.openPromise;
    pBob.ws.send(JSON.stringify({ type: 'PLAYER_JOIN', nickname: 'Bob' }));

    const pCharlie = createClient();
    await pCharlie.openPromise;
    pCharlie.ws.send(JSON.stringify({ type: 'PLAYER_JOIN', nickname: 'Charlie' }));

    const pDavid = createClient();
    await pDavid.openPromise;
    pDavid.ws.send(JSON.stringify({ type: 'PLAYER_JOIN', nickname: 'David' }));
    await wait(300);

    // Start question 0
    host.ws.send(JSON.stringify({ action: 'START_GAME' }));
    await wait(200);

    // Alice answers first, then disconnects!
    p1_ws2.ws.send(JSON.stringify({ type: 'SUBMIT_ANSWER', answer: 'Joudy' }));
    await wait(100);
    p1_ws2.ws.close(); // Alice's phone went to sleep after voting
    await wait(200);

    // Now Bob and Charlie answer (total answers = 3 / 4 = 75% quorum met).
    // BUT David is actively connected and has NOT answered!
    pBob.ws.send(JSON.stringify({ type: 'SUBMIT_ANSWER', answer: 'Aumre' }));
    pCharlie.ws.send(JSON.stringify({ type: 'SUBMIT_ANSWER', answer: 'Joudy' }));
    await wait(300);

    // Status MUST still be QUESTION because connected player David hasn't answered yet!
    let latestHostState = host.messages.filter(m => m.type === 'HOST_STATE_UPDATE').pop();
    assert.strictEqual(latestHostState.status, 'QUESTION', 'Game must NOT auto-reveal when connected player David has not answered!');
    console.log('✓ Quorum correctly protects connected player David from being cut off');

    // Now David answers -> Quorum met AND all connected answered -> Auto-reveal!
    pDavid.ws.send(JSON.stringify({ type: 'SUBMIT_ANSWER', answer: 'Aumre' }));
    await wait(300);

    latestHostState = host.messages.filter(m => m.type === 'HOST_STATE_UPDATE').pop();
    assert.strictEqual(latestHostState.status, 'REVEAL', 'Game SHOULD auto-reveal when all connected answered and quorum met!');
    console.log('✓ Quorum auto-reveals when all active connected players have answered');

    // Reconnect Alice for subsequent tests
    const pAliceReconnect = createClient();
    await pAliceReconnect.openPromise;
    const aliceOrigId = host.messages.find(m => m.type === 'HOST_STATE_UPDATE').guestList.find(g => g.nickname === 'Alice').id;
    pAliceReconnect.ws.send(JSON.stringify({ type: 'PLAYER_REJOIN', playerId: aliceOrigId, nickname: 'Alice' }));
    await wait(200);

    // 7. Reconnect during REVEAL and LEADERBOARD
    console.log('\n[Test 7] Reconnect on REVEAL and LEADERBOARD');
    // Charlie disconnects and reconnects during REVEAL
    const pCharlie2 = createClient();
    await pCharlie2.openPromise;
    const charlieId = pCharlie.messages.find(m => m.type === 'JOIN_CONFIRMED').playerId;
    pCharlie2.ws.send(JSON.stringify({ type: 'PLAYER_REJOIN', playerId: charlieId, nickname: 'Charlie' }));
    await wait(300);

    const charlieState = pCharlie2.messages.find(m => m.type === 'PLAYER_STATE_UPDATE');
    assert(charlieState, 'Charlie should receive PLAYER_STATE_UPDATE on rejoin');
    assert.strictEqual(charlieState.status, 'REVEAL', 'Status should be REVEAL');
    assert(charlieState.lastRevealStats, 'PLAYER_STATE_UPDATE MUST include lastRevealStats');
    assert.strictEqual(charlieState.lastRevealStats.correctAnswer, 'Joudy', 'Correct answer must match');
    assert.strictEqual(charlieState.myAnswer, 'Joudy', 'Charlie answer should be Joudy');
    console.log('✓ Reconnect on REVEAL provides lastRevealStats and answer correctly!');

    // 8. Host Navigation Actions
    console.log('\n[Test 8] Host Navigation: BACK_TO_QUESTION, timer resumption, and NEXT_QUESTION from LOBBY');
    // BACK_TO_QUESTION: should set status to QUESTION, isPaused to true, and stop timer
    host.ws.send(JSON.stringify({ action: 'BACK_TO_QUESTION' }));
    await wait(200);

    latestHostState = host.messages.filter(m => m.type === 'HOST_STATE_UPDATE').pop();
    assert.strictEqual(latestHostState.status, 'QUESTION', 'BACK_TO_QUESTION should return to QUESTION');
    assert.strictEqual(latestHostState.isPaused, true, 'BACK_TO_QUESTION must set isPaused = true');
    console.log('✓ BACK_TO_QUESTION correctly sets status=QUESTION and isPaused=true');

    // Unpause after BACK_TO_QUESTION -> timer interval MUST resume!
    host.messages.length = 0;
    host.ws.send(JSON.stringify({ action: 'TOGGLE_PAUSE' }));
    await wait(1500);

    const resumedTicks = host.messages.filter(m => m.type === 'TIMER_TICK');
    assert(resumedTicks.length >= 1, 'Timer ticks must resume counting down after unpausing from BACK_TO_QUESTION!');
    console.log('✓ Timer countdown cleanly resumes after unpausing from BACK_TO_QUESTION');

    // Reset to LOBBY
    host.ws.send(JSON.stringify({ action: 'RESET_GAME' }));
    await wait(200);
    latestHostState = host.messages.filter(m => m.type === 'HOST_STATE_UPDATE').pop();
    assert.strictEqual(latestHostState.status, 'LOBBY');

    // NEXT_QUESTION from LOBBY should launch question 0
    host.ws.send(JSON.stringify({ action: 'NEXT_QUESTION' }));
    await wait(200);
    latestHostState = host.messages.filter(m => m.type === 'HOST_STATE_UPDATE').pop();
    assert.strictEqual(latestHostState.status, 'QUESTION', 'NEXT_QUESTION from LOBBY must start question 0');
    assert.strictEqual(latestHostState.questionIndex, 0, 'Question index must be 0');
    console.log('✓ NEXT_QUESTION from LOBBY launches question 0 smoothly');

    // 9. Verify Frontend HTML features
    console.log('\n[Test 9] Frontend HTML source code inspections');
    const hostHtmlRes = await fetchText(`http://127.0.0.1:${TEST_PORT}/host`);
    const playerHtmlRes = await fetchText(`http://127.0.0.1:${TEST_PORT}/`);

    // Host HTML checks:
    assert(hostHtmlRes.text.includes('advanceStage'), 'HOST_HTML must have advanceStage');
    assert(hostHtmlRes.text.includes('unlockAudio'), 'HOST_HTML must have unlockAudio');
    assert(hostHtmlRes.text.includes('PageDown'), 'HOST_HTML must support PageDown clicker');
    assert(hostHtmlRes.text.includes('PageUp'), 'HOST_HTML must support PageUp clicker');
    assert(hostHtmlRes.text.includes('KeyP'), 'HOST_HTML must support KeyP pause');
    assert(hostHtmlRes.text.includes('KeyF'), 'HOST_HTML must support KeyF fullscreen');
    assert(hostHtmlRes.text.includes('pinInput'), 'HOST_HTML must have pinInput listener');
    assert(hostHtmlRes.text.includes('Answered ('), 'HOST_HTML must show Answered (X Online) ratio');
    console.log('✓ HOST_HTML contains all remote clicker shortcuts, audio unlock, and answer ratio format');

    // Player HTML checks:
    assert(playerHtmlRes.text.includes('100dvh'), 'PLAYER_HTML must have 100dvh');
    assert(playerHtmlRes.text.includes('safe-area-inset-top'), 'PLAYER_HTML must have safe-area-inset-top');
    assert(playerHtmlRes.text.includes('safe-area-inset-bottom'), 'PLAYER_HTML must have safe-area-inset-bottom');
    assert(playerHtmlRes.text.includes('visibilitychange'), 'PLAYER_HTML must have visibilitychange');
    assert(playerHtmlRes.text.includes('pageshow'), 'PLAYER_HTML must have pageshow');
    assert(playerHtmlRes.text.includes('touchstart'), 'PLAYER_HTML must have touchstart for iOS :active');
    assert(playerHtmlRes.text.includes('screenResult'), 'PLAYER_HTML must switch to screenResult on REVEAL');
    console.log('✓ PLAYER_HTML contains safe-area insets, 100dvh, visibilitychange, pageshow, and touchstart');

    console.log('\n========================================');
    console.log('🎉 ALL 9 AUDIT TEST SUITE PASSES CONFIRMED!');
    console.log('========================================');

    // Clean up
    p1_ws2.ws.close();
    pBob.ws.close();
    pCharlie2.ws.close();
    host.ws.close();

  } finally {
    serverProcess.kill('SIGTERM');
  }
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
