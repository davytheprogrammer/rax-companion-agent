'use strict';
// Meta Muse Voice Transcribe (model: muse-voice-transcribe-1.0)
// Supports:
// 1. REST transcription: POST https://api.meta.ai/v1/asr/transcribe
// 2. Real-time streaming WebSocket: wss://api.meta.ai/v1/asr/realtime

const crypto = require('crypto');

const MUSE_MODEL = 'muse-voice-transcribe-1.0';
const MUSE_REST_URL = 'https://api.meta.ai/v1/asr/transcribe';
const MUSE_WS_URL = 'wss://api.meta.ai/v1/asr/realtime';

/**
 * Transcribe a WAV buffer using Meta Muse Voice Transcribe REST API.
 * @param {string} apiKey Meta Model API Key
 * @param {Buffer} wavBuffer RIFF/WAV 16-bit PCM audio buffer
 * @param {object} [opts]
 * @param {string[]} [opts.keywords] Vocabulary biasing words
 * @param {string[]} [opts.languageBias] e.g. ['English']
 * @param {string} [opts.sessionId]
 * @returns {Promise<string>}
 */
async function transcribeMuseWav(apiKey, wavBuffer, opts = {}) {
  if (!apiKey) throw new Error('Muse transcription requires an API key');
  if (!wavBuffer || !wavBuffer.length) return '';

  const sessionId = opts.sessionId || 'rax-' + crypto.randomUUID();
  const url = `${MUSE_REST_URL}?sessionId=${encodeURIComponent(sessionId)}`;

  const requestConfig = {
    mode: opts.mode || 'ENDPOINTING',
    model: MUSE_MODEL,
    audioEncoding: 'WAV',
  };
  if (Array.isArray(opts.keywords) && opts.keywords.length) {
    requestConfig.keywords = opts.keywords;
  }
  if (Array.isArray(opts.languageBias) && opts.languageBias.length) {
    requestConfig.languageBias = opts.languageBias;
  }

  const formData = new FormData();
  formData.append(
    'request',
    new Blob([JSON.stringify(requestConfig)], { type: 'application/json' })
  );
  formData.append(
    'audio',
    new Blob([wavBuffer], { type: 'audio/wav' }),
    'audio.wav'
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Muse API HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data && data.transcript ? data.transcript : '').trim();
}

/**
 * Real-time streaming listener for Meta Muse Voice Transcribe.
 * Connects to wss://api.meta.ai/v1/asr/realtime, sends handshake,
 * streams 16 kHz PCM chunks, and calls onPartial/onFinal callbacks.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {(text: string) => void} [opts.onPartial]
 * @param {(text: string, meta: object) => void} [opts.onFinal]
 * @param {(err: Error) => void} [opts.onError]
 * @param {string[]} [opts.keywords]
 * @param {string} [opts.mode] 'ENDPOINTING' (default) or 'PUSH_TO_TALK'
 */
function createMuseStream(opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('createMuseStream requires an apiKey');

  const sessionId = opts.sessionId || 'rax-mic-' + crypto.randomUUID();
  const wsUrl = `${MUSE_WS_URL}?sessionId=${encodeURIComponent(sessionId)}`;
  const mode = opts.mode || 'ENDPOINTING';

  const ws = new WebSocket(wsUrl);
  let isReady = false;
  let isClosed = false;
  let queue = [];

  ws.addEventListener('open', () => {
    // Handshake frame: must be first frame within 10s
    const handshake = {
      authorization: { accessToken: `Bearer ${apiKey}` },
      audioEncoding: 'PCM_16KHZ',
      model: MUSE_MODEL,
      mode: mode,
      partialMode: 'CUMULATIVE',
      emitAudioProgress: false,
    };
    if (Array.isArray(opts.keywords) && opts.keywords.length) {
      handshake.keywords = opts.keywords;
    }
    if (Array.isArray(opts.languageBias) && opts.languageBias.length) {
      handshake.languageBias = opts.languageBias;
    }
    ws.send(JSON.stringify(handshake));
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
      if (!data) return;

      // Handshake ack: { sessionId: "..." }
      if (data.sessionId && !data.type) {
        isReady = true;
        // Flush any buffered PCM audio
        while (queue.length && !isClosed) {
          const chunk = queue.shift();
          ws.send(chunk);
        }
        return;
      }

      if (data.type === 'error') {
        if (opts.onError) opts.onError(new Error(data.message || 'Muse server error'));
        return;
      }

      if (data.type === 'transcript') {
        if (data.final && opts.onFinal) {
          opts.onFinal(data.transcript || '', { turnId: data.turnId, mode });
        } else if (opts.onPartial) {
          opts.onPartial(data.transcript || '');
        }
      } else if (data.type === 'speechComplete' && opts.onFinal) {
        opts.onFinal(data.transcript || '', { turnId: data.turnId, mode });
      }
    } catch (e) {
      if (opts.onError) opts.onError(e);
    }
  });

  ws.addEventListener('error', (err) => {
    if (opts.onError) opts.onError(err);
  });

  ws.addEventListener('close', () => {
    isClosed = true;
  });

  return {
    push(pcmChunk) {
      if (isClosed) return;
      if (isReady && ws.readyState === WebSocket.OPEN) {
        ws.send(pcmChunk);
      } else {
        queue.push(pcmChunk);
      }
    },
    end() {
      if (isClosed) return;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'endStream' }));
        }
      } catch (_) {}
    },
    close() {
      isClosed = true;
      try { ws.close(); } catch (_) {}
    },
    get sessionId() {
      return sessionId;
    }
  };
}

module.exports = {
  MUSE_MODEL,
  MUSE_REST_URL,
  MUSE_WS_URL,
  transcribeMuseWav,
  createMuseStream,
};
