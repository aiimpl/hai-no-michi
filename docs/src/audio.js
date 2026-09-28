// Sound: synthesized on the fly with WebAudio (no audio files).
// Engine = low drone tracking RPM (two saws plus beating), gravel = band-passed noise scaled by speed,
// wind = low noise that grows with speed, forest = occasional distant birds, music = slowly shifting chords (toggleable).
export class Sound {
  constructor() { this.ctx = null; this.music = true; }
  start() {
    if (this.ctx) return;
    const c = this.ctx = new AudioContext();
    const out = this.out = c.createGain(); out.gain.value = 0.8;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3;
    // underwater, the highs drop out and everything sounds muffled
    this.muffle = c.createBiquadFilter(); this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000;
    out.connect(this.muffle).connect(comp).connect(c.destination);
    this.noiseBuf = null;
    const noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0, b = 0; i < d.length; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 3 + (Math.random() * 2 - 1) * 0.3; }
    this.noiseBuf = noiseBuf;
    const noise = () => { const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s; };
    // Engine
    this.eng = [c.createOscillator(), c.createOscillator()];
    this.eng[0].type = 'sawtooth'; this.eng[1].type = 'square';
    const ef = c.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 380; ef.Q.value = 2;
    this.engGain = c.createGain(); this.engGain.gain.value = 0;
    const trem = c.createGain(); const lfo = c.createOscillator(); lfo.frequency.value = 11; const lg = c.createGain(); lg.gain.value = 0.25;
    lfo.connect(lg).connect(trem.gain); lfo.start(); this.lfo = lfo;
    for (const o of this.eng) { o.connect(ef); o.start(); }
    ef.connect(trem).connect(this.engGain).connect(out);
    this.engF = ef;
    // Gravel
    const gs = noise(); const gb = c.createBiquadFilter(); gb.type = 'bandpass'; gb.frequency.value = 2400; gb.Q.value = 0.7;
    this.gravel = c.createGain(); this.gravel.gain.value = 0; gs.connect(gb).connect(this.gravel).connect(out);
    // Wind
    const ws = noise(); const wb = c.createBiquadFilter(); wb.type = 'lowpass'; wb.frequency.value = 500;
    this.wind = c.createGain(); this.wind.gain.value = 0.04; ws.connect(wb).connect(this.wind).connect(out); this.windF = wb;
    // Music: a three-note chord that moves every 8 s
    this.mus = c.createGain(); this.mus.gain.value = this.music ? 0.05 : 0; this.mus.connect(out);
    const rev = c.createConvolver(); const ir = c.createBuffer(2, c.sampleRate * 3, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const x = ir.getChannelData(ch); for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / x.length, 3); }
    rev.buffer = ir; rev.connect(this.mus);
    this.voices = [0, 1, 2].map(() => { const o = c.createOscillator(); o.type = 'triangle'; const g = c.createGain(); g.gain.value = 0.3; o.connect(g).connect(rev); o.start(); return o; });
    this.chords = [[146.8, 220.0, 277.2], [130.8, 196.0, 293.7], [123.5, 185.0, 246.9], [110.0, 164.8, 261.6]];
    this.ci = 0; this.nextChord = 0; this.nextBird = 2;
  }
  setUnder(u) {
    if (!this.ctx) return;
    this.muffle.frequency.setTargetAtTime(u ? 420 : 20000, this.ctx.currentTime, 0.15);
  }
  // Splash sound: a low thud plus a broadband whoosh of noise
  splash(k) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(260, t + 1.2); f.Q.value = 0.5;
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5 * k, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    const o = c.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
    const og = c.createGain(); og.gain.setValueAtTime(0.35 * k, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    s.connect(f).connect(g).connect(this.out); o.connect(og).connect(this.out);
    s.start(t); s.stop(t + 1.7); o.start(t); o.stop(t + 0.6);
  }
  bird() {
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner();
    const f = 2800 + Math.random() * 1800;
    o.frequency.setValueAtTime(f, t);
    for (let i = 0; i < 3; i++) { o.frequency.linearRampToValueAtTime(f * (1.15 + Math.random() * 0.2), t + 0.05 + i * 0.12); o.frequency.linearRampToValueAtTime(f, t + 0.1 + i * 0.12); }
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.012, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.42);
    p.pan.value = Math.random() * 2 - 1;
    o.connect(g).connect(p).connect(this.out); o.start(t); o.stop(t + 0.5);
  }
  update(dt, { kmh, throttle, rough, dead = false }) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, v = Math.abs(kmh);
    // RPM: from the speed band and throttle (dips a little on gear changes)
    const gear = v / 22 % 1;
    const rpm = 700 + gear * 1600 + Math.min(v, 22) * 20 + Math.abs(throttle) * 380;
    const f = rpm / 60 * 2;
    this.eng[0].frequency.setTargetAtTime(f, t, 0.08);
    this.eng[1].frequency.setTargetAtTime(f * 0.5, t, 0.08);
    this.lfo.frequency.setTargetAtTime(f / 4, t, 0.1);
    this.engF.frequency.setTargetAtTime(260 + Math.abs(throttle) * 520 + v * 4, t, 0.1);
    this.engGain.gain.setTargetAtTime(dead ? 0 : 0.1 + Math.abs(throttle) * 0.12, t, dead ? 0.4 : 0.1);
    this.gravel.gain.setTargetAtTime(Math.min(v / 60, 1) * (0.05 + rough * 0.5), t, 0.08);
    this.wind.gain.setTargetAtTime(0.03 + Math.min(v / 70, 1) * 0.06, t, 0.3);
    this.windF.frequency.setTargetAtTime(350 + v * 8, t, 0.3);
    this.mus.gain.setTargetAtTime(this.music ? 0.05 : 0, t, 0.8);
    if (t > this.nextChord) {
      const ch = this.chords[this.ci++ % this.chords.length];
      this.voices.forEach((o, i) => o.frequency.setTargetAtTime(ch[i], t, 1.5));
      this.nextChord = t + 8;
    }
    if (t > this.nextBird) { this.bird(); this.nextBird = t + 3 + Math.random() * 7; }
  }
}
