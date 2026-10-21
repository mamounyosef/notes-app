// Voice mode's microphone: 16 kHz mono int16 frames of 512 samples (32 ms), with their loudness.
// Loaded with audioWorklet.addModule (see voiceSession.ts).
class NotesMic extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.phase = 0
    this.acc = 0
    this.cnt = 0
    this.out = new Int16Array(512)
    this.n = 0
    this.sq = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]
      this.cnt++
      this.phase += 1
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio
        const v = this.acc / this.cnt
        this.acc = 0
        this.cnt = 0
        this.sq += v * v
        this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
        if (this.n === 512) {
          const frame = this.out
          this.out = new Int16Array(512)
          this.port.postMessage({ frame, level: Math.sqrt(this.sq / 512) }, [frame.buffer])
          this.n = 0
          this.sq = 0
        }
      }
    }
    return true
  }
}
registerProcessor('notes-mic', NotesMic)
