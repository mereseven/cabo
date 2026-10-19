/**
 * CABO 规则引擎（服务端权威）
 *
 * 牌库（官方 52 张）：
 *   0 两张、13 两张、1~12 各四张。
 *
 * 规则要点（Bezier 2nd Edition）：
 *  - 每人 4 张牌，开局可看其中 2 张，之后不能再随意看。
 *  - 回合行动二选一：
 *      a. 摸牌堆顶（暗看）→ 与手中一张交换（换下的牌亮出进弃牌堆），或直接弃掉并可选使用能力；
 *      b. 拿弃牌堆顶（必须立刻与手中一张交换；该牌此后始终正面朝上）。
 *  - 能力（仅当从摸牌堆摸到并弃掉时可用）：7/8 看自己一张；9/10 看对手一张；
 *    11/12 与对手盲换一张；13 看对手一张后决定是否交换。
 *  - 喊 CABO：其余每人还有 1 回合。结算时喊者若（并列）最低得 0 分，否则得「牌面 + 10」；
 *    其他人各得自己的牌面分。牌堆抽空也立即结算。
 *  - 累计恰好 100 分时降为 50 分（每人一次）。有人 >100 分游戏结束，总分最低者胜。
 */

export interface Card {
  id: string;
  rank: number; // 0..13
}

export interface Player {
  id: string;
  name: string;
  seat: number;
  score: number; // 累计分
  resetUsed: boolean;
  connected: boolean;
  cards: (Card | null)[]; // 4 个位置
  faceUp: boolean[]; // 该位置是否公开（来自弃牌堆）
  isCaboCaller: boolean;
}

export type Phase = 'lobby' | 'peek' | 'play' | 'score' | 'over';

export interface DrawPending {
  card: Card;
  source: 'deck' | 'discard';
}

export interface PowerState {
  kind: 'peek' | 'spy' | 'swap' | 'peekSwap' | 'peekSwapDecide';
  // 13 号牌：已经看过对手的一张，等待决定是否交换
  seen?: { owner: number; slot: number };
}

export interface Memory {
  [key: string]: number; // `${ownerSeat}:${slot}` -> rank
}

export interface Game {
  phase: Phase;
  round: number; // 第几轮（从 1 开始）
  dealer: number; // 发牌/先手玩家 seat
  turn: number; // 当前行动玩家 seat
  players: Player[];
  deck: Card[];
  discard: Card[];
  draw: DrawPending | null;
  power: PowerState | null;
  caboCalledBy: number | null;
  finalQueue: number[]; // 喊 CABO 之后仍需行动的座位（按顺序）
  memory: Record<string, Memory>; // playerId -> 记忆
  log: string[];
  winnerSeat: number | null;
  endReason: 'cabo' | 'deck' | null;
  lastGains: number[];
}

export type Action =
  | { type: 'peek'; slots: [number, number] }
  | { type: 'draw'; source: 'deck' | 'discard' }
  | { type: 'swap'; slot: number }
  | { type: 'discardDrawn' }
  | { type: 'powerPeek'; slot: number }
  | { type: 'powerSpy'; target: string; slot: number }
  | { type: 'powerSwap'; target: string; ownSlot: number; targetSlot: number }
  | { type: 'powerPeekSwap'; target: string; slot: number }
  | { type: 'powerPeekSwapDecide'; swap: boolean; ownSlot?: number }
  | { type: 'skipPower' }
  | { type: 'cabo' };

export class RuleError extends Error {}

function fail(msg: string): never {
  throw new RuleError(msg);
}

export function makeDeck(rng: () => number = Math.random): Card[] {
  const ranks: number[] = [];
  for (let r = 1; r <= 12; r++) for (let i = 0; i < 4; i++) ranks.push(r);
  ranks.push(0, 0, 13, 13);
  // Fisher-Yates
  for (let i = ranks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
  }
  return ranks.map((rank, i) => ({ id: `c${i}_${rank}`, rank }));
}

export function createGame(playerInfos: { id: string; name: string }[]): Game {
  if (playerInfos.length < 2 || playerInfos.length > 4) fail('2~4 人才能开始');
  const players: Player[] = playerInfos.map((p, i) => ({
    id: p.id,
    name: p.name,
    seat: i,
    score: 0,
    resetUsed: false,
    connected: true,
    cards: [null, null, null, null],
    faceUp: [false, false, false, false],
    isCaboCaller: false,
  }));
  const g: Game = {
    phase: 'lobby',
    round: 0,
    dealer: 0,
    turn: 0,
    players,
    deck: [],
    discard: [],
    draw: null,
    power: null,
    caboCalledBy: null,
    finalQueue: [],
    memory: Object.fromEntries(players.map((p) => [p.id, {} as Memory])),
    log: [],
    winnerSeat: null,
    endReason: null,
    lastGains: [],
  };
  startRound(g, 0);
  return g;
}

