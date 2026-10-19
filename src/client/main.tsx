import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { socket } from './socket';
import type { Action, CardView, GameView, PlayerView } from '../shared/game';
import './styles.css';

interface RoomInfo {
  code: string;
  hostId: string;
  seats: { id: string; name: string; connected: boolean }[];
  started: boolean;
}
interface Snapshot {
  room: RoomInfo;
  game: GameView | null;
  you: string;
}
interface Identity {
  code: string;
  playerId: string;
  token: string;
  name: string;
}

const ID_KEY = 'cabo.identity.v1';
const NAME_KEY = 'cabo.name.v1';

function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(ID_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}
function saveIdentity(id: Identity | null) {
  if (id) localStorage.setItem(ID_KEY, JSON.stringify(id));
  else localStorage.removeItem(ID_KEY);
}

// ---------------- 小部件 ----------------

function rankTone(rank: number) {
  if (rank <= 2) return 'low';
  if (rank <= 6) return 'mid';
  if (rank <= 9) return 'high';
  if (rank === 13) return 'special';
  return 'top';
}

function CardBox(props: {
  card: CardView | null | undefined;
  small?: boolean;
  onClick?: () => void;
  selected?: boolean;
  dim?: boolean;
  hint?: string;
  disabled?: boolean;
  tag?: boolean;
}) {
  const { card, small, onClick, selected, dim, hint, disabled, tag = true } = props;
  const cls = ['card'];
  if (small) cls.push('small');
  if (selected) cls.push('selected');
  if (dim) cls.push('dim');
  if (onClick && !disabled) cls.push('clickable');

  if (!card) return <div className={cls.join(' ')} data-empty="1" />;

  if (card.hidden) {
    return (
      <div className={cls.join(' ')} onClick={disabled ? undefined : onClick}>
        <span className="backmark">✦</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
    );
  }
  return (
    <div
      className={[...cls, 'face', `tone-${rankTone(card.rank!)}`].join(' ')}
      onClick={disabled ? undefined : onClick}
    >
      <span className="rank">{card.rank}</span>
      {tag ? (card.faceUp ? <span className="pub">公开</span> : <span className="mem">记</span>) : null}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

// ---------------- 主应用 ----------------

function App() {
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [memoryAid, setMemoryAid] = useState(true);

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      const saved = loadIdentity();
      if (saved && !snapshot) {
        socket.emit('resume', saved, (res: any) => {
          if (res?.ok) {
            const id = { ...saved, name: res.name };
            saveIdentity(id);
            setIdentity(id);
          } else {
            saveIdentity(null);
            setIdentity(null);
            setToast(res?.error || '重连失败');
          }
        });
      }
    };
    const onDisconnect = () => setConnected(false);
    const onState = (s: Snapshot) => setSnapshot(s);
    const onKicked = () => {
      saveIdentity(null);
      setIdentity(null);
      setSnapshot(null);
      setToast('你的连接已在别处打开');
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state', onState);
    socket.on('kicked', onKicked);
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state', onState);
      socket.off('kicked', onKicked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const inRoom = !!snapshot && !!identity && snapshot.room.seats.some((s) => s.id === identity.playerId);

  return (
    <div className="app">
      {!identity || !inRoom ? (
        <Home
          connected={connected}
          onEnter={(id, snap) => {
            saveIdentity(id);
            setIdentity(id);
            setSnapshot(snap);
          }}
          onError={showToast}
        />
      ) : !snapshot!.game ? (
        <Lobby snapshot={snapshot!} onError={showToast} onLeave={() => { saveIdentity(null); setIdentity(null); setSnapshot(null); }} />
      ) : (
        <Table
          snapshot={snapshot!}
          memoryAid={memoryAid}
          onToggleMemory={() => setMemoryAid((v) => !v)}
          onError={showToast}
          onLeave={() => { saveIdentity(null); setIdentity(null); setSnapshot(null); }}
        />
      )}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

// ---------------- 首页 ----------------

function Home(props: {
  connected: boolean;
  onEnter: (id: Identity, snap: Snapshot | null) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'menu' | 'join'>('menu');
  const [busy, setBusy] = useState(false);

  const remember = (n: string) => localStorage.setItem(NAME_KEY, n);

  const create = () => {
    const n = name.trim() || '玩家';
    remember(n);
    setBusy(true);
    socket.emit('create', { name: n }, (res: any) => {
      setBusy(false);
      if (!res?.ok) return props.onError(res?.error || '创建失败');
      props.onEnter({ code: res.code, playerId: res.playerId, token: res.token, name: n }, null);
    });
  };

  const join = () => {
    const n = name.trim() || '玩家';
    remember(n);
    const c = code.trim().toUpperCase();
    if (!c) return props.onError('请输入房间号');
    setBusy(true);
    socket.emit('join', { code: c, name: n }, (res: any) => {
      setBusy(false);
      if (!res?.ok) return props.onError(res?.error || '加入失败');
      props.onEnter({ code: res.code, playerId: res.playerId, token: res.token, name: n }, null);
    });
  };

  return (
    <div className="home">
      <div className="brand">
        <div className="logo">CABO</div>
        <p className="tagline">卡波 · 双人联机 · 手机即开即玩</p>
      </div>

      <label className="field">
        <span>你的名字</span>
        <input
          value={name}
          maxLength={12}
          placeholder="给自己起个名"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      {mode === 'menu' ? (
        <div className="stack">
          <button className="btn primary" disabled={busy || !props.connected} onClick={create}>
            创建房间
          </button>
          <button className="btn" disabled={busy || !props.connected} onClick={() => setMode('join')}>
            输入房间号加入
          </button>
        </div>
      ) : (
        <div className="stack">
          <label className="field">
            <span>房间号</span>
            <input
              className="code-input"
              value={code}
              maxLength={4}
              placeholder="4 位字母数字"
              autoCapitalize="characters"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
          <button className="btn primary" disabled={busy || !props.connected} onClick={join}>
            进入房间
          </button>
          <button className="btn ghost" onClick={() => setMode('menu')}>
            返回
          </button>
        </div>
      )}

      <p className="footnote">
        {props.connected ? '已连接服务器' : '正在连接服务器…'}
      </p>
      <div className="rules-link">
        <details>
          <summary>玩法速览</summary>
          <ul>
            <li>每人 4 张暗牌，开局可看其中 2 张，之后靠记忆。</li>
            <li>回合：摸一张 → 换进手里，或弃掉并用它的能力（7/8 看牌、9/10 偷看、11/12 盲换、13 看后换）。</li>
            <li>也可以直接拿弃牌堆顶换入（该牌始终公开）。</li>
            <li>觉得自己的牌够小就喊 CABO：别人各走一回合后结算。喊错 +10 分。</li>
            <li>累计超过 100 分结束，总分最低者胜。</li>
          </ul>
        </details>
      </div>
    </div>
  );
}

// ----------------  lobby ----------------

function Lobby(props: { snapshot: Snapshot; onError: (m: string) => void; onLeave: () => void }) {
  const { room, you } = props.snapshot;
  const isHost = room.hostId === you;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      props.onError('复制失败，请手动记下房间号');
    }
  };

  return (
    <div className="lobby">
      <p className="label">房间号</p>
      <button className="code-big" onClick={copy}>
        {room.code}
        <span className="copy-tip">{copied ? '已复制' : '点击复制'}</span>
      </button>
      <p className="hintline">把这 4 位发给朋友，让 TA 输入加入。</p>

      <ul className="seats">
        {room.seats.map((s) => (
          <li key={s.id}>
            <span className={`dot ${s.connected ? 'on' : 'off'}`} />
            {s.name}
            {s.id === room.hostId ? <em>房主</em> : null}
            {s.id === you ? <em>我</em> : null}
          </li>
        ))}
        {room.seats.length < 2 ? <li className="waiting">等待对手加入…</li> : null}
      </ul>

      <div className="stack">
        {isHost ? (
          <button
            className="btn primary"
            disabled={room.seats.length < 2}
            onClick={() =>
              socket.emit('start', {}, (res: any) => {
                if (!res?.ok) props.onError(res?.error || '开始失败');
              })
            }
          >
            开始游戏
          </button>
        ) : (
          <p className="hintline center">等房主开始…</p>
        )}
        <button className="btn ghost" onClick={props.onLeave}>
          离开房间
        </button>
      </div>
    </div>
  );
}

// ---------------- 牌桌 ----------------

function Table(props: {
  snapshot: Snapshot;
  memoryAid: boolean;
  onToggleMemory: () => void;
  onError: (m: string) => void;
  onLeave: () => void;
}) {
  const { room, game, you } = props.snapshot;
  const g = game!;
  const me = g.players.find((p) => p.id === you)!;
  const others = g.players.filter((p) => p.id !== you);
  const isMyTurn = g.turn === you;
  const [peekSel, setPeekSel] = useState<number[]>([]);
  const [ownSel, setOwnSel] = useState<number | null>(null);
  const [powerTarget, setPowerTarget] = useState<{ player: string; slot: number } | null>(null);

  useEffect(() => {
    setPeekSel([]);
    setOwnSel(null);
    setPowerTarget(null);
  }, [g.phase, g.turn, g.draw, g.power?.kind]);

  const act = (action: Action) => {
    socket.emit('action', { action }, (res: any) => {
      if (!res?.ok) props.onError(res?.error || '操作失败');
    });
  };

  const vis = (card: CardView | null | undefined): CardView | null | undefined => {
    if (!card) return card;
    if (props.memoryAid) return card;
    return { ...card, hidden: card.hidden || !card.faceUp };
  };

  const clickOwn = (slot: number) => {
    if (g.phase === 'peek') {
      if (peekSel.includes(slot)) setPeekSel(peekSel.filter((s) => s !== slot));
      else if (peekSel.length < 2) setPeekSel([...peekSel, slot]);
      return;
    }
    if (!isMyTurn) return;
    if (g.draw) {
      act({ type: 'swap', slot });
      return;
    }
    if (g.power?.kind === 'peek') {
      act({ type: 'powerPeek', slot });
      return;
    }
    if (g.power?.kind === 'peekSwapDecide') {
      act({ type: 'powerPeekSwapDecide', swap: true, ownSlot: slot });
      return;
    }
    if (g.power?.kind === 'swap') {
      setOwnSel(slot);
      return;
    }
  };

  const clickOther = (player: PlayerView, slot: number) => {
    if (!isMyTurn) return;
    if (g.power?.kind === 'spy') {
      act({ type: 'powerSpy', target: player.id, slot });
      return;
    }
    if (g.power?.kind === 'peekSwap') {
      act({ type: 'powerPeekSwap', target: player.id, slot });
      return;
    }
    if (g.power?.kind === 'swap' && ownSel !== null) {
      act({ type: 'powerSwap', target: player.id, ownSlot: ownSel, targetSlot: slot });
      setOwnSel(null);
      return;
    }
  };

  const canAct = g.phase === 'play' && isMyTurn;

  const statusText = (() => {
    if (g.phase === 'peek') return '先记住你自己的两张牌';
    if (g.phase === 'score') return '本轮结束';
    if (g.phase === 'over') return '游戏结束';
    if (!isMyTurn) return `等待 ${g.players.find((p) => p.id === g.turn)?.name} 行动…`;
    if (g.draw) return '选择一张自己的牌换入，或弃掉摸到的牌';
    if (g.power?.kind === 'peek') return '点自己的一张牌查看';
    if (g.power?.kind === 'spy') return '点对手的一张牌偷看';
    if (g.power?.kind === 'swap') return ownSel === null ? '先点自己的一张牌' : '再点对手的一张牌交换';
    if (g.power?.kind === 'peekSwap') return '点对手的一张牌查看';
    if (g.power?.kind === 'peekSwapDecide') return '要换吗？点自己一张牌交换，或选择不换';
    return '你的回合';
  })();

  const over = g.phase === 'score' || g.phase === 'over';

  return (
    <div className="table">
      <header className="topbar">
        <div className="roomtag">房 {room.code}</div>
        <div className="roundtag">第 {g.round} 轮</div>
        <div className="scores">
          {g.players.map((p) => (
            <span key={p.id} className={p.id === you ? 'myscore' : ''}>
              {p.name} {p.score}
            </span>
          ))}
        </div>
        <button className="iconbtn" onClick={props.onToggleMemory} title="记忆提示">
          {props.memoryAid ? '记' : '盲'}
        </button>
      </header>

      <section className="opponents">
        {others.map((p) => (
          <div key={p.id} className={`opponent ${g.turn === p.id ? 'active' : ''}`}>
            <div className="opphead">
              <span className="pname">
                {p.name}
                {p.isCaboCaller ? <em className="cabo-tag">CABO</em> : null}
                {!p.connected ? <em className="offline-tag">离线</em> : null}
              </span>
              <span className="pscore">{p.score} 分</span>
            </div>
            <div className="cardrow small">
              {p.cards.map((c, i) => (
                <CardBox
                  key={i}
                  small
                  card={vis(c)}
                  onClick={canAct && (g.power?.kind === 'spy' || g.power?.kind === 'peekSwap' || (g.power?.kind === 'swap' && ownSel !== null)) ? () => clickOther(p, i) : undefined}
                  selected={powerTarget?.player === p.id && powerTarget?.slot === i}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="center">
        <button
          className="pile deck"
          disabled={!canAct || !!g.draw || !!g.power}
          onClick={() => act({ type: 'draw', source: 'deck' })}
        >
          <span className="pcount">{g.deckCount}</span>
          <span className="plabel">摸牌堆</span>
        </button>
        <div className="pile discard">
          {g.discardTop ? (
            <CardBox tag={false} card={{ hidden: false, rank: g.discardTop.rank, faceUp: true }} />
          ) : (
            <div className="card empty" />
          )}
          <button
            className="take-discard"
            disabled={!canAct || !!g.draw || !!g.power}
            onClick={() => act({ type: 'draw', source: 'discard' })}
          >
            拿弃牌
          </button>
        </div>
        {g.draw ? (
          <div className="drawbox">
            <span className="dlabel">{g.draw.source === 'deck' ? '你摸到' : '你拿到'}</span>
            <CardBox tag={false} card={{ hidden: false, rank: g.draw.rank, faceUp: true }} />
            {g.draw.source === 'deck' ? (
              <button className="btn tiny" onClick={() => act({ type: 'discardDrawn' })}>
                弃掉
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="myside">
        <div className={`me ${isMyTurn ? 'active' : ''}`}>
          <div className="opphead">
            <span className="pname">{me.name}（我）</span>
            <span className="pscore">{me.score} 分</span>
          </div>
          <div className="cardrow">
            {me.cards.map((c, i) => (
              <CardBox
                key={i}
                card={vis(c)}
                selected={peekSel.includes(i) || ownSel === i || (powerTarget?.player === me.id && powerTarget?.slot === i)}
                onClick={
                  g.phase === 'peek'
                    ? () => clickOwn(i)
                    : canAct && (g.draw || g.power?.kind === 'peek' || g.power?.kind === 'swap' || g.power?.kind === 'peekSwapDecide')
                    ? () => clickOwn(i)
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      </section>

      <footer className="actions">
        <div className="status">{statusText}</div>
        {g.phase === 'peek' ? (
          <button
            className="btn primary"
            disabled={peekSel.length !== 2}
            onClick={() => act({ type: 'peek', slots: [peekSel[0], peekSel[1]] })}
          >
            确认记住这两张
          </button>
        ) : canAct ? (
          <div className="actionrow">
            {g.power ? (
              <button className="btn" onClick={() => act({ type: 'skipPower' })} disabled={g.power.kind === 'peekSwapDecide'}>
                不用能力
              </button>
            ) : null}
            {g.power?.kind === 'peekSwapDecide' ? (
              <button className="btn" onClick={() => act({ type: 'powerPeekSwapDecide', swap: false })}>
                不交换
              </button>
            ) : null}
            {!g.draw && !g.power ? (
              <button className="btn warn" onClick={() => act({ type: 'cabo' })}>
                喊 CABO
              </button>
            ) : null}
          </div>
        ) : null}
        <details className="logbox">
          <summary>对局记录</summary>
          <ul>
            {g.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      </footer>

      {over ? (
        <div className="overlay">
          <div className="panel">
            <h2>{g.phase === 'over' ? '游戏结束' : '本轮结算'}</h2>
            {g.phase === 'over' ? (
              <p className="winner">
                🏆 {g.players.find((p) => p.id === g.winner)?.name} 总分最低，获胜！
              </p>
            ) : null}
            <table className="scoretable">
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>本轮</th>
                  <th>本轮得分</th>
                  <th>总分</th>
                </tr>
              </thead>
              <tbody>
                {g.players.map((p) => (
                  <tr key={p.id} className={p.id === you ? 'me-row' : ''}>
                    <td>
                      {p.name}
                      {p.isCaboCaller ? ' (CABO)' : ''}
                    </td>
                    <td>
                      <div className="minicards">
                        {p.cards.map((c, i) => (
                          <span key={i} className={`mini tone-${rankTone(c?.rank ?? 0)}`}>
                            {c?.rank ?? '?'}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className={p.gain === 0 ? 'zero' : ''}>+{p.gain ?? 0}</td>
                    <td>{p.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {room.hostId === you ? (
              <button
                className="btn primary"
                onClick={() =>
                  socket.emit(g.phase === 'over' ? 'restart' : 'nextRound', {}, (res: any) => {
                    if (!res?.ok) props.onError(res?.error || '开下一轮失败');
                  })
                }
              >
                {g.phase === 'over' ? '再来一局' : '开下一轮'}
              </button>
            ) : (
              <p className="hintline center">等房主开下一轮…</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
