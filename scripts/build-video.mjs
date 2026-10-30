import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('video_assets');
const RAW_VIDEO = path.join(OUT_DIR, 'raw_recording.webm');
const FULL_AUDIO = path.join(OUT_DIR, 'narration_full.wav');
const CAPTIONS_SRT = path.join(OUT_DIR, 'captions.srt').replace(/\\/g, '/').replace(/:/g, '\\:');
const FINAL_MP4 = path.resolve('demo.mp4');
const FINAL_WEBM = path.resolve('demo.webm');

function run() {
  if (!fs.existsSync(RAW_VIDEO)) {
    throw new Error('raw_recording.webm does not exist in ' + OUT_DIR);
  }
  if (!fs.existsSync(FULL_AUDIO)) {
    throw new Error('narration_full.wav does not exist in ' + OUT_DIR);
  }

  console.log('Building production demo video with FFmpeg...');

  // Get durations
  const vidDur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${RAW_VIDEO}"`, { encoding: 'utf8' }).trim());
  const audDur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${FULL_AUDIO}"`, { encoding: 'utf8' }).trim());

  console.log(`Video duration: ${vidDur.toFixed(2)}s, Audio duration: ${audDur.toFixed(2)}s`);

  // Subtitle styling: Clean modern semi-transparent box with white text
  // Subtitle filter formatted for Windows path
  const subFilter = `subtitles='${CAPTIONS_SRT}':force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,BackColour=&H90000000,MarginV=42,Alignment=2'`;

  // Draw banner on top-left: "Cumulus · AI Website Readiness Auditor"
  const bannerFilter = `drawtext=text='Cumulus  |  AI Website Readiness Auditor':fontcolor=white:fontsize=18:font='Arial':box=1:boxcolor=black@0.65:boxborderw=8:x=36:y=36`;

  const filterComplex = `${subFilter},${bannerFilter}`;

  console.log('Rendering demo.mp4 (H.264 + AAC)...');
  const mp4Cmd = `ffmpeg -y -i "${RAW_VIDEO}" -i "${FULL_AUDIO}" -filter_complex "${filterComplex}" -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 192k -shortest "${FINAL_MP4}"`;
  execSync(mp4Cmd, { stdio: 'inherit' });

  console.log('Rendering demo.webm (VP9 + Opus)...');
  const webmCmd = `ffmpeg -y -i "${RAW_VIDEO}" -i "${FULL_AUDIO}" -filter_complex "${filterComplex}" -c:v libvpx-vp9 -b:v 2M -c:a libopus -shortest "${FINAL_WEBM}"`;
  execSync(webmCmd, { stdio: 'inherit' });

  const finalStat = fs.statSync(FINAL_MP4);
  const finalDur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${FINAL_MP4}"`, { encoding: 'utf8' }).trim());

  console.log('\n======================================================');
  console.log('DEMO VIDEO READY!');
  console.log(`Path: ${FINAL_MP4}`);
  console.log(`WebM Path: ${FINAL_WEBM}`);
  console.log(`File Size: ${(finalStat.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Duration: ${finalDur.toFixed(2)} seconds (${Math.floor(finalDur / 60)}m ${Math.round(finalDur % 60)}s)`);
  console.log('Constraint check: UNDER 2 MINUTES =', finalDur < 120 ? 'PASSED ✅' : 'FAILED ❌');
  console.log('======================================================');
}

run();
