import express from 'express';
import http from 'http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import {
  applyAction,
  createGame,
  nextRound,
  RuleError,
  viewFor,
  type Action,
  type Game,
} from '../src/shared/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);

interface Seat {
  id: string;
  name: string;
  token: string;
  socketId: string | null;
  connected: boolean;
}

interface Room {
  code: string;
  hostId: string;
  seats: Seat[];
  game: Game | null;
  createdAt: number;
  lastActivity: number;
}

const rooms = new Map<string, Room>();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++)
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}
function token(): string {
  return randomBytes(18).toString('base64url');
}

function touch(room: Room) {
  room.lastActivity = Date.now();
}

function publicRoom(room: Room) {
  return {
    code: room.code,
    hostId: room.hostId,
    seats: room.seats.map((s) => ({ id: s.id, name: s.name, connected: s.connected })),
    started: !!room.game,
  };
}

function emitState(io: Server, room: Room) {
  touch(room);
  for (const seat of room.seats) {
    if (!seat.socketId) continue;
    io.to(seat.socketId).emit('state', {
      room: publicRoom(room),
      game: room.game ? viewFor(room.game, seat.id) : null,
      you: seat.id,
    });
  }
}

function seatOf(room: Room, socketId: string | undefined): Seat | undefined {
  return room.seats.find((s) => s.socketId === socketId);
}

function roomOfSocket(socket: Socket): Room | undefined {
  for (const room of rooms.values()) {
    if (room.seats.some((s) => s.socketId === socket.id)) return room;
  }
  return undefined;
}

// ---------- HTTP ----------

const app = express();
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const clientDir = path.resolve(__dirname, '../dist/client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir, { maxAge: '1h', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io') || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Socket.IO ----------

io.on('connection', (socket) => {
  socket.on('create', (payload: { name?: string }, cb?: (r: any) => void) => {
    const name = String(payload?.name || '玩家').slice(0, 12);
    const code = newCode();
    const id = `p_${randomBytes(6).toString('hex')}`;
    const seat: Seat = {
      id,
      name,
      token: token(),
      socketId: socket.id,
      connected: true,
    };
    const room: Room = {
      code,
      hostId: id,
      seats: [seat],
      game: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    cb?.({ ok: true, code, playerId: id, token: seat.token, name });
    emitState(io, room);
  });

  socket.on(
    'join',
    (payload: { code?: string; name?: string }, cb?: (r: any) => void) => {
      const code = String(payload?.code || '').trim().toUpperCase();
      const name = String(payload?.name || '玩家').slice(0, 12);
      const room = rooms.get(code);
      if (!room) return cb?.({ ok: false, error: '房间不存在，检查房间号' });
      if (room.game) return cb?.({ ok: false, error: '这局已经开始了' });
      if (room.seats.length >= 2) return cb?.({ ok: false, error: '房间已满（本作是 1v1）' });
      const id = `p_${randomBytes(6).toString('hex')}`;
      const seat: Seat = {
        id,
        name,
        token: token(),
        socketId: socket.id,
        connected: true,
      };
      room.seats.push(seat);
      socket.join(code);
      touch(room);
      cb?.({ ok: true, code, playerId: id, token: seat.token, name });
      emitState(io, room);
    },
  );

  socket.on(
    'resume',
    (payload: { code?: string; playerId?: string; token?: string }, cb?: (r: any) => void) => {
      const code = String(payload?.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return cb?.({ ok: false, error: '房间已过期' });
      const seat = room.seats.find((s) => s.id === payload?.playerId && s.token === payload?.token);
      if (!seat) return cb?.({ ok: false, error: '身份校验失败' });
      // 顶掉旧连接
      if (seat.socketId && seat.socketId !== socket.id) {
        io.to(seat.socketId).emit('kicked');
      }
      seat.socketId = socket.id;
      seat.connected = true;
      if (room.game) {
        const p = room.game.players.find((x) => x.id === seat.id);
        if (p) p.connected = true;
      }
      socket.join(code);
      touch(room);
      cb?.({ ok: true, code, playerId: seat.id, token: seat.token, name: seat.name });
      emitState(io, room);
    },
  );

  socket.on('start', (payload: unknown, cb?: (r: any) => void) => {
    const room = roomOfSocket(socket);
    if (!room) return cb?.({ ok: false, error: '不在房间里' });
    const seat = seatOf(room, socket.id)!;
    if (seat.id !== room.hostId) return cb?.({ ok: false, error: '只有房主能开始' });
    if (room.game) return cb?.({ ok: false, error: '已经开始' });
    if (room.seats.length < 2) return cb?.({ ok: false, error: '至少需要 2 人' });
    try {
      room.game = createGame(room.seats.map((s) => ({ id: s.id, name: s.name })));
      for (const s of room.seats) s.connected = true;
      emitState(io, room);
      cb?.({ ok: true });
    } catch (e: any) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('action', (payload: { action: Action }, cb?: (r: any) => void) => {
    const room = roomOfSocket(socket);
    if (!room?.game) return cb?.({ ok: false, error: '没有进行中的对局' });
    const seat = seatOf(room, socket.id)!;
    try {
      applyAction(room.game, seat.id, payload.action);
      emitState(io, room);
      cb?.({ ok: true });
    } catch (e: any) {
      if (e instanceof RuleError) return cb?.({ ok: false, error: e.message });
      console.error(e);
      cb?.({ ok: false, error: '服务器错误' });
    }
  });

  socket.on('nextRound', (payload: unknown, cb?: (r: any) => void) => {
    const room = roomOfSocket(socket);
    if (!room?.game) return cb?.({ ok: false, error: '没有对局' });
    const seat = seatOf(room, socket.id)!;
    if (seat.id !== room.hostId) return cb?.({ ok: false, error: '只有房主能开下一轮' });
    try {
      if (room.game.phase === 'score') nextRound(room.game);
      else if (room.game.phase === 'over') {
        // 重开一局
        room.game = createGame(room.seats.map((s) => ({ id: s.id, name: s.name })));
      } else return cb?.({ ok: false, error: '还没到结算' });
      emitState(io, room);
      cb?.({ ok: true });
    } catch (e: any) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('restart', (payload: unknown, cb?: (r: any) => void) => {
    const room = roomOfSocket(socket);
    if (!room) return cb?.({ ok: false, error: '不在房间里' });
    const seat = seatOf(room, socket.id)!;
    if (seat.id !== room.hostId) return cb?.({ ok: false, error: '只有房主能重开' });
    room.game = createGame(room.seats.map((s) => ({ id: s.id, name: s.name })));
    emitState(io, room);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = roomOfSocket(socket);
    if (!room) return;
    const seat = seatOf(room, socket.id);
    if (seat) {
      seat.connected = false;
      seat.socketId = null;
      if (room.game) {
        const p = room.game.players.find((x) => x.id === seat.id);
        if (p) p.connected = false;
      }
    }
    emitState(io, room);
  });
});

// 清理空房间
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivity;
    const empty = room.seats.every((s) => !s.connected);
    if (idle > 3 * 3600_000 || (empty && idle > 30 * 60_000)) rooms.delete(code);
  }
}, 10 * 60_000);

server.listen(PORT, () => {
  console.log(`CABO server listening on http://localhost:${PORT}`);
});
