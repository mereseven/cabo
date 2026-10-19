import { describe, expect, it } from 'vitest';
import { applyAction, createGame, viewFor, type Card, type Game } from '../src/shared/game';

let n = 0;
const c = (rank: number): Card => ({ id: `r${n++}`, rank });

function twoPlayers(): Game {
  return createGame([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]);
}

function fixed(g: Game, a: number[], b: number[], deck: number[]) {
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

describe('信息裁剪', () => {
  it('摸到的牌只给行动者看', () => {
    const g = twoPlayers();
    fixed(g, [5, 5, 5, 5], [6, 6, 6, 6], [1, 9]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });

    expect(viewFor(g, 'a').draw).toEqual({ rank: 9, source: 'deck' });
    expect(viewFor(g, 'b').draw).toBeNull();
  });

  it('能力选择状态也只给行动者看', () => {
    const g = twoPlayers();
    fixed(g, [5, 5, 5, 5], [6, 6, 6, 6], [1, 9]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'discardDrawn' });

    expect(g.power?.kind).toBe('spy');
    expect(viewFor(g, 'a').power?.kind).toBe('spy');
    expect(viewFor(g, 'b').power).toBeNull();
  });

  it('从牌堆换入的牌自己记得，对手不可见', () => {
    const g = twoPlayers();
    fixed(g, [5, 5, 5, 5], [6, 6, 6, 6], [1, 9]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'swap', slot: 2 });

    const mine = viewFor(g, 'a');
    expect(mine.players[0].cards[2]?.hidden).toBe(false);
    expect(mine.players[0].cards[2]?.rank).toBe(9);

    const theirs = viewFor(g, 'b');
    expect(theirs.players[0].cards[2]?.hidden).toBe(true);
    expect(theirs.players[0].cards[2]?.rank).toBeUndefined();
  });

  it('弃牌堆顶对双方始终公开', () => {
    const g = twoPlayers();
    fixed(g, [5, 5, 5, 5], [6, 6, 6, 6], [1, 9]);
    applyAction(g, 'a', { type: 'draw', source: 'deck' });
    applyAction(g, 'a', { type: 'swap', slot: 0 });

    expect(viewFor(g, 'a').discardTop?.rank).toBe(5);
    expect(viewFor(g, 'b').discardTop?.rank).toBe(5);
  });

  it('从弃牌堆拿的牌换入后保持公开', () => {
    const g = twoPlayers();
    fixed(g, [5, 5, 5, 5], [6, 6, 6, 6], [1, 9]);
    g.discard = [c(2)];

    applyAction(g, 'a', { type: 'draw', source: 'discard' });
    applyAction(g, 'a', { type: 'swap', slot: 1 });

    const asB = viewFor(g, 'b');
    expect(asB.players[0].cards[1]).toEqual({ hidden: false, rank: 2, faceUp: true });
  });
});
