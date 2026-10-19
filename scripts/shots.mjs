// 用本机 Edge 跑两个页面，截几张图检查移动端布局。
// 用法: node scripts/shots.mjs [baseUrl]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 8077;
const BASE = process.argv[2] || `http://127.0.0.1:${PORT}`;
const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

let server;
if (!process.argv[2]) {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await sleep(1800);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const A = await ctxA.newPage();
const B = await ctxB.newPage();

const shot = async (page, name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('📸', `${OUT}/${name}.png`);
};

try {
  await A.goto(BASE);
  await A.waitForSelector('.logo');
  await shot(A, '1-home');

  await A.getByPlaceholder('给自己起个名').fill('小明');
  await A.getByRole('button', { name: '创建房间' }).click();
  await A.waitForSelector('.code-big');
  const code = (await A.locator('.code-big').innerText()).trim().slice(0, 4);
  console.log('房间号', code);
  await shot(A, '2-lobby');

  await B.goto(BASE);
  await B.getByPlaceholder('给自己起个名').fill('小红');
  await B.getByRole('button', { name: '输入房间号加入' }).click();
  await B.getByPlaceholder('4 位字母数字').fill(code);
  await B.getByRole('button', { name: '进入房间' }).click();
  await B.waitForSelector('.code-big');

  await A.waitForSelector('.seats li:nth-child(2)');
  await A.getByRole('button', { name: '开始游戏' }).click();

  // 看牌阶段
  await A.waitForSelector('text=先记住你自己的两张牌');
  await shot(A, '3-peek');
  for (const p of [A, B]) {
    await p.locator('.myside .card').nth(0).click();
    await p.locator('.myside .card').nth(1).click();
    await p.getByRole('button', { name: '确认记住这两张' }).click();
    await p.waitForTimeout(300);
  }

  // 对局阶段
  await A.waitForSelector('text=你的回合');
  await shot(A, '4-table');

  // 摸一张牌，展示换牌阶段
  await A.locator('.pile.deck').click();
  await A.waitForSelector('.drawbox');
  await shot(A, '5-draw');

  // 换入，让对手看到等待状态
  await A.locator('.myside .card').nth(0).click();
  await B.waitForTimeout(500);
  await shot(B, '6-waiting');

  // 一路换牌直到牌堆耗尽/有人喊 CABO，截结算面板
  for (let round = 0; round < 120; round++) {
    if ((await A.locator('.overlay').count()) > 0) break;
    const actor = (await A.locator('.me.active').count()) > 0 ? A : (await B.locator('.me.active').count()) > 0 ? B : null;
    if (!actor) {
      await A.waitForTimeout(150);
      continue;
    }
    const deck = actor.locator('.pile.deck');
    if (await deck.isEnabled()) {
      await deck.click();
      await actor.waitForSelector('.drawbox', { timeout: 3000 }).catch(() => {});
      if ((await actor.locator('.drawbox').count()) > 0) {
        await actor.locator('.myside .card').nth(0).click();
      }
    }
    await A.waitForTimeout(120);
  }
  await A.waitForSelector('.overlay', { timeout: 5000 });
  await shot(A, '7-score');
} finally {
  await browser.close();
  server?.kill();
}
