import { execSync } from 'node:child_process';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('video_assets');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SCENES = [
  {
    id: 'scene1_intro',
    text: 'Welcome to Cumulus. Millions of AI agents—from ChatGPT and Claude to shopping bots—browse the web daily to answer questions and purchase products. Yet most websites fail because of client-side hydration, missing schema, blocked robots directives, or broken checkout links. We built Cumulus to audit how easily AI agents can discover, access, understand, and transact on your website.',
    caption: 'Cumulus · AI Website Readiness Auditor\nWhy we made it: Websites fail for autonomous AI agents'
  },
  {
    id: 'scene2_submission',
    text: 'Getting started requires zero signup. Enter any public URL and click Audit. Cumulus launches a multi-stage evaluation: parsing robots directives for major AI crawlers, probing sitemaps, extracting raw HTML, and launching a headless browser to execute real agent journeys.',
    caption: 'Live Walkthrough: URL Submission & Real-time Evaluation\nMulti-stage crawl with Server-Sent Events (SSE)'
  },
  {
    id: 'scene3_browser_tasks',
    text: 'Unlike basic scanners, Cumulus tests real user workflows in a sandboxed browser: finding pricing, extracting plans, following checkout calls-to-action without submitting forms, and verifying that navigation landmarks are truly machine-followable.',
    caption: 'Deep Browser Agent Testing\nEvaluating pricing, plan extraction, checkout links, and navigation'
  },
  {
    id: 'scene4_results_scoring',
    text: 'When complete, Cumulus generates a transparent report. The overall readiness score reflects verified evidence across Discovery, Access, Usability, and Payments. Crucially, audit coverage is always measured—untested or inconclusive checks are never treated as failures.',
    caption: 'Transparent Results Dashboard & Scoring\nDiscovery, Access, Usability & Payments with verified coverage'
  },
  {
    id: 'scene5_findings_fixkit',
    text: 'Every finding comes backed by real evidence, business impact, and specific acceptance criteria. Engineers can download the complete Fix Kit: a packaged ZIP archive with individual Markdown guides and verification commands ready for sprint backlog.',
    caption: 'Evidence-Backed Findings & Downloadable Fix Kit\nPackaged Markdown remediation guides for engineering teams'
  },
  {
    id: 'scene6_docs_mcp',
    text: 'Cumulus is built for developers and autonomous agents alike. Our documentation details all thirty-three checks in the suite. With our REST API and native Model Context Protocol interface, AI agents can audit websites and retrieve remediation instructions programmatically.',
    caption: 'Complete Documentation, REST API & Model Context Protocol (MCP)\nEquipping autonomous agents with audit & remediation tools'
  },
  {
    id: 'scene7_outro',
    text: 'Test your site today with Cumulus, and make your business ready for the agentic web.',
    caption: 'Cumulus · Ready for the Agentic Web'
  }
];

function getWavDuration(filePath) {
  const output = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { encoding: 'utf8' }).trim();
  return parseFloat(output);
}

function formatSrtTime(totalSec) {
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = Math.floor(totalSec % 60);
  const millis = Math.floor((totalSec % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

async function run() {
  console.log('Generating TTS narration for', SCENES.length, 'scenes...');
  const timeline = [];
  let currentTime = 0.5; // slight intro pause
  const concatList = [];

  for (let i = 0; i < SCENES.length; i++) {
    const sc = SCENES[i];
    const wavPath = path.join(OUT_DIR, `${sc.id}.wav`);
    console.log(`Generating ${sc.id}...`);

    execSync(
      `powershell -ExecutionPolicy Bypass -File scripts/tts.ps1 -Text "${sc.text.replace(/"/g, '`"')}" -OutputFile "${wavPath}" -VoiceName "Microsoft Zira Desktop" -Rate 2`,
      { stdio: 'inherit' }
    );

    const dur = getWavDuration(wavPath);
    const start = currentTime;
    const end = start + dur;
    const pauseAfter = (i === SCENES.length - 1) ? 2.0 : 0.8;

    timeline.push({
      ...sc,
      file: wavPath,
      start,
      end,
      duration: dur,
      pauseAfter
    });

    currentTime = end + pauseAfter;
    concatList.push(`file '${wavPath.replace(/\\/g, '/')}'`);
    if (pauseAfter > 0) {
      // create silence wav
      const silencePath = path.join(OUT_DIR, `silence_${i}.wav`);
      execSync(`ffmpeg -y -f lavfi -i anullsrc=r=22050:cl=mono -t ${pauseAfter.toFixed(2)} -q:a 9 -acodec pcm_s16le "${silencePath}" 2>&1`);
      concatList.push(`file '${silencePath.replace(/\\/g, '/')}'`);
    }
  }

  console.log(`Total duration: ${currentTime.toFixed(2)} seconds (Limit: 120s)`);
  if (currentTime > 120) {
    console.warn(`WARNING: Duration ${currentTime}s exceeds 120s!`);
  } else {
    console.log(`SUCCESS: Duration ${currentTime.toFixed(2)}s is under the 2 minute limit.`);
  }

  // Write concat file
  const concatTxt = path.join(OUT_DIR, 'concat_audio.txt');
  fs.writeFileSync(concatTxt, concatList.join('\n'));

  // Combine into single audio track
  const fullAudio = path.join(OUT_DIR, 'narration_full.wav');
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatTxt}" -c copy "${fullAudio}"`);
  console.log('Combined narration audio created at:', fullAudio);

  // Write SRT Subtitles
  let srtContent = '';
  timeline.forEach((sc, idx) => {
    srtContent += `${idx + 1}\n`;
    srtContent += `${formatSrtTime(sc.start)} --> ${formatSrtTime(sc.end + 0.3)}\n`;
    srtContent += `${sc.caption}\n\n`;
  });
  const srtPath = path.join(OUT_DIR, 'captions.srt');
  fs.writeFileSync(srtPath, srtContent);
  console.log('Subtitles created at:', srtPath);

  // Write timeline.json
  const timelinePath = path.join(OUT_DIR, 'timeline.json');
  fs.writeFileSync(timelinePath, JSON.stringify({ totalDuration: currentTime, scenes: timeline }, null, 2));
  console.log('Timeline saved to:', timelinePath);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
