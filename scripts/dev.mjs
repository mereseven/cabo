// 一条命令同时起服务端（8080）和 Vite 开发服务器（5173）。
// 浏览器打开 http://localhost:5173 ，/socket.io 会代理到 8080。
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const procs = [];
let shuttingDown = false;

function run(name, args, env = {}) {
  const p = spawn(npx, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    shell: false,
  });
  procs.push(p);
  const prefix = `[${name}]`;
  const pipe = (stream, out) =>
    stream.on('data', (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) out.write(`${prefix} ${line}\n`);
      }
    });
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix} 进程退出 code=${code}`);
    if (!shuttingDown) shutdown(code ?? 0);
  });
  return p;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    if (!p.killed) p.kill();
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('CABO 开发模式启动中…\n  浏览器打开: http://localhost:5173\n');
run('server', ['tsx', 'watch', 'server/index.ts']);
run('client', ['vite']);
