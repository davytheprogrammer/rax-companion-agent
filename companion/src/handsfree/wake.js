'use strict';
// Hands-free: the wake word. With the open mic and the wake word both on, the
// room is transcribed as it is today, but only what starts with "Rax" is
// acted on. The rest is dropped, the Knot's own voice included.
//
// This matches the transcript, not the sound. Whisper already writes the room
// down while the open mic is on, so the check costs nothing extra and no audio
// leaves the machine for it. The price: a misheard name is a miss, and the
// word "Rax" said in the room is a hit.
//
// Pure functions: no Electron, no timers. The caller passes the clock.

const { cleanTranscript } = require('../guide/voice');

// Match the name itself, including polite prefixes and common phonetic ASR variants.
const WAKE_RE = /^\s*(?:(?:hey|ok|okay|hi|hello|yo|yo rax|sup)[,.!\s]+)?(?:rax|rex|racks|raxs|wracks)(?=$|[\s,.!?:;])[,.!?:;\s]*/i;

// Emergency words that immediately halt autonomous execution or speech,
// even without the wake-word prefix when a task is actively running.
const EMERGENCY_WORDS = /^\s*(?:(?:hey|ok|okay|hi|hello|yo|yo rax|sup)[\s,]+)?(?:(?:rax|rex|racks|raxs|wracks)[\s,]+)?(?:stop(?: it| that| talking| there)?|cancel|abort|freeze|halt|pause|wait stop|shut up|hush|emergency stop)[.!]*(?:\s+please)?\s*$/i;

function isEmergencyStop(text) {
  const t = cleanTranscript(text);
  if (!t) return false;
  return EMERGENCY_WORDS.test(t);
}

// After the bare name ("Rax?") the next words count without repeating it.
const ARMED_MS = 8000;

// -> { kind: 'none' } | { kind: 'armed' } | { kind: 'command', text }
//   none:    not addressed to Rax; drop it.
//   armed:   only the name was said; the next words are the ask.
//   command: an ask, with the name taken off the front.
function parseWake(text, { now = Date.now(), armedUntil = 0 } = {}) {
  const t = cleanTranscript(text);
  if (!t) return { kind: 'none' };
  const m = WAKE_RE.exec(t);
  if (m) {
    const rest = t.slice(m[0].length).trim();
    if (!rest) return { kind: 'armed' };
    return { kind: 'command', text: rest };
  }
  if (armedUntil && now < armedUntil) return { kind: 'command', text: t };
  return { kind: 'none' };
}

// The voice source for an utterance that came through the wake word. It is
// spoken (replies are read out, Hands resumes by voice) but it is not the open
// room mic, so the room-mic rules do not block it: it is the talk key, said
// with a name in front.
const WAKE_SOURCE = 'voice-wake';
function isVoiceSource(source) { return source === 'voice' || source === WAKE_SOURCE; }

module.exports = { parseWake, isEmergencyStop, isVoiceSource, WAKE_SOURCE, WAKE_RE, EMERGENCY_WORDS, ARMED_MS };
