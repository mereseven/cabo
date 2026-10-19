import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  makeDeck,
  viewFor,
  type Card,
  type Game,
} from '../src/shared/game';

let n = 0;
const c = (rank: number): Card => ({ id: `t${n++}`, rank });

function twoPlayers(): Game {
  return createGame([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]);
}

/** 把牌局摆成确定的局面，方便断言。 */
function fixed(g: Game, a: number[], b: number[], deck: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  g.players[0].cards = a.map(c);
  g.players[1].cards = b.map(c);
  g.players[0].faceUp = [false, false, false, false];
  g.players[1].faceUp = [false, false, false, false];
  g.deck = deck.map(c);
  g.discard = [c(4)];
  g.memory = { a: {}, b: {} };
  g.turn = 0;
  g.phase = 'play';
  g.caboCalledBy = null;
  g.finalQueue = [];
  g.draw = null;
  g.power = null;
}

describe('牌库', () => {
  it('52 张：0 和 13 各两张，1~12 各四张', () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(52);
    const count = (r: number) => deck.filter((d) => d.rank === r).length;
    expect(count(0)).toBe(2);
    expect(count(13)).toBe(2);
    for (let r = 1; r <= 12; r++) expect(count(r)).toBe(4);
  });
});

describe('开局', () => {
  it('发牌、弃牌堆与看牌流程', () => {
    const g = twoPlayers();
    expect(g.phase).toBe('peek');
    expect(g.players[0].cards.filter(Boolean)).toHaveLength(4);
    expect(g.players[1].cards.filter(Boolean)).toHaveLength(4);
    expect(g.discard).toHaveLength(1);
    expect(g.deck).toHaveLength(52 - 8 - 1);

    applyAction(g, 'a', { type: 'peek', slots: [0, 3] });
    expect(g.phase).toBe('peek');
    applyAction(g, 'b', { type: 'peek', slots: [2, 1] });
    expect(g.phase).toBe('play');

    const va = viewFor(g, 'a');
    expect(va.players[0].cards[0]).toMatchObject({ hidden: false });
    expect(va.players[0].cards[1]).toMatchObject({ hidden: true });
    expect(va.players[1].cards[2]).toMatchObject({ hidden: true });
  });

  it('不能重复看牌', () => {
    const g = twoPlayers();
    applyAction(g, 'a', { type: 'peek', slots: [0, 3] });
    expect(() => applyAction(g, 'a', { type: 'peek', slots: [1, 2] })).toThrow();
  });
});

describe('回合行动', () => {
  it('摸牌后换入：换下的牌进弃牌堆，回合交给对方', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [4, 10]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    expect(g.draw?.card.rank).toBe(10);
    applyAction(g, 'a', { type: 'swap', slot: 1 });
    expect(g.players[0].cards[1]?.rank).toBe(10);
    expect(g.discard.at(-1)?.rank).toBe(6);
    expect(g.turn).toBe(1);
    expect(g.draw).toBeNull();
  });

  it('从弃牌堆拿牌：该位置变成公开牌', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4]);
    applyAction(g, 'a', { type: 'draw', source: 'discard' });
    expect(() => applyAction(g, 'a', { type: 'discardDrawn' })).toThrow();
    applyAction(g, 'a', { type: 'swap', slot: 2 });
    expect(g.players[0].cards[2]?.rank).toBe(4);
    expect(g.players[0].faceUp[2]).toBe(true);
    const vb = viewFor(g, 'b');
    expect(vb.players[0].cards[2]).toMatchObject({ hidden: false, rank: 4, faceUp: true });
  });

  it('弃掉摸到的牌且不是能力牌 → 直接换人', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [10, 3]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    expect(g.turn).toBe(1);
    expect(g.power).toBeNull();
    expect(g.discard.at(-1)?.rank).toBe(3);
  });

  it('7/8：看自己一张；不换人直到结束', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [10, 7]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    expect(g.power?.kind).toBe('peek');
    applyAction(g, 'a', { type: 'powerPeek', slot: 2 });
    expect(viewFor(g, 'a').players[0].cards[2]).toMatchObject({ hidden: false, rank: 7 });
    expect(g.turn).toBe(1);
  });

  it('9/10：偷看对手一张并记住', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [10, 9]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    expect(g.power?.kind).toBe('spy');
    applyAction(g, 'a', { type: 'powerSpy', target: 'b', slot: 1 });
    const va = viewFor(g, 'a');
    expect(va.players[1].cards[1]).toMatchObject({ hidden: false, rank: 2 });
    // 对手自己反而不知道
    expect(viewFor(g, 'b').players[1].cards[1]).toMatchObject({ hidden: true });
  });

  it('11/12：与对手盲换', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [10, 11]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    expect(g.power?.kind).toBe('swap');
    applyAction(g, 'a', { type: 'powerSwap', target: 'b', ownSlot: 0, targetSlot: 2 });
    expect(g.players[0].cards[0]?.rank).toBe(3);
    expect(g.players[1].cards[2]?.rank).toBe(5);
  });

  it('13：看对手一张后可选择交换', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [10, 13]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    expect(g.power?.kind).toBe('peekSwap');
    applyAction(g, 'a', { type: 'powerPeekSwap', target: 'b', slot: 3 });
    expect(g.power?.kind).toBe('peekSwapDecide');
    applyAction(g, 'a', { type: 'powerPeekSwapDecide', swap: true, ownSlot: 1 });
    expect(g.players[0].cards[1]?.rank).toBe(4);
    expect(g.players[1].cards[3]?.rank).toBe(6);
    expect(g.turn).toBe(1);
  });

  it('13：可以不交换', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [10, 13]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    applyAction(g, 'a', { type: 'powerPeekSwap', target: 'b', slot: 3 });
    applyAction(g, 'a', { type: 'powerPeekSwapDecide', swap: false });
    expect(g.players[0].cards[1]?.rank).toBe(6);
    expect(g.turn).toBe(1);
  });
});

