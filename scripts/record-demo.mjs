import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('video_assets');
const timeline = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'timeline.json'), 'utf8'));

// Helper to inject a visual glowing mouse pointer
async function setupCursor(page) {
  await page.addStyleTag({
    content: `
      #demo-cursor {
        position: fixed;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: rgba(99, 102, 241, 0.45);
        border: 2px solid rgba(255, 255, 255, 0.9);
        box-shadow: 0 0 16px rgba(99, 102, 241, 0.8), 0 0 6px rgba(255,255,255,0.8);
        pointer-events: none;
        z-index: 999999;
        transition: transform 0.08s ease-out, background 0.15s ease;
        transform: translate(-50%, -50%);
      }
      #demo-cursor.clicking {
        transform: translate(-50%, -50%) scale(0.7);
        background: rgba(236, 72, 153, 0.8);
      }
    `
  });

  await page.evaluate(() => {
    const cur = document.createElement('div');
    cur.id = 'demo-cursor';
    cur.style.left = '960px';
    cur.style.top = '540px';
    document.body.appendChild(cur);

    window.moveDemoCursor = (x, y) => {
      cur.style.left = `${x}px`;
      cur.style.top = `${y}px`;
    };
    window.clickDemoCursor = (clicking) => {
      if (clicking) cur.classList.add('clicking');
      else cur.classList.remove('clicking');
    };
  });
}

async function smoothMove(page, targetX, targetY, steps = 18) {
  const curPos = await page.evaluate(() => {
    const c = document.getElementById('demo-cursor');
    return { x: parseFloat(c.style.left) || 960, y: parseFloat(c.style.top) || 540 };
  });

  for (let i = 1; i <= steps; i++) {
    const x = curPos.x + (targetX - curPos.x) * (i / steps);
    const y = curPos.y + (targetY - curPos.y) * (i / steps);
    await page.evaluate(({ x, y }) => window.moveDemoCursor(x, y), { x, y });
    await page.waitForTimeout(16);
  }
}

async function smoothScroll(page, targetY, durationMs = 800) {
  const startY = await page.evaluate(() => window.scrollY);
  const steps = Math.max(10, Math.round(durationMs / 20));
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
    const y = startY + (targetY - startY) * ease;
    await page.evaluate((val) => window.scrollTo(0, val), y);
    await page.waitForTimeout(20);
  }
}

