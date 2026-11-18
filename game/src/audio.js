// A small WebAudio synth, fully guarded: the context is created lazily and only after a user
// gesture unlocks it, and every call is wrapped so that before unlock — or on any browser that
// refuses — each sound is a silent no-op instead of a crash. Engine hum and the police siren
// are continuous nodes steered once a frame; everything else is a short one-shot blip.

export function createAudio() {
  let ctx = null;
  let master = null;
  let engineOsc = null;
  let engineGain = null;
  let sirenOsc = null;
  let sirenGain = null;
  let musicTimer = null;
  let muted = false;

  function unlock() {
    if (ctx !== null) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
    }
  }

  function tone(freq, dur, type, vol, slideTo, delay = 0) {
    if (ctx === null || master === null) return;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch { /* a refused node is silence, not an error */ }
  }

  function noise(dur, vol, freq) {
    if (ctx === null || master === null) return;
    try {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      src.connect(filter).connect(gain).connect(master);
      src.start();
    } catch { /* guarded */ }
  }

  return {
    unlock,
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (master !== null && ctx !== null) {
        try { master.gain.setValueAtTime(muted ? 0 : 0.5, ctx.currentTime); } catch { /* guarded */ }
      }
      return muted;
    },
    /** Continuous engine note; ratio is 0..1 of top speed. Call once a frame. */
    setEngine(on, ratio) {
      if (ctx === null || master === null) return;
      try {
        if (on && engineOsc === null) {
          engineOsc = ctx.createOscillator();
          engineGain = ctx.createGain();
          engineOsc.type = 'sawtooth';
          engineGain.gain.value = 0;
          engineOsc.connect(engineGain).connect(master);
          engineOsc.start();
        }
        if (engineOsc !== null && engineGain !== null) {
          const t = ctx.currentTime;
          engineOsc.frequency.setTargetAtTime(55 + ratio * 165, t, 0.06);
          engineGain.gain.setTargetAtTime(on ? 0.05 + ratio * 0.05 : 0, t, 0.09);
        }
      } catch { /* guarded */ }
    },
    /** Two-tone siren; level is 0..1 by the nearest unit's distance. Call once a frame. */
    setSiren(level, time) {
      if (ctx === null || master === null) return;
      try {
        if (level > 0.01 && sirenOsc === null) {
          sirenOsc = ctx.createOscillator();
          sirenGain = ctx.createGain();
          sirenOsc.type = 'triangle';
          sirenGain.gain.value = 0;
          sirenOsc.connect(sirenGain).connect(master);
          sirenOsc.start();
        }
        if (sirenOsc !== null && sirenGain !== null) {
          const t = ctx.currentTime;
          sirenOsc.frequency.setTargetAtTime(Math.floor(time * 1.6) % 2 === 0 ? 660 : 880, t, 0.03);
          sirenGain.gain.setTargetAtTime(level * 0.045, t, 0.1);
        }
      } catch { /* guarded */ }
    },
    shot() { noise(0.14, 0.5, 2600); tone(150, 0.1, 'square', 0.2, 60); },
    officerShot() { noise(0.1, 0.22, 2200); },
    crash(strength) { noise(0.2, Math.min(0.5, 0.15 + strength * 0.3), 700); },
    pickup() { tone(880, 0.09, 'sine', 0.25); tone(1318, 0.14, 'sine', 0.22, null, 0.07); },
    cash() { tone(1046, 0.08, 'square', 0.14); tone(1568, 0.16, 'square', 0.14, null, 0.08); },
    jingle() {
      const notes = [523, 659, 784, 1046];
      notes.forEach((f, i) => tone(f, 0.22, 'triangle', 0.25, null, i * 0.11));
    },
    sting() { tone(220, 0.5, 'sawtooth', 0.22, 110); tone(233, 0.6, 'sawtooth', 0.18, 98, 0.05); },
    popup() { tone(1174, 0.07, 'sine', 0.15); },
    /** A lazy little title loop; safe to call repeatedly, stops itself off the title screen. */
    setTitleMusic(on) {
      if (ctx === null) return;
      try {
        if (on && musicTimer === null) {
          const bass = [110, 110, 130.8, 98];
          let bar = 0;
          musicTimer = window.setInterval(() => {
            if (ctx === null) return;
            const root = bass[bar % bass.length];
            tone(root, 0.5, 'triangle', 0.16);
            tone(root * 2, 0.3, 'sine', 0.07, null, 0.12);
            tone(root * 3, 0.24, 'sine', 0.05, null, 0.3);
            bar += 1;
          }, 620);
        } else if (!on && musicTimer !== null) {
          window.clearInterval(musicTimer);
          musicTimer = null;
        }
      } catch { /* guarded */ }
    },
  };
}