export function startRound(g: Game, dealer: number) {
  const n = g.players.length;
  g.round += 1;
  g.dealer = dealer % n;
  g.turn = g.dealer;
  g.phase = 'peek';
  g.draw = null;
  g.power = null;
  g.caboCalledBy = null;
  g.finalQueue = [];
  g.endReason = null;
  g.winnerSeat = null;
  g.lastGains = [];
  g.deck = makeDeck();
  g.discard = [];
  g.memory = Object.fromEntries(g.players.map((p) => [p.id, {} as Memory]));
  g.log = [];

  for (const p of g.players) {
    p.cards = [null, null, null, null];
    p.faceUp = [false, false, false, false];
    p.isCaboCaller = false;
  }
  // 发牌
  for (let r = 0; r < 4; r++) {
    for (let s = 0; s < n; s++) {
      const p = g.players[(g.dealer + s) % n];
      p.cards[r] = g.deck.pop()!;
    }
  }
  // 翻开一张作为弃牌堆
  g.discard.push(g.deck.pop()!);
  addLog(g, `第 ${g.round} 轮开始，${g.players[g.dealer].name} 先手。每人可先看自己的 2 张牌。`);
}

function addLog(g: Game, msg: string) {
  g.log.push(msg);
  if (g.log.length > 40) g.log.shift();
}

export function currentPlayer(g: Game): Player {
  return g.players[g.turn];
}

function memoryOf(g: Game, playerId: string): Memory {
  return g.memory[playerId];
}

function remember(g: Game, playerId: string, ownerSeat: number, slot: number, rank: number) {
  memoryOf(g, playerId)[`${ownerSeat}:${slot}`] = rank;
}

function forget(g: Game, ownerSeat: number, slot: number) {
  const key = `${ownerSeat}:${slot}`;
  for (const id of Object.keys(g.memory)) delete g.memory[id][key];
}

function seatOf(g: Game, playerId: string): number {
  const p = g.players.find((x) => x.id === playerId);
  if (!p) fail('玩家不存在');
  return p.seat;
}

function assertTurn(g: Game, playerId: string) {
  if (g.phase !== 'play' && g.phase !== 'peek') fail('当前不在对局阶段');
  if (g.players[g.turn].id !== playerId) fail('还没轮到你');
}

/** 应用一个动作；失败抛 RuleError，成功就地修改 g。 */
export function applyAction(g: Game, playerId: string, action: Action): void {
  switch (action.type) {
    case 'peek':
      return doPeek(g, playerId, action.slots);
    case 'draw':
      return doDraw(g, playerId, action.source);
    case 'swap':
      return doSwap(g, playerId, action.slot);
    case 'discardDrawn':
      return doDiscardDrawn(g, playerId);
    case 'powerPeek':
      return doPowerPeek(g, playerId, action.slot);
    case 'powerSpy':
      return doPowerSpy(g, playerId, action.target, action.slot);
    case 'powerSwap':
      return doPowerSwap(g, playerId, action.target, action.ownSlot, action.targetSlot);
    case 'powerPeekSwap':
      return doPowerPeekSwap(g, playerId, action.target, action.slot);
    case 'powerPeekSwapDecide':
      return doPowerPeekSwapDecide(g, playerId, action.swap, action.ownSlot);
    case 'skipPower':
      return doSkipPower(g, playerId);
    case 'cabo':
      return doCabo(g, playerId);
    default:
      fail('未知动作');
  }
}

// ---------- 开局看牌 ----------

function doPeek(g: Game, playerId: string, slots: [number, number]) {
  if (g.phase !== 'peek') fail('现在不是看牌阶段');
  const p = g.players.find((x) => x.id === playerId)!;
  const [a, b] = slots;
  if (a === b) fail('要看两张不同的牌');
  if (!(a in [0, 1, 2, 3]) || !(b in [0, 1, 2, 3])) fail('位置不合法');
  const mem = memoryOf(g, p.id);
  if (Object.keys(mem).length > 0) fail('本局已经看过牌了');
  remember(g, p.id, p.seat, a, p.cards[a]!.rank);
  remember(g, p.id, p.seat, b, p.cards[b]!.rank);
  addLog(g, `${p.name} 记住了自己的 2 张牌。`);
  if (g.players.every((x) => Object.keys(g.memory[x.id]).some((k) => k.startsWith(`${x.seat}:`)))) {
    g.phase = 'play';
    addLog(g, `轮到 ${g.players[g.turn].name} 行动。`);
  }
}