describe('CABO 与结算', () => {
  it('喊 CABO 后每人还有一回合，然后结算', () => {
    const g = twoPlayers();
    fixed(g, [1, 2, 3, 0], [5, 6, 7, 8], [9, 10, 11, 12, 1, 2]);
    applyAction(g, 'a', { type: 'cabo' });
    expect(g.caboCalledBy).toBe(0);
    expect(g.turn).toBe(1);
    applyAction(g, 'b', { type: 'draw', source: 'deck' });
    applyAction(g, 'b', { type: 'discardDrawn' });
    expect(g.phase).toBe('score');
    // A 总和 6 最低 → 0 分；B 得 26 分
    expect(g.players[0].score).toBe(0);
    expect(g.players[1].score).toBe(26);
  });

  it('喊 CABO 但没赢 → 牌面 +10', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 0], [9, 10, 11, 12, 1, 2]);
    applyAction(g, 'a', { type: 'cabo' });
    applyAction(g, 'b', { type: 'draw', source: 'deck' });
    applyAction(g, 'b', { type: 'discardDrawn' });
    expect(g.phase).toBe('score');
    expect(g.players[0].score).toBe(26 + 10);
    expect(g.players[1].score).toBe(6);
  });

  it('并列最低时喊 CABO 者依然 0 分', () => {
    const g = twoPlayers();
    fixed(g, [1, 2, 3, 4], [2, 1, 4, 3], [9, 10, 11, 12, 1, 2]);
    applyAction(g, 'a', { type: 'cabo' });
    applyAction(g, 'b', { type: 'draw', source: 'deck' });
    applyAction(g, 'b', { type: 'discardDrawn' });
    expect(g.players[0].score).toBe(0);
    expect(g.players[1].score).toBe(10);
  });

  it('牌堆抽空立即结算', () => {
    const g = twoPlayers();
    fixed(g, [1, 2, 3, 4], [5, 6, 7, 8], []);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    expect(g.phase).toBe('score');
    expect(g.endReason).toBe('deck');
    // 没有人喊 CABO：两人都按手牌点数计分，不存在“最低者 0 分”
    expect(g.players[0].score).toBe(10);
    expect(g.players[1].score).toBe(26);
  });

  it('恰好 100 分降为 50 分（每人一次）', () => {
    const g = twoPlayers();
    fixed(g, [1, 0, 0, 0], [1, 0, 0, 0], [9, 10, 11, 12, 1, 2]);
    g.players[0].score = 99;
    g.turn = 1;
    applyAction(g, 'b', { type: 'cabo' });
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    expect(g.phase).toBe('score');
    expect(g.players[0].score).toBe(50);
    expect(g.players[0].resetUsed).toBe(true);
  });

  it('超过 100 分游戏结束，总分最低者胜', () => {
    const g = twoPlayers();
    fixed(g, [9, 9, 9, 9], [1, 1, 1, 1], [9, 10, 11, 12, 1, 2]);
    g.players[0].score = 95;
    applyAction(g, 'a', { type: 'cabo' });
    applyAction(g, 'b', { type: 'draw', source: 'deck' });
    applyAction(g, 'b', { type: 'discardDrawn' });
    expect(g.phase).toBe('over');
    expect(g.players[1].score).toBe(4);
    expect(g.winnerSeat).toBe(1);
  });
});

describe('隐藏信息', () => {
  it('对手看不到你的暗牌；弃牌堆顶公开', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4]);
    const view = viewFor(g, 'b');
    expect(view.players[0].cards.every((x) => x!.hidden)).toBe(true);
    expect(view.discardTop).toMatchObject({ rank: 4 });
  });

  it('偷看过的牌在置换后记忆失效', () => {
    const g = twoPlayers();
    fixed(g, [5, 6, 7, 8], [1, 2, 3, 4], [11, 10, 9]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });
    expect(g.power?.kind).toBe('spy');
    applyAction(g, 'a', { type: 'powerSpy', target: 'b', slot: 0 });
    expect(viewFor(g, 'a').players[1].cards[0]).toMatchObject({ rank: 1 });
    // B 把自己的第 0 张换掉
    applyAction(g, 'b', { type: 'draw', source: 'deck' });
    applyAction(g, 'b', { type: 'swap', slot: 0 });
    expect(viewFor(g, 'a').players[1].cards[0]).toMatchObject({ hidden: true });
  });
});
