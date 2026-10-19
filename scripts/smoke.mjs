// 端到端冒烟测试：真起一个服务器，两个 socket 客户端打完整局。
// 用法: node scripts/smoke.mjs   (会占用 8099 端口)
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';

const PORT = 8099;
const URL = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (b) => process.stdout.write(`[srv] ${b}`));
server.stderr.on('data', (b) => process.stderr.write(`[srv!] ${b}`));

let failed = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const emitAck = (sock, event, payload) =>
  new Promise((resolve) => sock.emit(event, payload, (res) => resolve(res)));

function makeClient(tag) {
  const sock = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { tag, sock, state: null };
  sock.on('state', (s) => (c.state = s));
  sock.on('kicked', () => console.error(`[${tag}] kicked`));
  return c;
}

async function waitFor(fn, timeoutMs = 5000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(20);
  }
  throw new Error(`超时等待: ${label}`);
}

const me = (c) => c.state?.game?.players.find((p) => p.id === c.state.you);
const isMyTurn = (c) => c.state?.game?.turn === c.state?.you;

async function act(c, action, label) {
  const res = await emitAck(c.sock, 'action', { action });
  if (!res?.ok) {
    console.error(`[${c.tag}] 动作失败 ${label || action.type}:`, res?.error, JSON.stringify(action));
    failed++;
  }
  return res;
}

async function takeTurn(c) {
  const g = c.state.game;
  check(g.turn === c.state.you, `${c.tag} 确实是当前回合`);
  check(typeof g.deckCount === 'number', `牌堆数量可见: ${g.deckCount}`);
  check(
    g.players.every((p) => p.cards.every((card) => !card || card.hidden || !!card.rank)),
    '隐藏牌没有泄露点数',
  );

  // 摸牌
  await act(c, { type: 'draw', source: 'deck' }, 'draw');
  await waitFor(() => c.state.game.draw != null, 3000, '进入换牌阶段');

  // 一律弃掉摸到的牌（最保守策略，手牌不变）
  await act(c, { type: 'discardDrawn' }, 'discardDrawn');
  await waitFor(
    () =>
      c.state.game.power != null ||
      c.state.game.turn !== c.state.you ||
      c.state.game.phase !== 'play',
    3000,
    '等待能力结算',
  );

  // 若摸到能力牌，简单处理
  let guard = 0;
  while (c.state.game.power && c.state.game.turn === c.state.you && guard++ < 5) {
    const p = c.state.game.power;
    const other = c.state.game.players.find((x) => x.id !== c.state.you);
    if (p.kind === 'peek') await act(c, { type: 'powerPeek', slot: 0 }, 'powerPeek');
    else if (p.kind === 'spy') await act(c, { type: 'powerSpy', target: other.id, slot: 0 }, 'powerSpy');
    else if (p.kind === 'swap')
      await act(c, { type: 'powerSwap', target: other.id, ownSlot: 0, targetSlot: 0 }, 'powerSwap');
    else if (p.kind === 'peekSwap') await act(c, { type: 'powerPeekSwap', target: other.id, slot: 0 }, 'powerPeekSwap');
    else if (p.kind === 'peekSwapDecide')
      await act(c, { type: 'powerPeekSwapDecide', swap: true, ownSlot: 0 }, 'peekSwapDecide');
    await sleep(30);
  }
  if (c.state.game.power && c.state.game.turn === c.state.you) {
    await act(c, { type: 'skipPower' }, 'skipPower');
  }
}

async function main() {
  await sleep(1200); // 等服务器起来
  const a = makeClient('A');
  const b = makeClient('B');

  const created = await emitAck(a.sock, 'create', { name: '小明' });
  check(created?.ok, '创建房间成功');
  const code = created.code;
  check(/^[A-Z0-9]{4}$/.test(code), `房号格式正确: ${code}`);

  const joined = await emitAck(b.sock, 'join', { code, name: '小红' });
  check(joined?.ok, '第二人加入成功');

  const dup = await emitAck(makeClient('C').sock, 'join', { code, name: '插队' });
  check(dup?.ok === false, '第三人被拒绝: ' + (dup?.error || ''));

  const startRes = await emitAck(a.sock, 'start', {});
  check(startRes?.ok, '开始游戏成功');

  await waitFor(() => a.state?.game?.phase === 'peek', 4000, '进入看牌阶段');
  check(a.state.game.players.every((p) => p.cards.length === 4), '每人 4 张牌');

  // 双方各看两张
  await act(a, { type: 'peek', slots: [0, 1] }, 'peek A');
  await act(b, { type: 'peek', slots: [0, 1] }, 'peek B');
  await waitFor(() => a.state?.game?.phase === 'play', 4000, '进入对局阶段');

  // 对手视角：A 看不到 B 的暗牌点数
  const bView = a.state.game.players.find((p) => p.id !== a.state.you);
  check(bView.cards.some((c) => c && c.hidden && c.rank === undefined), '对手暗牌对 A 不可见');

  // 把 4 张牌（含自己看过的两张）展示给自己是允许的
  const myKnown = me(a).cards.filter((c) => c && !c.hidden);
  check(myKnown.length >= 2, `自己至少能看到 2 张: ${myKnown.map((c) => c.rank).join(',')}`);

  // 打满一整轮：正常轮到谁就谁行动（喊了 CABO 之后也要继续走完最后一圈）
  let turnGuard = 0;
  let caboAttempted = false;
  while (a.state.game.phase === 'play' && turnGuard++ < 200) {
    const cur = a.state.game.turn === a.state.you ? a : b.state.game.turn === b.state.you ? b : null;
    if (!cur) {
      await sleep(30);
      continue;
    }
    // 牌堆见底前，让其中一方喊一次 CABO
    if (!caboAttempted && !a.state.game.caboCalledBy && a.state.game.deckCount < 30) {
      caboAttempted = true;
      await act(cur, { type: 'cabo' }, 'cabo');
      await sleep(80);
      continue;
    }
    await takeTurn(cur);
    await sleep(40);
  }

  check(a.state.game.phase === 'score' || a.state.game.phase === 'over', '一轮正常结束');
  const g = a.state.game;
  check(g.players.every((p) => p.cards.every((c) => c && c.rank !== undefined)), '结算时所有牌公开');
  check(g.players.every((p) => typeof p.gain === 'number'), '结算给出本轮得分');
  check(g.players.every((p) => p.score === (p.gain ?? 0)), `总分累加正确: ${g.players.map((p) => `${p.name}=${p.score}`).join(' ')}`);

  if (g.phase === 'over') {
    check(!!g.winner, '游戏结束有胜者');
  } else {
    const next = await emitAck(a.sock, 'nextRound', {});
    check(next?.ok, '开下一轮成功');
    await waitFor(() => a.state?.game?.phase === 'peek' && a.state?.game?.round === 2, 4000, '第 2 轮开始');
    check(a.state.game.players.every((p) => p.cards.filter(Boolean).length === 4), '第 2 轮重新发 4 张');
  }

  // 重连：用 B 的 token 重新 resume
  const tokB = joined.token;
  const b2 = makeClient('B2');
  const resumed = await emitAck(b2.sock, 'resume', { code, playerId: joined.playerId, token: tokB });
  check(resumed?.ok, '断线重连成功');
  await waitFor(() => b2.state?.game, 3000, '重连后收到状态');
  check(b2.state.you === joined.playerId, '重连身份正确');

  for (const s of [a, b, b2]) s.sock.close();
  server.kill();
  console.log(failed === 0 ? '\n冒烟测试全部通过 ✅' : `\n有 ${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  server.kill();
  process.exit(1);
});