// ---------- 摸牌 / 换牌 / 弃牌 ----------

function doDraw(g: Game, playerId: string, source: 'deck' | 'discard') {
  if (g.phase !== 'play') fail('现在不能摸牌');
  assertTurn(g, playerId);
  if (g.draw) fail('请先处理手上摸到的牌');
  const p = currentPlayer(g);
  if (source === 'discard') {
    const card = g.discard.pop();
    if (!card) fail('弃牌堆是空的');
    g.draw = { card, source: 'discard' };
    addLog(g, `${p.name} 从弃牌堆拿了 ${card.rank}，必须换入手中。`);
    return;
  }
  if (g.deck.length === 0) {
    // 2nd edition：牌堆抽空立即结算
    endRound(g, 'deck');
    return;
  }
  const card = g.deck.pop()!;
  g.draw = { card, source: 'deck' };
  addLog(g, `${p.name} 摸了一张牌。`);
}

function doSwap(g: Game, playerId: string, slot: number) {
  if (!g.draw) fail('没有待处理的牌');
  assertTurn(g, playerId);
  const p = currentPlayer(g);
  if (slot < 0 || slot > 3) fail('位置不合法');
  const old = p.cards[slot];
  if (!old) fail('该位置没有牌');
  const { card, source } = g.draw;
  p.cards[slot] = card;
  p.faceUp[slot] = source === 'discard';
  forget(g, p.seat, slot);
  // 换进来的牌是自己看过的，记到自己名下
  remember(g, p.id, p.seat, slot, card.rank);
  g.discard.push(old);
  addLog(
    g,
    `${p.name} 用摸到的牌换掉了自己的第 ${slot + 1} 张（亮出 ${old.rank}）。`,
  );
  g.draw = null;
  finishTurn(g);
}

function doDiscardDrawn(g: Game, playerId: string) {
  if (!g.draw) fail('没有待处理的牌');
  assertTurn(g, playerId);
  if (g.draw.source !== 'deck') fail('从弃牌堆拿的牌必须换入手中');
  const p = currentPlayer(g);
  const card = g.draw.card;
  g.discard.push(card);
  g.draw = null;
  addLog(g, `${p.name} 弃掉了 ${card.rank}。`);
  if (card.rank >= 7 && card.rank <= 13) {
    g.power = { kind: powerKindFor(card.rank) };
    if (card.rank === 13) g.power.kind = 'peekSwap';
    return; // 等待决定是否使用能力
  }
  finishTurn(g);
}

function powerKindFor(rank: number): PowerState['kind'] {
  if (rank === 7 || rank === 8) return 'peek';
  if (rank === 9 || rank === 10) return 'spy';
  return 'swap'; // 11, 12
}

// ---------- 能力 ----------

function doPowerPeek(g: Game, playerId: string, slot: number) {
  requirePower(g, playerId, 'peek');
  const p = currentPlayer(g);
  if (slot < 0 || slot > 3 || !p.cards[slot]) fail('位置不合法');
  remember(g, p.id, p.seat, slot, p.cards[slot]!.rank);
  addLog(g, `${p.name} 用能力看了自己第 ${slot + 1} 张牌。`);
  g.power = null;
  finishTurn(g);
}

function doPowerSpy(g: Game, playerId: string, targetId: string, slot: number) {
  requirePower(g, playerId, 'spy');
  const p = currentPlayer(g);
  const t = g.players.find((x) => x.id === targetId);
  if (!t || t.id === p.id) fail('目标不合法');
  if (slot < 0 || slot > 3 || !t.cards[slot]) fail('位置不合法');
  remember(g, p.id, t.seat, slot, t.cards[slot]!.rank);
  addLog(g, `${p.name} 用能力偷看了 ${t.name} 的第 ${slot + 1} 张牌。`);
  g.power = null;
  finishTurn(g);
}

function doPowerSwap(g: Game, playerId: string, targetId: string, ownSlot: number, targetSlot: number) {
  requirePower(g, playerId, 'swap');
  const p = currentPlayer(g);
  const t = g.players.find((x) => x.id === targetId);
  if (!t || t.id === p.id) fail('目标不合法');
  if (!p.cards[ownSlot] || !t.cards[targetSlot]) fail('位置不合法');
  const mine = p.cards[ownSlot]!;
  const theirs = t.cards[targetSlot]!;
  p.cards[ownSlot] = theirs;
  t.cards[targetSlot] = mine;
  const pf = p.faceUp[ownSlot];
  const tf = t.faceUp[targetSlot];
  p.faceUp[ownSlot] = tf;
  t.faceUp[targetSlot] = pf;
  forget(g, p.seat, ownSlot);
  forget(g, t.seat, targetSlot);
  addLog(g, `${p.name} 用能力盲换了 ${t.name} 的第 ${targetSlot + 1} 张牌。`);
  g.power = null;
  finishTurn(g);
}

