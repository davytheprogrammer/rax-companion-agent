const test = require('node:test');
const assert = require('node:assert/strict');
const { MUSE_MODEL, MUSE_REST_URL, MUSE_WS_URL, transcribeMuseWav, createMuseStream } = require('../src/voice/muse');

test('muse constants match documentation', () => {
  assert.equal(MUSE_MODEL, 'muse-voice-transcribe-1.0');
  assert.equal(MUSE_REST_URL, 'https://api.meta.ai/v1/asr/transcribe');
  assert.equal(MUSE_WS_URL, 'wss://api.meta.ai/v1/asr/realtime');
});

test('transcribeMuseWav requires an apiKey', async () => {
  await assert.rejects(
    () => transcribeMuseWav('', Buffer.from([1, 2, 3])),
    /Muse transcription requires an API key/
  );
});

test('transcribeMuseWav returns empty for empty buffer', async () => {
  const res = await transcribeMuseWav('fake-key', Buffer.alloc(0));
  assert.equal(res, '');
});

test('createMuseStream requires apiKey', () => {
  assert.throws(() => createMuseStream({}), /createMuseStream requires an apiKey/);
});

test('createMuseStream initializes and returns control interface', () => {
  // If offline or without mock, WebSocket constructor will attempt to connect
  let stream;
  try {
    stream = createMuseStream({ apiKey: 'test-key' });
    assert.equal(typeof stream.push, 'function');
    assert.equal(typeof stream.end, 'function');
    assert.equal(typeof stream.close, 'function');
    assert.ok(stream.sessionId.startsWith('rax-mic-'));
  } finally {
    if (stream) stream.close();
  }
});

test('createLLM supports muse provider with muse-spark-1.3-contributor', () => {
  const { createLLM } = require('../src/llm');
  const llm = createLLM({
    provider: 'muse',
    apiKeys: { muse: 'test-key' },
    models: { muse: { fast: 'muse-spark-1.3-contributor', smart: 'muse-spark-1.3-contributor' } }
  });
  assert.equal(llm.provider, 'muse');
  assert.equal(llm.model, 'muse-spark-1.3-contributor');
  assert.equal(llm.ready, true);
  assert.equal(typeof llm.stream, 'function');
  assert.equal(typeof llm.complete, 'function');
});

test('store defaults to muse provider with muse-spark-1.3-contributor', () => {
  const store = require('../src/store');
  const settings = store.getSettings();
  assert.equal(settings.provider, 'muse');
  assert.equal(settings.models.muse.fast, 'muse-spark-1.3-contributor');
  assert.equal(settings.models.muse.smart, 'muse-spark-1.3-contributor');
});