async function record() {
  console.log('Launching browser for video recording at 1920x1080...');
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: OUT_DIR,
      size: { width: 1920, height: 1080 },
    },
  });

  const page = await context.newPage();
  const startTime = Date.now();

  const getElapsed = () => (Date.now() - startTime) / 1000;
  const waitUntilTime = async (targetSec) => {
    const cur = getElapsed();
    const remaining = (targetSec - cur) * 1000;
    if (remaining > 0) {
      await page.waitForTimeout(remaining);
    }
  };

  // ================= SCENE 1: Intro & Problem =================
  console.log('[Scene 1] Intro & Problem (0.0s - 22.4s)');
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await setupCursor(page);
  await page.waitForTimeout(2000);

  // Smooth scroll down to pillars
  await smoothScroll(page, 580, 1500);
  await smoothMove(page, 450, 480, 20); // hover Discovery
  await page.waitForTimeout(1800);
  await smoothMove(page, 800, 480, 20); // hover Access
  await page.waitForTimeout(1800);
  await smoothMove(page, 1150, 480, 20); // hover Usability
  await page.waitForTimeout(1800);
  await smoothMove(page, 1500, 480, 20); // hover Payments
  await page.waitForTimeout(2000);

  // Scroll down to What Breaks section
  await smoothScroll(page, 1250, 1400);
  await page.waitForTimeout(3000);

  // Scroll back to top form
  await smoothScroll(page, 0, 1200);
  await waitUntilTime(timeline.scenes[0].end);

  // ================= SCENE 2: Submission & Real-time Evaluation =================
  console.log('[Scene 2] Submission & Live Evaluation (23.2s - 39.2s)');
  const inputBounds = await page.locator('#url').boundingBox();
  if (inputBounds) {
    await smoothMove(page, inputBounds.x + 120, inputBounds.y + inputBounds.height / 2, 20);
    await page.evaluate(() => window.clickDemoCursor(true));
    await page.waitForTimeout(120);
    await page.evaluate(() => window.clickDemoCursor(false));
    await page.fill('#url', '');
    
    // Type target with realistic keystrokes
    const targetUrl = 'https://buffer.com';
    for (const ch of targetUrl) {
      await page.type('#url', ch, { delay: 65 });
    }
  }

  // Click Audit button
  const btnBounds = await page.locator('button[type="submit"]').boundingBox();
  if (btnBounds) {
    await smoothMove(page, btnBounds.x + btnBounds.width / 2, btnBounds.y + btnBounds.height / 2, 16);
    await page.evaluate(() => window.clickDemoCursor(true));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.clickDemoCursor(false));
    await page.click('button[type="submit"]');
  }

  // Wait for redirect to /report/:id
  await page.waitForURL(/\/report\/a[0-9a-f]{12}/, { timeout: 10000 });
  await setupCursor(page);
  console.log('Progress page loaded:', page.url());

  // Watch progress bar and log stream
  await smoothMove(page, 960, 280, 25); // hover over progress bar
  await page.waitForTimeout(2500);
  await smoothMove(page, 960, 480, 20); // hover over logs
  await page.waitForTimeout(2500);

  await waitUntilTime(timeline.scenes[1].end);

  // ================= SCENE 3: Deep Browser Agent Tasks =================
  console.log('[Scene 3] Deep Browser Tasks (40.0s - 53.1s)');
  // Focus on the live log steps showing Chromium agent tasks
  await smoothScroll(page, 140, 800);
  await smoothMove(page, 850, 420, 20);
  await page.waitForTimeout(3000);
  await smoothMove(page, 850, 520, 20);
  await page.waitForTimeout(3000);

  await waitUntilTime(timeline.scenes[2].end);

  // ================= SCENE 4: Results Dashboard & Scoring =================
  console.log('[Scene 4] Results Dashboard & Scoring (54.0s - 68.4s)');
  // Navigate directly to completed buffer report
  await page.goto('http://localhost:3000/report/a5b64097fc98f', { waitUntil: 'networkidle' });
  await setupCursor(page);
  await page.waitForTimeout(1000);

  // Highlight score orb
  await smoothMove(page, 380, 260, 25);
  await page.waitForTimeout(2500);

  // Highlight coverage bar
  await smoothMove(page, 960, 440, 25);
  await page.waitForTimeout(2500);

  // Scroll to Categories section
  await smoothScroll(page, 580, 1000);
  await smoothMove(page, 400, 360, 20); // Discovery
  await page.waitForTimeout(1200);
  await smoothMove(page, 760, 360, 20); // Access
  await page.waitForTimeout(1200);
  await smoothMove(page, 1120, 360, 20); // Usability
  await page.waitForTimeout(1200);
  await smoothMove(page, 1480, 360, 20); // Payments
  await page.waitForTimeout(1200);

  await waitUntilTime(timeline.scenes[3].end);

  // ================= SCENE 5: Findings & Fix Kit =================
  console.log('[Scene 5] Findings & Fix Kit (69.2s - 81.6s)');
  await smoothScroll(page, 1150, 1000);
  await page.waitForTimeout(1000);

  // Click on Critical finding (P5 checkout)
  const firstFinding = page.locator('#findings-list .finding button').first();
  const fBounds = await firstFinding.boundingBox();
  if (fBounds) {
    await smoothMove(page, fBounds.x + 300, fBounds.y + 25, 20);
    await page.evaluate(() => window.clickDemoCursor(true));
    await page.waitForTimeout(120);
    await page.evaluate(() => window.clickDemoCursor(false));
    await firstFinding.click();
  }
  await page.waitForTimeout(1500);

  // Scroll slightly to view finding detail (evidence, problem, fix, acceptance)
  await smoothScroll(page, 1380, 800);
  await page.waitForTimeout(2500);

  // Hover over the Fix Kit download button
  await smoothScroll(page, 200, 1000);
  const fixBtn = page.locator('#fixkit-btn');
  const fixBounds = await fixBtn.boundingBox();
  if (fixBounds) {
    await smoothMove(page, fixBounds.x + fixBounds.width / 2, fixBounds.y + fixBounds.height / 2, 25);
    await page.evaluate(() => window.clickDemoCursor(true));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.clickDemoCursor(false));
    await page.waitForTimeout(1000);
  }

  await waitUntilTime(timeline.scenes[4].end);

  // ================= SCENE 6: Docs, API & MCP =================
  console.log('[Scene 6] Documentation & MCP (82.4s - 96.6s)');
  await page.goto('http://localhost:3000/docs', { waitUntil: 'networkidle' });
  await setupCursor(page);
  await page.waitForTimeout(1200);

  // Click category tabs in docs
  const tabButtons = page.locator('#cat-tabs button');
  const count = await tabButtons.count();
  if (count > 2) {
    const tab1 = await tabButtons.nth(1).boundingBox();
    if (tab1) {
      await smoothMove(page, tab1.x + 30, tab1.y + 15, 18);
      await tabButtons.nth(1).click();
      await page.waitForTimeout(1000);
    }
    const tab4 = await tabButtons.nth(4).boundingBox();
    if (tab4) {
      await smoothMove(page, tab4.x + 30, tab4.y + 15, 18);
      await tabButtons.nth(4).click();
      await page.waitForTimeout(1000);
    }
  }

  // Scroll to Scoring section
  await smoothScroll(page, 1100, 1000);
  await page.waitForTimeout(2000);

  // Scroll to API & MCP section
  await smoothScroll(page, 2100, 1000);
  await page.waitForTimeout(3000);

  await waitUntilTime(timeline.scenes[5].end);

  // ================= SCENE 7: Outro & Call to Action =================
  console.log('[Scene 7] Outro (97.4s - 103.8s)');
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await setupCursor(page);
  await smoothMove(page, 960, 450, 25);
  await waitUntilTime(timeline.totalDuration);

  console.log('Recording finished! Closing browser to finalize video file...');
  await page.close();
  await context.close();
  await browser.close();

  // Find generated webm file in OUT_DIR
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.webm'));
  files.sort((a, b) => fs.statSync(path.join(OUT_DIR, b)).mtimeMs - fs.statSync(path.join(OUT_DIR, a)).mtimeMs);
  const latestWebm = files[0];
  console.log('Recorded video saved to:', path.join(OUT_DIR, latestWebm));
  fs.copyFileSync(path.join(OUT_DIR, latestWebm), path.join(OUT_DIR, 'raw_recording.webm'));
  console.log('Copied to raw_recording.webm');
}

record().catch((err) => {
  console.error(err);
  process.exit(1);
});