function doPowerPeekSwap(g: Game, playerId: string, targetId: string, slot: number) {
  requirePower(g, playerId, 'peekSwap');
  const p = currentPlayer(g);
  const t = g.players.find((x) => x.id === targetId);
  if (!t || t.id === p.id) fail('目标不合法');
  if (slot < 0 || slot > 3 || !t.cards[slot]) fail('位置不合法');
  remember(g, p.id, t.seat, slot, t.cards[slot]!.rank);
  g.power = { kind: 'peekSwapDecide', seen: { owner: t.seat, slot } };
  addLog(g, `${p.name} 用 13 号牌看了 ${t.name} 的第 ${slot + 1} 张牌。`);
}

function doPowerPeekSwapDecide(g: Game, playerId: string, swap: boolean, ownSlot?: number) {
  assertTurn(g, playerId);
  if (!g.power || g.power.kind !== 'peekSwapDecide') fail('现在不处于 13 号牌决策');
  const p = currentPlayer(g);
  const seen = g.power.seen!;
  const t = g.players[seen.owner];
  if (!swap) {
    addLog(g, `${p.name} 选择不交换。`);
    g.power = null;
    finishTurn(g);
    return;
  }
  if (ownSlot === undefined || ownSlot < 0 || ownSlot > 3 || !p.cards[ownSlot])
    fail('位置不合法');
  const mine = p.cards[ownSlot]!;
  const theirs = t.cards[seen.slot]!;
  p.cards[ownSlot] = theirs;
  t.cards[seen.slot] = mine;
  const pf = p.faceUp[ownSlot];
  const tf = t.faceUp[seen.slot];
  p.faceUp[ownSlot] = tf;
  t.faceUp[seen.slot] = pf;
  forget(g, p.seat, ownSlot);
  forget(g, t.seat, seen.slot);
  remember(g, p.id, p.seat, ownSlot, theirs.rank);
  addLog(g, `${p.name} 用 13 号牌交换了 ${t.name} 的第 ${seen.slot + 1} 张。`);
  g.power = null;
  finishTurn(g);
}

function doSkipPower(g: Game, playerId: string) {
  if (!g.power) fail('没有待决定的能力');
  assertTurn(g, playerId);
  if (g.power.kind === 'peekSwapDecide') fail('13 号牌必须做出选择');
  addLog(g, `${g.players[g.turn].name} 放弃使用能力。`);
  g.power = null;
  finishTurn(g);
}

function requirePower(g: Game, playerId: string, kind: PowerState['kind']) {
  assertTurn(g, playerId);
  if (!g.power || g.power.kind !== kind) fail('现在不能使用该能力');
}

// ---------- CABO ----------

function doCabo(g: Game, playerId: string) {
  if (g.phase !== 'play') fail('现在不能喊 CABO');
  assertTurn(g, playerId);
  if (g.caboCalledBy !== null) fail('本轮已经有人喊过 CABO');
  if (g.draw || g.power) fail('请先完成当前动作');
  const p = currentPlayer(g);
  g.caboCalledBy = p.seat;
  p.isCaboCaller = true;
  const n = g.players.length;
  g.finalQueue = [];
  for (let i = 1; i < n; i++) g.finalQueue.push((p.seat + i) % n);
  addLog(g, `${p.name} 喊了 CABO！其他人各有最后一回合。`);
  finishTurn(g);
}

// ---------- 回合推进 ----------

function finishTurn(g: Game) {
  if (g.phase !== 'play') return;
  if (g.deck.length === 0 && g.players.every((p) => p.cards.every((c) => c !== null))) {
    // 牌堆抽空：立即结算（2nd edition）
    if (g.caboCalledBy === null) {
      endRound(g, 'deck');
      return;
    }
  }
  const n = g.players.length;
  if (g.caboCalledBy !== null) {
    if (g.finalQueue.length === 0) {
      endRound(g, 'cabo');
      return;
    }
    g.turn = g.finalQueue.shift()!;
  } else {
    g.turn = (g.turn + 1) % n;
  }
  addLog(g, `轮到 ${g.players[g.turn].name}。`);
}

