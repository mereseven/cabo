import { io } from 'socket.io-client';

export const socket = io({
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});
