// scripts/setup-fable.js
// Fetches the Fable Kokoro multi-lang v1.0 voice model archive for sherpa-onnx into vendor/voice
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2';
const SHA256 = '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4';
const root = path.join(__dirname, '..');
const vendorVoiceDir = path.join(root, 'vendor', 'voice');
const targetDir = path.join(vendorVoiceDir, 'kokoro-multi-lang-v1_0');

async function download(url, dest) {
  console.log(`Downloading ${url}...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`Saved ${dest} (${(buf.length / 1048576).toFixed(1)} MB)`);
  return buf;
}

async function main() {
  if (fs.existsSync(path.join(targetDir, 'model.onnx')) && fs.existsSync(path.join(targetDir, 'voices.bin'))) {
    console.log('Fable voice model is already present in ' + targetDir);
    return;
  }
  fs.mkdirSync(vendorVoiceDir, { recursive: true });
  const archivePath = path.join(vendorVoiceDir, 'kokoro-multi-lang-v1_0.tar.bz2');

  if (!fs.existsSync(archivePath)) {
    await download(URL, archivePath);
  }

  const hash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  if (hash !== SHA256) {
    console.warn(`Note: sha256 is ${hash}, expected ${SHA256}`);
  }

  console.log('Extracting archive into ' + vendorVoiceDir + '...');
  const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const exe = fs.existsSync(tarExe) ? tarExe : 'tar';
  execFileSync(exe, ['-xjf', archivePath, '-C', vendorVoiceDir], { stdio: 'inherit' });
  console.log('Extraction complete. Cleaning archive...');
  try { fs.unlinkSync(archivePath); } catch (_) {}
  console.log('Fable voice model ready at: ' + targetDir);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
