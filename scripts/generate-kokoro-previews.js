const fs = require('fs');
const path = require('path');
const { KokoroTTS } = require('kokoro-js');

(async () => {
  const voices = ['af_bella', 'af_nicole', 'am_adam', 'am_puck', 'am_eric', 'bf_isabella', 'bm_george'];
  const outDir = path.join(process.cwd(), 'public', 'audio', 'kokoro');
  fs.mkdirSync(outDir, { recursive: true });

  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', {
    dtype: 'q8',
    device: 'wasm',
  });

  for (const voice of voices) {
    const text = `Hi, I am ${voice}, how are you feeling today?`;
    const audio = await tts.generate(text, { voice, speed: 0.98 });

    let bytes;
    if (typeof audio.toArrayBuffer === 'function') {
      bytes = new Uint8Array(await audio.toArrayBuffer());
    } else if (typeof audio.toWav === 'function') {
      bytes = new Uint8Array(audio.toWav());
    } else if (typeof audio.toBlob === 'function') {
      const blob = await audio.toBlob();
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      throw new Error(`Unsupported audio output for ${voice}`);
    }

    fs.writeFileSync(path.join(outDir, `${voice}.wav`), Buffer.from(bytes));
    console.log('wrote', voice);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
