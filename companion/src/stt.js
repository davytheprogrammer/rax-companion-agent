// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API; we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { transcribeMuseWav } = require('./voice/muse');

async function transcribeOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: model || 'whisper-1' });
  return (res.text || '').trim();
}

// The transcription model follows the store's fast Gemini model, so it retires
// with it: gemini-2.5-flash returns 404 for new users (2026-09-15).
const DEFAULT_GEMINI_STT_MODEL = 'gemini-3.6-flash';
async function transcribeGemini(apiKey, wav, model) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: model || DEFAULT_GEMINI_STT_MODEL,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

// opts.localOnly: the audio never leaves the machine. Hands-free listening sets it,
// because it hears the whole room, not only what the person pressed the key for.
function createSTT(settings, opts = {}) {
  const keys = settings.apiKeys || {};
  const chain = [];
  // Meta Muse Voice Transcribe first when configured: high accuracy, turn detection, and vocabulary biasing.
  const museKey = keys.meta || keys.muse || process.env.MODEL_API_KEY || process.env.META_API_KEY;
  if (!opts.localOnly && museKey) {
    chain.push({ p: 'muse', fn: (wav) => transcribeMuseWav(museKey, wav, { keywords: ['Rax', 'Knot'] }) });
  }
  // Local whisper.cpp: free, offline, and keyless fallback.
  let sttLocal = null;
  try { sttLocal = require('../../src/stt-local'); } catch { sttLocal = null; }
  if (sttLocal && sttLocal.status().available) {
    chain.push({ p: 'local', fn: async (_wav, pcm) => {
      const res = await sttLocal.transcribePcm(pcm);
      if (res.error) throw new Error(res.error);
      return res.text || '';
    } });
  }
  if (!opts.localOnly && keys.openai) chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel) });
  const geminiModel = (settings.models && settings.models.gemini && settings.models.gemini.fast) || DEFAULT_GEMINI_STT_MODEL;
  if (!opts.localOnly && keys.gemini && process.env.NUS_NO_GEMINI !== '1') chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav, geminiModel) });

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav, pcm);
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