function endRound(g: Game, reason: 'cabo' | 'deck') {
  g.phase = 'score';
  g.endReason = reason;
  const sums = g.players.map((p) => p.cards.reduce((s, c) => s + (c ? c.rank : 0), 0));
  const lowest = Math.min(...sums);
  const caller = g.caboCalledBy;
  const gains: number[] = [];
  g.players.forEach((p, i) => {
    if (caller !== null) {
      if (i === caller) {
        gains[i] = sums[i] === lowest ? 0 : sums[i] + 10;
      } else {
        gains[i] = sums[i];
      }
    } else {
      // 牌堆抽空：没有 CABO 喊牌者，所有人按手牌点数计分
      gains[i] = sums[i];
    }
  });
  g.lastGains = gains;
  g.players.forEach((p, i) => {
    p.score += gains[i];
    if (p.score === 100 && !p.resetUsed) {
      p.score = 50;
      p.resetUsed = true;
      addLog(g, `${p.name} 恰好 100 分，按规则降为 50 分（本局一次）。`);
    }
  });
  const anyOver = g.players.some((p) => p.score > 100);
  if (anyOver) {
    g.phase = 'over';
    const min = Math.min(...g.players.map((p) => p.score));
    g.winnerSeat = g.players.find((p) => p.score === min)!.seat;
    addLog(g, `游戏结束！${g.players[g.winnerSeat].name} 总分最低，获胜。`);
  }
  addLog(g, `本轮结算：${g.players.map((p, i) => `${p.name} +${gains[i]}`).join('，')}。`);
}

/** 结算后开始下一轮；返回发牌座位（本轮最低者）。 */
export function nextRound(g: Game): void {
  if (g.phase !== 'score') fail('当前不能开始下一轮');
  const sums = g.players.map((p) => p.cards.reduce((s, c) => s + (c ? c.rank : 0), 0));
  const lowest = Math.min(...sums);
  const candidates = g.players.filter((_, i) => sums[i] === lowest);
  candidates.sort((a, b) => a.score - b.score);
  startRound(g, candidates[0].seat);
}

// ---------- 视图 ----------

export interface CardView {
  hidden: boolean;
  rank?: number;
  faceUp: boolean;
}

export interface PlayerView {
  id: string;
  name: string;
  seat: number;
  score: number;
  connected: boolean;
  isCaboCaller: boolean;
  cards: (CardView | null)[];
  gain: number | null;
}

export interface GameView {
  phase: Phase;
  round: number;
  turn: string;
  you: string;
  caboCalledBy: string | null;
  players: PlayerView[];
  deckCount: number;
  discardTop: Card | null;
  discardCount: number;
  draw: { rank: number; source: 'deck' | 'discard' } | null;
  power: PowerState | null;
  log: string[];
  endReason: 'cabo' | 'deck' | null;
  winner: string | null;
  peekDone: boolean;
}

export function viewFor(g: Game, viewerId: string): GameView {
  const viewer = g.players.find((p) => p.id === viewerId);
  const mem = (viewer && g.memory[viewer.id]) || {};
  const reveal = g.phase === 'score' || g.phase === 'over';
  // 摸到的牌与进行中的能力只对当前行动者可见
  const actor = g.players[g.turn]?.id === viewerId;
  return {
    phase: g.phase,
    round: g.round,
    turn: g.players[g.turn].id,
    you: viewerId,
    caboCalledBy: g.caboCalledBy === null ? null : g.players[g.caboCalledBy].id,
    players: g.players.map((p, pi) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      score: p.score,
      connected: p.connected,
      isCaboCaller: p.isCaboCaller,
      gain: g.lastGains.length ? g.lastGains[pi] ?? null : null,
      cards: p.cards.map((c, slot) => {
        if (!c) return null;
        const known = reveal || p.faceUp[slot] || mem[`${p.seat}:${slot}`] !== undefined;
        return {
          hidden: !known,
          rank: known ? c.rank : undefined,
          faceUp: p.faceUp[slot],
        };
      }),
    })),
    deckCount: g.deck.length,
    discardTop: g.discard[g.discard.length - 1] ?? null,
    discardCount: g.discard.length,
    draw: actor && g.draw ? { rank: g.draw.card.rank, source: g.draw.source } : null,
    power: actor && g.power ? { ...g.power } : null,
    log: g.log.slice(-12),
    endReason: g.endReason,
    winner: g.winnerSeat === null ? null : g.players[g.winnerSeat].id,
    peekDone: !!viewer && Object.keys(mem).some((k) => k.startsWith(`${viewer.seat}:`)),
  };
}
