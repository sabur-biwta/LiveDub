(function () {
/*
 * Live Dub app - replaces the Chrome extension APIs (chrome.storage, chrome.runtime)
 * with the Android app's native bridge (window.LiveDubNative).
 * This file is bundled inside a closure, so `chrome` is local to Live Dub's own
 * scripts and never visible to the YouTube page.
 */
var N = window.LiveDubNative;
var __ldBgLoading = false;
var __ldWaits = new Map();
var __ldSeq = 0;

function __ldB64ToBytes(b64) {
  var bin = atob(b64 || "");
  var u = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function __ldNextId(prefix) { return prefix + (++__ldSeq) + "_" + Date.now(); }

window.__ldNative = window.__ldNative || {
  // called from Java
  httpDone: function (id, status, b64, err) {
    var w = __ldWaits.get(id);
    if (w) { __ldWaits.delete(id); w(status, b64, err); }
  },
  ttsDone: function (id, status, b64, err) {
    var w = __ldWaits.get(id);
    if (w) { __ldWaits.delete(id); w(status, b64, err); }
  },
};

/** fetch() replacement that goes through the app (no browser CORS limits). */
function __ldFetch(url, init) {
  init = init || {};
  return new Promise(function (resolve, reject) {
    var id = __ldNextId("h");
    __ldWaits.set(id, function (status, b64, err) {
      if (!status) { reject(new TypeError("Network error: " + (err || "failed"))); return; }
      var bytes = __ldB64ToBytes(b64);
      var text = function () { return new TextDecoder().decode(bytes); };
      resolve({
        ok: status >= 200 && status < 300,
        status: status,
        text: function () { return Promise.resolve(text()); },
        json: function () { try { return Promise.resolve(JSON.parse(text())); } catch (e) { return Promise.reject(e); } },
        arrayBuffer: function () { return Promise.resolve(bytes.slice().buffer); },
        clone: function () { return this; },
      });
    });
    var headers = init.headers || {};
    var body = init.body == null ? "" : String(init.body);
    N.http(id, init.method || "GET", String(url), JSON.stringify(headers), body);
  });
}

/** Phone text-to-speech -> WAV audio (base64). */
function __ldTts(text, voice, langTag) {
  return new Promise(function (resolve, reject) {
    var id = __ldNextId("t");
    __ldWaits.set(id, function (status, b64, err) {
      if (!status || !b64) reject(new Error(err || "Phone voice failed"));
      else resolve(b64);
    });
    N.tts(id, String(text), voice || "", langTag || "");
  });
}

function __ldVoices(lang) {
  try { return JSON.parse(N.ttsVoices(lang || "") || "[]"); } catch (e) { return []; }
}

var __ldLangTags = { bn: "bn-BD", hi: "hi-IN", en: "en-US", ur: "ur-PK", ar: "ar" };

// ---------------------------------------------------------------- storage

var __ldStorageListeners = [];

function __ldRead(key) {
  var v = N.storageGet(key);
  if (v == null) return undefined;
  try { return JSON.parse(v); } catch (e) { return undefined; }
}

var __ldLocal = {
  get: function (keys) {
    var out = {}, list;
    if (keys == null) list = JSON.parse(N.storageKeys() || "[]");
    else if (typeof keys === "string") list = [keys];
    else if (Array.isArray(keys)) list = keys;
    else { list = Object.keys(keys); list.forEach(function (k) { out[k] = keys[k]; }); }
    list.forEach(function (k) { var v = __ldRead(k); if (v !== undefined) out[k] = v; });
    return Promise.resolve(out);
  },
  set: function (obj) {
    var changes = {};
    Object.keys(obj).forEach(function (k) {
      changes[k] = { oldValue: __ldRead(k), newValue: obj[k] };
      N.storageSet(k, JSON.stringify(obj[k]));
    });
    __ldStorageListeners.forEach(function (f) { try { f(changes, "local"); } catch (e) { /* ignore */ } });
    return Promise.resolve();
  },
  remove: function (keys) {
    [].concat(keys).forEach(function (k) { N.storageRemove(k); });
    return Promise.resolve();
  },
};

// ---------------------------------------------------------------- messaging

var __ldBgListeners = [];
var __ldPageListeners = [];

function __ldAndroidMessage(msg) {
  if (msg.type === "androidVoices") {
    return Promise.resolve({ ok: true, voices: __ldVoices(msg.lang || "bn"), ready: !!N.ttsIsReady() });
  }
  // ttsAndroid
  return window.LiveDub.loadSettings().then(function (st) {
    var voice = msg.voice || (msg.gender === "female" ? st.androidVoiceFemale : st.androidVoiceMale) || "";
    var tag = __ldLangTags[st.targetLang] || st.targetLang;
    return __ldTts(msg.text, voice, tag);
  }).then(function (b64) {
    return { ok: true, audio: b64, mime: "audio/wav" };
  }, function (e) {
    return { ok: false, error: String((e && e.message) || e) };
  });
}

var chrome = {
  storage: {
    local: __ldLocal,
    onChanged: { addListener: function (f) { __ldStorageListeners.push(f); } },
  },
  runtime: {
    onMessage: {
      addListener: function (f) { (__ldBgLoading ? __ldBgListeners : __ldPageListeners).push(f); },
    },
    sendMessage: function (msg) {
      if (msg && (msg.type === "ttsAndroid" || msg.type === "androidVoices")) return __ldAndroidMessage(msg);
      return new Promise(function (resolve) {
        var f = __ldBgListeners[0];
        if (!f) { resolve({ ok: false, error: "Background service not loaded" }); return; }
        var done = false;
        f(msg, {}, function (r) { if (!done) { done = true; resolve(r); } });
      });
    },
    openOptionsPage: function () { N.openSettings(); },
  },
  permissions: { request: function () { return Promise.resolve(true); } },
  commands: { onCommand: { addListener: function () {} } },
  tabs: {
    query: function () { return Promise.resolve([]); },
    sendMessage: function () { return Promise.resolve({}); },
  },
};

var speechSynthesis = window.speechSynthesis || { getVoices: function () { return []; }, onvoiceschanged: null };
/*
 * Live Dub - shared logic (used by content script, background worker and tests).
 * Pure functions only, plus the DubSync timing engine which talks to
 * video/voice adapters so it can be tested without a browser.
 */
(function (root) {
  "use strict";

  const LANG_NAMES = {
    bn: "Bangla (standard Bangladeshi Bengali)",
    en: "English", hi: "Hindi", ar: "Arabic", ur: "Urdu",
  };
  function langName(code) { return LANG_NAMES[code] || code; }

  // ------------------------------------------------------------ captions

  function decodeEntities(s) {
    return s
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }

  function cleanText(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .replace(/\[[^\]]{0,40}\]/g, " ")        // [Music], [Applause]
      .replace(/^\s*>>\s*/, "")                 // speaker change marks
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Parse YouTube timedtext (json3, srv3 or legacy XML) into [{start, dur, text}] seconds. */
  function parseCaptions(body) {
    if (!body) return [];
    const src = String(body).trim();
    const cues = [];
    if (src.startsWith("{")) {
      let data;
      try { data = JSON.parse(src); } catch (e) { return []; }
      for (const ev of data.events || []) {
        if (!ev.segs) continue;
        const text = cleanText(ev.segs.map((s) => s.utf8 || "").join(""));
        if (!text) continue;
        cues.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text });
      }
    } else if (/<p\s[^>]*\bt="/.test(src)) {                       // srv3
      const re = /<p\s([^>]*)>([\s\S]*?)<\/p>/g;
      let m;
      while ((m = re.exec(src))) {
        const t = /\bt="(\d+)"/.exec(m[1]);
        const d = /\bd="(\d+)"/.exec(m[1]);
        const text = cleanText(decodeEntities(m[2].replace(/<[^>]+>/g, "")));
        if (t && text) cues.push({ start: +t[1] / 1000, dur: d ? +d[1] / 1000 : 0, text });
      }
    } else {                                                        // legacy <text start dur>
      const re = /<text\s([^>]*)>([\s\S]*?)<\/text>/g;
      let m;
      while ((m = re.exec(src))) {
        const st = /\bstart="([\d.]+)"/.exec(m[1]);
        const du = /\bdur="([\d.]+)"/.exec(m[1]);
        const text = cleanText(decodeEntities(decodeEntities(m[2]).replace(/<[^>]+>/g, "")));
        if (st && text) cues.push({ start: +st[1], dur: du ? +du[1] : 0, text });
      }
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  /**
   * Merge caption fragments into speakable segments of a few seconds,
   * splitting at sentence ends, pauses, or length limits.
   */
  function groupCues(cues, opts) {
    const o = Object.assign({ maxDur: 7, maxChars: 170, gap: 1.2, minSentence: 1.5 }, opts || {});
    const groups = [];
    let cur = null;
    const flush = () => { if (cur) groups.push(cur); cur = null; };
    for (const c of cues) {
      if (cur) {
        const gap = c.start - cur.lastEnd;
        const dur = c.start - cur.start;
        const sentenceDone = /[.?!\u0964…]["'”)\]]?$/.test(cur.text) && dur >= o.minSentence;
        if (gap > o.gap || dur >= o.maxDur || cur.text.length >= o.maxChars || sentenceDone) flush();
      }
      if (!cur) cur = { start: c.start, text: c.text, lastEnd: c.start + c.dur };
      else {
        cur.text += " " + c.text;
        cur.lastEnd = Math.max(cur.lastEnd, c.start + c.dur);
      }
    }
    flush();
    return groups.map((g, i) => {
      const next = groups[i + 1];
      let end = g.lastEnd > g.start ? g.lastEnd : g.start + 2;
      if (next) end = Math.min(end, next.start);
      return { start: g.start, end: Math.max(end, g.start + 0.5), text: g.text };
    });
  }

  /** Split segment indices into translation batches: [[from, to), ...]. */
  function makeBatches(segs, maxChars, maxLines) {
    const out = [];
    let from = 0, chars = 0;
    for (let i = 0; i < segs.length; i++) {
      const len = segs[i].text.length + 6;
      if (i > from && (chars + len > maxChars || i - from >= maxLines)) {
        out.push([from, i]);
        from = i; chars = 0;
      }
      chars += len;
    }
    if (from < segs.length) out.push([from, segs.length]);
    return out;
  }

  /** Order batches so the one at the current playback position comes first, then forward, then earlier ones. */
  function orderBatches(batches, segs, t) {
    let k = batches.findIndex(([a, b]) => segs[b - 1].end > t);
    if (k < 0) k = batches.length - 1;
    return batches.slice(k).concat(batches.slice(0, k).reverse());
  }

  /** Parse "N: text" lines from an AI answer into an array of length n (missing -> null). */
  function parseNumbered(text, n) {
    const out = new Array(n).fill(null);
    for (const line of String(text || "").split(/\r?\n/)) {
      const m = /^\s*(?:\*\*)?(\d{1,4})(?:\*\*)?\s*[:.)|\-\]]\s*(.*)$/.exec(line);
      if (!m) continue;
      const k = +m[1] - 1;
      if (k >= 0 && k < n && out[k] === null) out[k] = m[2].trim();
    }
    return out;
  }

  /** Split text into pieces of at most max chars for the Google voice (which accepts ~200). */
  function splitForTts(text, max) {
    const pieces = [];
    let rest = String(text || "").replace(/\s+/g, " ").trim();
    while (rest.length > max) {
      const win = rest.slice(0, max);
      let cut = -1;
      for (const p of ["\u0964", ". ", "? ", "! ", "; ", ", "]) {
        const k = win.lastIndexOf(p);
        if (k > cut) cut = k + p.trimEnd().length;
      }
      if (cut < max * 0.4) cut = win.lastIndexOf(" ");
      if (cut <= 0) cut = max;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
    return pieces;
  }

  /** Index of the last segment starting at or before t, or -1. */
  function findSegmentIndex(segs, t) {
    let lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * Voice playback rate.
   * speed mode: speed the voice up (up to maxSpeed) so it fits before the next segment.
   * pause mode: never squeeze; the video waits for the voice instead.
   */
  function computeRate(audioDur, slot, videoRate, userSpeed, maxSpeed, mode) {
    const base = userSpeed * videoRate;
    if (mode === "pause" || !(audioDur > 0) || !(slot > 0)) return clamp(base, 0.5, 4);
    const needed = (audioDur * videoRate) / slot;
    return clamp(Math.min(Math.max(base, needed), Math.max(base, maxSpeed * videoRate)), 0.5, 4);
  }

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

  // ------------------------------------------------------------ timing engine

  /**
   * Keeps the translated voice in step with the video.
   * adapters:
   *   video: { currentTime, paused, playbackRate, play(), pause(), isAd() }
   *   voice: { play(seg, rate) -> Promise (resolves when finished or stopped),
   *            stop(), pause(), resume(), isPlaying(), remaining(), setRate(r) }
   *   segments(): current segment array
   *   isReady(i): translation and audio of segment i available
   *   prepare(i, urgent): request preparation of segment i
   *   settings(): { overrun: "speed"|"pause", voiceSpeed, maxSpeed }
   *   startDelay(): optional, seconds to listen to the original speaker before
   *                 voicing a segment (used for speaker gender detection)
   *   beforeStart(i): optional, called just before segment i is voiced
   *   now(): ms clock
   */
  class DubSync {
    constructor(a) {
      Object.assign(this, a);
      this.now = a.now || (() => Date.now());
      this.startDelay = a.startDelay || (() => 0);
      this.beforeStart = a.beforeStart || (() => {});
      this.ENTER_WINDOW = 1.5;   // s: how late we may still start a segment's voice
      this.AHEAD = 6;            // segments to prepare in advance
      this.LOAD_TIMEOUT = 12000; // ms the video may wait for slow audio
      this.playToken = 0;
      this.reset();
    }

    reset() {
      this.playToken++;
      this.voice.stop();
      this.lastIdx = -2;
      this.playingIdx = -1;
      this.playingSeg = null;
      this.queued = -1;
      this.pending = -1;
      this.pendingSince = 0;
      this.pausedByDub = false;
      this.pauseReason = "";
      this.armed = -1;
      this.lastVideoRate = this.video.playbackRate || 1;
    }

    tick() {
      const segs = this.segments();
      if (!segs.length) return -1;
      const v = this.video;
      if (v.isAd()) { if (this.voice.isPlaying()) this.voice.pause(); return -1; }
      const t = v.currentTime;
      const i = findSegmentIndex(segs, t);

      for (let k = Math.max(i, 0); k <= i + this.AHEAD && k < segs.length; k++) this.prepare(k, false);

      if (i !== this.lastIdx) {
        this.lastIdx = i;
        this.armed = -1;
        if (i >= 0 && t - segs[i].start <= this.ENTER_WINDOW) {
          if (this.delayFor(i) > 0) this.armed = i;
          else this.enter(i);
        }
      }
      // listen to the original speaker briefly, then voice the segment
      if (this.armed >= 0 && this.armed === i && t >= segs[i].start + this.delayFor(i)) {
        this.armed = -1;
        this.enter(i);
      }

      if (this.pending >= 0) {
        const p = this.pending;
        if (this.isReady(p)) {
          this.pending = -1;
          const waited = this.pausedByDub && this.pauseReason === "loading";
          if (waited) this.resumeVideo();
          if (waited || t <= segs[p].end) this.startVoice(p);
        } else if (this.pausedByDub && this.pauseReason === "loading") {
          if (this.now() - this.pendingSince > this.LOAD_TIMEOUT) { this.pending = -1; this.resumeVideo(); }
        } else if (t > segs[p].end) {
          this.pending = -1;
        }
      }
      return i;
    }

    delayFor(i) {
      const d = this.startDelay();
      if (!(d > 0)) return 0;
      const segs = this.segments();
      const next = segs[i + 1];
      const slot = (next ? next.start : segs[i].end) - segs[i].start;
      return Math.min(d, slot * 0.35);
    }

    mode() { return this.settings().overrun === "pause" ? "pause" : "speed"; }

    enter(i) {
      if (this.voice.isPlaying()) {
        if (this.mode() === "pause") {
          this.queued = i;
          this.pauseVideo("overrun");
          return;
        }
        if (this.voice.remaining() <= 1.2) { this.queued = i; return; }
        this.stopVoice();
      }
      this.queued = -1;
      this.startOrWait(i);
    }

    startOrWait(i) {
      const seg = this.segments()[i];
      if (!seg || seg.skip) return;
      this.beforeStart(i);
      if (!this.isReady(i)) {
        this.prepare(i, true);
        this.pending = i;
        if (this.mode() === "pause") { this.pendingSince = this.now(); this.pauseVideo("loading"); }
        return;
      }
      this.startVoice(i);
    }

    startVoice(i) {
      const segs = this.segments();
      const seg = segs[i];
      if (!seg || seg.skip) return;
      const s = this.settings();
      const next = segs[i + 1];
      // time actually left before the next segment (we may be starting a little late), with a small margin
      const from = Math.max(seg.start, this.video.currentTime);
      const slot = Math.max(0.4, ((next ? next.start : seg.end) - from) * 0.93);
      const rate = computeRate(seg.audioDur, slot, this.video.playbackRate || 1,
                               s.voiceSpeed || 1, s.maxSpeed || 1.8, this.mode());
      const token = ++this.playToken;
      this.playingIdx = i;
      this.playingSeg = seg;
      Promise.resolve(this.voice.play(seg, rate)).then(() => {
        if (token === this.playToken) this.onVoiceEnded();
      }, () => {
        if (token === this.playToken) this.onVoiceEnded();
      });
    }

    onVoiceEnded() {
      this.playingIdx = -1;
      this.playingSeg = null;
      if (this.pausedByDub && this.pauseReason === "overrun") this.resumeVideo();
      if (this.queued >= 0) {
        const q = this.queued;
        this.queued = -1;
        const segs = this.segments();
        if (this.mode() === "pause" || this.video.currentTime <= segs[q].end + 0.3) this.startOrWait(q);
      }
    }

    stopVoice() {
      this.playToken++;
      this.voice.stop();
      this.playingIdx = -1;
      this.playingSeg = null;
    }

    pauseVideo(reason) {
      this.pausedByDub = true;
      this.pauseReason = reason;
      if (!this.video.paused) this.video.pause();
    }

    resumeVideo() {
      this.pausedByDub = false;
      this.pauseReason = "";
      if (this.video.paused) this.video.play();
    }

    // ---- video events
    onSeek() {
      this.armed = -1;
      this.stopVoice();
      this.queued = -1;
      this.pending = -1;
      this.pausedByDub = false;
      this.lastIdx = -2;
    }

    onPause() {
      if (this.pausedByDub) return;           // our own pause
      this.voice.pause();
    }

    onPlay() {
      if (this.pausedByDub) {                 // user pressed play while we were waiting
        this.pausedByDub = false;
        if (this.pauseReason === "loading") this.pending = -1;
        this.pauseReason = "";
      }
      this.voice.resume();
    }

    onRateChange() {
      const r = this.video.playbackRate || 1;
      if (this.voice.isPlaying() && this.lastVideoRate > 0) this.voice.setRate(null, r / this.lastVideoRate);
      this.lastVideoRate = r;
    }
  }

  // ------------------------------------------------------------ speaker gender

  /**
   * Fundamental frequency of a short audio frame (McLeod pitch method on a
   * downsampled signal). Returns {f0, clarity, rms}; f0 is 0 when the frame
   * is silent or not clearly voiced.
   */
  function detectPitch(buf, sampleRate, opts) {
    const o = Object.assign({ minF: 65, maxF: 330, minRms: 0.004, minClarity: 0.8 }, opts || {});
    const step = Math.max(1, Math.floor(sampleRate / 12000));   // ~12 kHz is plenty for voice pitch
    const sr = sampleRate / step;
    const n = Math.floor(buf.length / step);
    const x = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < step; k++) a += buf[i * step + k]; x[i] = a / step; mean += x[i]; }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    const rms = Math.sqrt(energy / n);
    if (rms < o.minRms) return { f0: 0, clarity: 0, rms };

    const minLag = Math.max(2, Math.floor(sr / o.maxF));
    const maxLag = Math.min(n - 2, Math.ceil(sr / o.minF));
    const nsdf = new Float32Array(maxLag + 2);
    for (let tau = minLag - 1; tau <= maxLag + 1; tau++) {
      let r = 0, m = 0;
      for (let i = 0; i + tau < n; i++) { r += x[i] * x[i + tau]; m += x[i] * x[i] + x[i + tau] * x[i + tau]; }
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }
    // collect local maxima, pick the first one close to the best (avoids octave errors)
    const peaks = [];
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (nsdf[tau] > 0 && nsdf[tau] >= nsdf[tau - 1] && nsdf[tau] > nsdf[tau + 1]) peaks.push(tau);
    }
    if (!peaks.length) return { f0: 0, clarity: 0, rms };
    const best = Math.max(...peaks.map((t) => nsdf[t]));
    let tau = peaks.find((t) => nsdf[t] >= 0.9 * best);
    // octave check: if half the period is almost as periodic, the true pitch is one octave higher
    const half = Math.round(tau / 2);
    if (half >= minLag) {
      let h = half;
      for (const d of [-1, 1]) if (nsdf[half + d] > nsdf[h]) h = half + d;
      if (nsdf[h] >= 0.75 * nsdf[tau] && nsdf[h] >= o.minClarity * 0.9) tau = h;
    }
    const a = nsdf[tau - 1], b = nsdf[tau], c = nsdf[tau + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const f0 = sr / (tau + shift);
    if (b < o.minClarity || f0 < o.minF || f0 > o.maxF) return { f0: 0, clarity: b, rms };
    return { f0, clarity: b, rms };
  }

  /** Gender from a list of pitch readings (Hz). prev keeps the answer stable in the overlap zone. */
  function genderFromPitches(f0s, prev, minCount) {
    const v = (f0s || []).filter((f) => f > 0).sort((a, b) => a - b);
    if (v.length < (minCount || 4)) return null;
    const med = v[v.length >> 1];
    // human speech pitch keeps moving; a perfectly steady pitch is an instrument, not a voice
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / v.length);
    if (v.length >= 5 && sd / mean < 0.004) return null;
    if (med < 155) return "male";
    if (med > 180) return "female";
    return prev || (med < 167 ? "male" : "female");
  }

  // ------------------------------------------------------------ voice deepening (free male voice)

  /**
   * Change duration without changing pitch (WSOLA). Output length = input length * rate.
   */
  function timeStretch(x, sr, rate) {
    const N = Math.max(64, Math.round(sr * 0.04) & ~1);   // 40 ms frames
    const Hs = N >> 1;                                     // output hop
    const Ha = Hs / rate;                                  // input hop
    const tol = Math.round(sr * 0.012);                    // search +-12 ms for best alignment
    const outLen = Math.max(1, Math.round(x.length * rate));
    const out = new Float32Array(outLen + N);
    const norm = new Float32Array(outLen + N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const at = (i) => (i >= 0 && i < x.length ? x[i] : 0);

    let prev = 0;                                          // input position of the previous frame
    for (let k = 0; k * Hs < outLen; k++) {
      const nominal = Math.round(k * Ha);
      let pos = nominal;
      if (k > 0) {
        const target = prev + Hs;                          // natural continuation of the previous frame
        let best = -Infinity;
        for (let d = -tol; d <= tol; d += 2) {
          const c0 = nominal + d;
          let c = 0;
          for (let i = 0; i < N; i += 4) c += at(c0 + i) * at(target + i);
          if (c > best) { best = c; pos = c0; }
        }
      }
      const o = k * Hs;
      for (let i = 0; i < N; i++) { out[o + i] += at(pos + i) * win[i]; norm[o + i] += win[i]; }
      prev = pos;
    }
    const y = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) y[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
    return y;
  }

  /** Linear resampling to a new length. */
  function resample(x, len) {
    const y = new Float32Array(len);
    const r = (x.length - 1) / Math.max(1, len - 1);
    for (let i = 0; i < len; i++) {
      const p = i * r, a = Math.floor(p), f = p - a;
      y[i] = x[a] * (1 - f) + (a + 1 < x.length ? x[a + 1] : 0) * f;
    }
    return y;
  }

  /**
   * Lower (factor < 1) or raise the pitch and voice timbre, keeping the duration.
   * Used to turn the female Google voice into a deeper, male-sounding voice.
   */
  function shiftPitch(x, sr, factor) {
    if (!(factor > 0) || Math.abs(factor - 1) < 0.01) return x;
    const shorter = timeStretch(x, sr, factor);          // same pitch, length * factor
    return resample(shorter, x.length);                  // stretched back: pitch * factor
  }

  /** 16-bit mono WAV file from float samples. */
  function encodeWav(samples, sr) {
    const out = new Uint8Array(44 + samples.length * 2);
    const dv = new DataView(out.buffer);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
    str(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, samples.length * 2, true);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const g = peak > 0.99 ? 0.99 / peak : 1;
    for (let i = 0; i < samples.length; i++) {
      dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i] * g)) * 32767), true);
    }
    return out;
  }

  // Gemini prebuilt voices (genders as listed by Google for the same voice set)
  const GEMINI_VOICES = {
    male: ["Charon", "Puck", "Orus", "Fenrir", "Iapetus", "Algenib", "Algieba", "Alnilam", "Achird",
           "Enceladus", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Umbriel", "Zubenelgenubi"],
    female: ["Kore", "Aoede", "Leda", "Zephyr", "Achernar", "Autonoe", "Callirrhoe", "Despina", "Erinome",
             "Gacrux", "Laomedeia", "Pulcherrima", "Sulafat", "Vindemiatrix"],
  };

  // Known natural Bangla voices in Microsoft Edge / Windows
  const SYSTEM_VOICE_GENDER = { pradeep: "male", bashkar: "male", nabanita: "female", tanishaa: "female" };
  function systemVoiceGender(name) {
    const n = String(name || "").toLowerCase();
    for (const k in SYSTEM_VOICE_GENDER) if (n.includes(k)) return SYSTEM_VOICE_GENDER[k];
    if (/\bmale\b/.test(n)) return "male";
    if (/female/.test(n)) return "female";
    return null;
  }

  // ------------------------------------------------------------ translation check

  const SCRIPTS = {
    bn: /[\u0980-\u09FF]/, hi: /[\u0900-\u097F]/, mr: /[\u0900-\u097F]/, ne: /[\u0900-\u097F]/,
    ur: /[\u0600-\u06FF]/, ar: /[\u0600-\u06FF]/, fa: /[\u0600-\u06FF]/,
    ta: /[\u0B80-\u0BFF]/, te: /[\u0C00-\u0C7F]/, ru: /[\u0400-\u04FF]/,
  };

  /**
   * Is this text really in the target language's script? Untranslated lines
   * (for example still in Hindi) must never be read aloud. English terms in
   * Latin letters are allowed inside a sentence.
   */
  function isInTargetScript(text, lang) {
    const re = SCRIPTS[String(lang || "").split("-")[0]];
    const t = String(text || "");
    if (!t.trim()) return false;
    if (!re) return true;                       // Latin-script targets: cannot check this way
    let own = 0, latin = 0, other = 0;
    for (const ch of t) {
      if (re.test(ch)) own++;
      else if (/[A-Za-z]/.test(ch)) latin++;
      else if (/\p{L}/u.test(ch)) other++;
    }
    const letters = own + latin + other;
    if (letters === 0) return true;             // numbers / punctuation only
    if (other > letters * 0.1) return false;    // e.g. Devanagari left in a Bangla line
    return own > 0 || letters <= 12;            // pure Latin allowed only for a short term
  }

  // ------------------------------------------------------------ settings

  const DEFAULTS = {
    targetLang: "bn",
    providerId: "google",     // "google" or the id of an AI provider
    ttsEngine: "google",      // "google" (online, free; male = deepened), "gemini" (male + female, needs Gemini key),
                              // "system" (voices installed in the browser; natural Bangla voices in Edge)
    voiceGender: "auto",      // "auto" (detect speaker), "male", "female"
    listenDelay: 0.45,        // s to listen to the speaker before voicing (auto gender only)
    systemVoice: "",
    systemVoiceMale: "",
    systemVoiceFemale: "",
    maleDepth: 0.72,          // pitch factor that turns the female Google voice into a male voice
    geminiTtsModel: "gemini-3.1-flash-tts-preview",
    geminiVoiceMale: "Charon",
    geminiVoiceFemale: "Kore",
    originalVolume: 0.15,     // original video volume while dubbing (0..1)
    voiceVolume: 1,
    voiceSpeed: 1,
    maxSpeed: 1.8,
    overrun: "speed",         // "speed": speed voice up to fit; "pause": pause video until voice finishes
    showSubs: true,
    subSize: 22,
    hideOriginal: true,
    autoStart: false,
    keepOnNext: true,
    extraPrompt: "",
    providers: [],            // [{id, name, type: "openai"|"anthropic"|"gemini", baseUrl, apiKey, model}]
  };

  async function loadSettings() {
    const r = await chrome.storage.local.get("settings");
    return Object.assign({}, DEFAULTS, r.settings || {});
  }

  async function saveSettings(patch) {
    const cur = await loadSettings();
    const next = Object.assign(cur, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  const api = {
    DEFAULTS, loadSettings, saveSettings, langName, cleanText, decodeEntities, parseCaptions, groupCues, makeBatches, orderBatches,
    parseNumbered, splitForTts, findSegmentIndex, computeRate, DubSync,
    detectPitch, genderFromPitches, GEMINI_VOICES, systemVoiceGender,
    timeStretch, resample, shiftPitch, encodeWav, isInTargetScript,
  };
  root.LiveDub = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* Live Dub app - defaults that differ from the Chrome extension. Runs after core.js. */
Object.assign(window.LiveDub.DEFAULTS, {
  ttsEngine: "android",        // phone's own text-to-speech: free, offline, no limits
  voiceGender: "male",         // one steady voice by default; "auto" can be chosen in settings
  androidVoiceMale: "",        // empty: the phone's default voice for the language
  androidVoiceFemale: "",
  autoStart: true,             // dub as soon as a video opens in the app
  keepOnNext: true,
  originalVolume: 0.1,
});

__ldBgLoading = true;
(function () { var importScripts = function () {}; var fetch = __ldFetch; var self = window;
/* Live Dub - background service worker: translation, voice and model lists. */
importScripts("core.js");
const LD = self.LiveDub;

const DEFAULT_BASE = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg)
    .then((r) => sendResponse(Object.assign({ ok: true }, r)))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-dub") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
});

async function handle(msg) {
  switch (msg.type) {
    case "translate": return { lines: await translateLines(msg) };
    case "tts": return await googleTts(msg.text, msg.lang);
    case "ttsGemini": return await geminiTts(msg.text, msg.gender, msg.voice);
    case "listModels": return { models: await listModels(msg.provider) };
    default: throw new Error("Unknown request: " + msg.type);
  }
}

// ------------------------------------------------------------ helpers

async function fetchRetry(url, init, tries = 3) {
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) {
        last = new Error(await errorText(r));
        if (a < tries) await sleep(2000 * a * a);
        continue;
      }
      return r;
    } catch (e) {
      last = e;
      await sleep(1000 * a);
    }
  }
  throw last;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function errorText(r) {
  let t = "";
  try { t = await r.text(); } catch (e) { /* ignore */ }
  try {
    const j = JSON.parse(t);
    t = (j.error && (j.error.message || j.error.type || JSON.stringify(j.error))) || t;
  } catch (e) { /* not json */ }
  return `HTTP ${r.status}: ${String(t).slice(0, 300)}`;
}

function base(provider) {
  return (provider.baseUrl || DEFAULT_BASE[provider.type] || "").replace(/\/+$/, "");
}

// ------------------------------------------------------------ translation

async function translateLines({ lines, provider, lang, title, context, extraPrompt, src }) {
  if (!lines || !lines.length) return [];
  if (!provider || provider.type === "google") return googleTranslate(lines, lang, src);

  const out = await aiTranslate(lines, provider, lang, title, context, extraPrompt);
  const missing = out.map((x, i) => (x === null ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {                   // fill anything the AI skipped with Google
    const filled = await googleTranslate(missing.map((i) => lines[i]), lang, src);
    missing.forEach((i, k) => { out[i] = filled[k]; });
  }
  return out;
}

async function googleTranslate(lines, lang, src) {
  const sl = src ? String(src).split("-")[0] : "auto";   // the caption language, so detection cannot go wrong
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(lang)}&dt=t`;
  const joined = lines.join("\n");
  let r = await fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ q: joined }).toString(),
  });
  if (!r.ok && joined.length < 1800) r = await fetchRetry(url + "&q=" + encodeURIComponent(joined));
  if (!r.ok) {
    if (lines.length > 1) {               // split and try again
      const mid = lines.length >> 1;
      return (await googleTranslate(lines.slice(0, mid), lang, src))
        .concat(await googleTranslate(lines.slice(mid), lang, src));
    }
    throw new Error("Google Translate: " + (await errorText(r)));
  }
  const data = await r.json();
  const text = (data[0] || []).map((x) => x[0] || "").join("");
  const parts = text.split("\n").map((s) => s.trim());
  if (parts.length === lines.length) return parts;
  if (lines.length === 1) return [text.trim()];
  const mid = lines.length >> 1;          // line count changed: translate halves separately
  return (await googleTranslate(lines.slice(0, mid), lang, src))
    .concat(await googleTranslate(lines.slice(mid), lang, src));
}

function buildPrompt(lines, lang, title, context, extraPrompt) {
  const name = LD.langName(lang);
  const system =
    `You are a professional subtitle translator. Translate YouTube subtitle lines into ${name}. ` +
    "The translation will be read aloud by a voice in sync with the video, so it must sound natural when spoken " +
    "and be about as short as the original. Lines are often fragments of a longer sentence that continues on the " +
    "next line; translate so the lines read naturally in sequence, but keep each line's content on its own line. " +
    "Keep names, numbers and technical terms accurate; keep a common English term in English script if speakers " +
    `of ${name} normally use it. ` +
    "Answer with exactly one output line per input line, in the form `N: translation`, using the same numbers. " +
    "Never merge, split or skip lines. Output nothing else." +
    (extraPrompt ? "\nAdditional instructions: " + extraPrompt : "");
  let user = "";
  if (title) user += `Video title: ${title}\n\n`;
  if (context && context.length) {
    user += "Previous lines, for context only (do not translate):\n" + context.join("\n") + "\n\n";
  }
  user += `Translate these ${lines.length} lines:\n` + lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
  return { system, user };
}

const GEMINI_BACKUP_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"];

async function aiTranslate(lines, provider, lang, title, context, extraPrompt) {
  const { system, user } = buildPrompt(lines, lang, title, context, extraPrompt);
  let text;
  try {
    text = await aiChat(provider, system, user);
  } catch (e) {
    const busy = /HTTP (5\d\d|404|429)|overload|unavailable|no longer available/i.test(String(e.message));
    if (provider.type !== "gemini" || !busy) throw e;
    let lastErr = e;
    for (const m of GEMINI_BACKUP_MODELS.filter((x) => x !== provider.model)) {
      try { text = await aiChat(Object.assign({}, provider, { model: m }), system, user); break; }
      catch (e2) { lastErr = e2; }
    }
    if (text == null) throw lastErr;
  }
  return LD.parseNumbered(text, lines.length);
}

async function aiChat(p, system, user) {
  if (!p.apiKey && !/localhost|127\.0\.0\.1/.test(p.baseUrl || "")) throw new Error(`${p.name}: API key is missing`);
  if (!p.model) throw new Error(`${p.name}: model is not set`);
  const b = base(p);
  let r;
  if (p.type === "anthropic") {
    r = await fetchRetry(`${b}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": p.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: p.model, max_tokens: 8000, system, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) throw new Error(`${p.name}: ` + (await errorText(r)));
    const j = await r.json();
    return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  if (p.type === "gemini") {
    const model = p.model.replace(/^models\//, "");
    r = await fetchRetry(`${b}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": p.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
      }),
    });
    if (!r.ok) throw new Error(`${p.name}: ` + (await errorText(r)));
    const j = await r.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    return parts.filter((x) => !x.thought).map((x) => x.text || "").join("");
  }
  // OpenAI-compatible (ChatGPT, DeepSeek, Grok, OpenRouter, Groq, Ollama, ...)
  const headers = { "content-type": "application/json" };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  r = await fetchRetry(`${b}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`${p.name}: ` + (await errorText(r)));
  const j = await r.json();
  const c = (((j.choices || [])[0] || {}).message || {}).content;
  return Array.isArray(c) ? c.map((x) => x.text || "").join("") : (c || "");
}

async function listModels(p) {
  const b = base(p);
  let r, j;
  if (p.type === "anthropic") {
    r = await fetch(`${b}/v1/models?limit=100`, {
      headers: { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    });
    if (!r.ok) throw new Error(await errorText(r));
    j = await r.json();
    return (j.data || []).map((m) => m.id);
  }
  if (p.type === "gemini") {
    r = await fetch(`${b}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": p.apiKey } });
    if (!r.ok) throw new Error(await errorText(r));
    j = await r.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
  }
  const headers = {};
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  r = await fetch(`${b}/models`, { headers });
  if (!r.ok) throw new Error(await errorText(r));
  j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

// ------------------------------------------------------------ Google voice

async function googleTts(text, lang) {
  const pieces = LD.splitForTts(text, 180);
  const bufs = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const q = `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(p)}&total=${pieces.length}&idx=${i}&textlen=${p.length}`;
    const urls = [
      "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob" + q,
      "https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx" + q,
    ];
    let got = null, last = null;
    for (let attempt = 0; attempt < 4 && !got; attempt++) {
      const url = urls[attempt % urls.length];          // alternate between the two Google servers
      try {
        const r = await fetch(url, { credentials: "omit" });
        if (r.ok) {
          const b = new Uint8Array(await r.arrayBuffer());
          if (b.length > 100) got = b; else last = new Error("empty audio");
        } else last = new Error("HTTP " + r.status);
      } catch (e) { last = e; }
      if (!got) await sleep(400 * (attempt + 1));
    }
    if (!got) throw new Error("Google voice: " + ((last && last.message) || "failed"));
    bufs.push(got);
  }
  const total = bufs.reduce((n, b) => n + b.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { all.set(b, off); off += b.length; }
  return { audio: toBase64(all), mime: "audio/mpeg" };
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------ Gemini voice (male + female)

async function geminiTts(text, gender, voiceOverride) {
  const st = await LD.loadSettings();
  const p = (st.providers || []).find((x) => x.type === "gemini" && x.apiKey);
  if (!p) throw new Error("Gemini voice needs a Gemini API key: add a Gemini translator in Live Dub settings");
  const voice = voiceOverride || (gender === "female" ? st.geminiVoiceFemale : st.geminiVoiceMale) || "Kore";
  const model = (st.geminiTtsModel || "gemini-3.1-flash-tts-preview").replace(/^models\//, "");
  const b = (p.baseUrl || DEFAULT_BASE.gemini).replace(/\/+$/, "");
  const headers = { "content-type": "application/json", "x-goog-api-key": p.apiKey };
  let data = null, mime = "";

  // Current API (Interactions)
  let r = await fetchRetry(`${b}/v1beta/interactions`, {
    method: "POST", headers,
    body: JSON.stringify({
      model,
      input: [{ type: "user_input", content: [{ type: "text", text }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    }),
  }, 2);
  if (r.ok) {
    const j = await r.json();
    for (const step of j.steps || []) {
      for (const c of step.content || []) if (c.type === "audio" && c.data) { data = c.data; mime = c.mime_type || c.mimeType || ""; }
    }
    if (!data && j.output_audio && j.output_audio.data) data = j.output_audio.data;
  } else if (r.status === 429) {
    throw new Error("Gemini voice: " + (await errorText(r)));
  } else {
    // Older API (generateContent with audio output)
    r = await fetchRetry(`${b}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    }, 2);
    if (!r.ok) throw new Error("Gemini voice: " + (await errorText(r)));
    const j = await r.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const part = parts.find((x) => x.inlineData && x.inlineData.data);
    if (part) { data = part.inlineData.data; mime = part.inlineData.mimeType || ""; }
  }
  if (!data) throw new Error("Gemini voice: no audio in the answer");

  let bytes = fromBase64(data);
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  if (!isRiff) {                                   // raw 16-bit PCM -> add a WAV header
    const m = /rate=(\d+)/.exec(mime);
    bytes = pcmToWav(bytes, m ? +m[1] : 24000);
  }
  return { audio: toBase64(bytes), mime: "audio/wav" };
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pcmToWav(pcm, rate) {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  str(0, "RIFF"); dv.setUint32(4, 36 + pcm.length, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// exported for tests
self.__liveDubTest = { translateLines, googleTranslate, buildPrompt, aiChat, listModels, googleTts, geminiTts, pcmToWav };

})();
__ldBgLoading = false;
/* Live Dub - settings page. */
(async () => {
  "use strict";
  const LD = window.LiveDub;
  const $ = (id) => document.getElementById(id);
  let settings = await LD.loadSettings();

  const PRESETS = {
    openai:     { name: "ChatGPT", type: "openai", baseUrl: "https://api.openai.com/v1" },
    anthropic:  { name: "Claude", type: "anthropic", baseUrl: "https://api.anthropic.com" },
    gemini:     { name: "Gemini", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
    deepseek:   { name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1" },
    grok:       { name: "Grok", type: "openai", baseUrl: "https://api.x.ai/v1" },
    openrouter: { name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1" },
    groq:       { name: "Groq", type: "openai", baseUrl: "https://api.groq.com/openai/v1" },
    ollama:     { name: "Ollama", type: "openai", baseUrl: "http://localhost:11434/v1" },
    custom:     { name: "My AI", type: "openai", baseUrl: "" },
  };
  const BUILT_IN_HOSTS = ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"];

  // ------------------------------------------------------------ providers

  const list = $("providers");
  let counter = 0;

  function addCard(p) {
    const node = $("providerTpl").content.firstElementChild.cloneNode(true);
    node.dataset.id = p.id;
    const q = (c) => node.querySelector(c);
    q(".p-name").value = p.name || "";
    q(".p-type").value = p.type || "openai";
    q(".p-base").value = p.baseUrl || "";
    q(".p-key").value = p.apiKey || "";
    q(".p-model").value = p.model || "";
    const dl = q("datalist");
    dl.id = "models-" + (++counter);
    q(".p-model").setAttribute("list", dl.id);

    q(".p-remove").addEventListener("click", () => node.remove());
    q(".p-show").addEventListener("click", () => {
      const k = q(".p-key");
      k.type = k.type === "password" ? "text" : "password";
      q(".p-show").textContent = k.type === "password" ? "Show" : "Hide";
    });
    q(".p-models").addEventListener("click", async () => {
      const prov = readCard(node);
      if (!(await askPermission([prov]))) return msg(node, "Permission for this server was not granted.", "error");
      msg(node, "Loading models...");
      const r = await chrome.runtime.sendMessage({ type: "listModels", provider: prov });
      if (!r.ok) return msg(node, "Could not load models: " + r.error, "error");
      dl.innerHTML = "";
      for (const m of r.models) dl.appendChild(new Option(m, m));
      msg(node, `${r.models.length} models found. Click the Model box to pick one.`, "ok");
      q(".p-model").focus();
    });
    q(".p-test").addEventListener("click", async () => {
      const prov = readCard(node);
      if (!(await askPermission([prov]))) return msg(node, "Permission for this server was not granted.", "error");
      msg(node, "Testing...");
      const t0 = Date.now();
      const r = await chrome.runtime.sendMessage({
        type: "translate", provider: prov, lang: $("targetLang").value,
        lines: ["So today we are going to look at how rivers", "change their course over many years."],
      });
      if (!r.ok) return msg(node, "Failed: " + r.error, "error");
      msg(node, `Works (${((Date.now() - t0) / 1000).toFixed(1)} s):\n1: ${r.lines[0]}\n2: ${r.lines[1]}`, "ok");
    });
    list.appendChild(node);
    return node;
  }

  function readCard(node) {
    const q = (c) => node.querySelector(c);
    return {
      id: node.dataset.id,
      name: q(".p-name").value.trim() || "AI",
      type: q(".p-type").value,
      baseUrl: q(".p-base").value.trim().replace(/\/+$/, ""),
      apiKey: q(".p-key").value.trim(),
      model: q(".p-model").value.trim(),
    };
  }

  function msg(node, text, kind) {
    const m = node.querySelector(".p-msg");
    m.textContent = text;
    m.className = "msg p-msg " + (kind || "");
  }

  function originsFor(providers) {
    const out = new Set();
    for (const p of providers) {
      try {
        const u = new URL(p.baseUrl);
        if (BUILT_IN_HOSTS.includes(u.hostname)) continue;
        out.add(`${u.protocol}//${u.hostname}/*`);
      } catch (e) { /* invalid url, reported elsewhere */ }
    }
    return [...out];
  }

  // Must be called directly from a click, before other awaits.
  function askPermission(providers) {
    const origins = originsFor(providers);
    if (!origins.length) return Promise.resolve(true);
    return chrome.permissions.request({ origins }).catch(() => false);
  }

  $("addProvider").addEventListener("click", () => {
    const pr = PRESETS[$("preset").value];
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const node = addCard(Object.assign({ id, apiKey: "", model: "" }, pr));
    node.querySelector(".p-key").focus();
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  for (const p of settings.providers) addCard(p);

  // ------------------------------------------------------------ general

  const tl = $("targetLang");
  if (![...tl.options].some((o) => o.value === settings.targetLang)) tl.add(new Option(settings.targetLang, settings.targetLang));
  tl.value = settings.targetLang;
  $("extraPrompt").value = settings.extraPrompt;
  $("voiceVolume").value = settings.voiceVolume;
  $("maxSpeed").value = String(settings.maxSpeed);
  $("subSize").value = String(settings.subSize);
  for (const k of ["keepOnNext", "autoStart", "hideOriginal"]) $(k).checked = !!settings[k];

  // ---- voices
  const gm = $("geminiVoiceMale"), gf = $("geminiVoiceFemale");
  for (const n of LD.GEMINI_VOICES.male) gm.add(new Option(n, n));
  for (const n of LD.GEMINI_VOICES.female) gf.add(new Option(n, n));
  gm.value = settings.geminiVoiceMale;
  gf.value = settings.geminiVoiceFemale;
  $("geminiTtsModel").value = settings.geminiTtsModel;
  $("listenDelay").value = String(settings.listenDelay);
  $("maleDepth").value = String(settings.maleDepth);
  if (!$("maleDepth").value) $("maleDepth").value = "0.72";
  if (!$("listenDelay").value) $("listenDelay").value = "0.45";

  function fillSystemVoices() {
    const all = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(tl.value));
    for (const [id, g] of [["systemVoiceMale", "male"], ["systemVoiceFemale", "female"]]) {
      const el = $(id);
      el.innerHTML = "";
      el.add(new Option("Automatic", ""));
      for (const v of all) el.add(new Option(`${v.name} (${v.lang})${LD.systemVoiceGender(v.name) === g ? "  *" : ""}`, v.name));
      el.value = all.some((v) => v.name === settings[id]) ? settings[id] : "";
    }
  }
  speechSynthesis.onvoiceschanged = fillSystemVoices;
  fillSystemVoices();

  let testAudio = null;
  async function testVoice(gender) {
    const m = $("geminiMsg");
    // save the voice choices first so the test uses them
    settings = await LD.saveSettings({ providers: [...list.children].map(readCard),
                                       geminiVoiceMale: gm.value, geminiVoiceFemale: gf.value,
                                       geminiTtsModel: $("geminiTtsModel").value.trim() || LD.DEFAULTS.geminiTtsModel });
    m.textContent = "Generating...";
    m.className = "msg";
    const sample = tl.value === "bn"
      ? "\u0986\u099c \u0986\u09ae\u09b0\u09be \u09a8\u09a6\u09c0\u09b0 \u0997\u09a4\u09bf\u09aa\u09a5 \u09a8\u09bf\u09af\u09bc\u09c7 \u0995\u09a5\u09be \u09ac\u09b2\u09ac\u0964"
      : "Today we will talk about how rivers change their course.";
    const r = await chrome.runtime.sendMessage({ type: "ttsGemini", text: sample, gender });
    if (!r.ok) { m.textContent = "Failed: " + r.error; m.className = "msg error"; return; }
    if (testAudio) testAudio.pause();
    testAudio = new Audio(`data:${r.mime};base64,${r.audio}`);
    testAudio.play();
    m.textContent = `Playing ${gender} voice (${gender === "male" ? gm.value : gf.value}).`;
    m.className = "msg ok";
  }
  $("testMale").addEventListener("click", () => testVoice("male"));
  $("testFemale").addEventListener("click", () => testVoice("female"));

  $("save").addEventListener("click", async () => {
    const providers = [...list.children].map(readCard);
    const granted = await askPermission(providers);
    const bad = providers.filter((p) => { try { new URL(p.baseUrl); return false; } catch (e) { return true; } });
    const patch = {
      providers,
      extraPrompt: $("extraPrompt").value.trim(),
      targetLang: tl.value,
      voiceVolume: +$("voiceVolume").value,
      maxSpeed: +$("maxSpeed").value,
      subSize: +$("subSize").value,
      keepOnNext: $("keepOnNext").checked,
      autoStart: $("autoStart").checked,
      hideOriginal: $("hideOriginal").checked,
      geminiVoiceMale: gm.value,
      geminiVoiceFemale: gf.value,
      geminiTtsModel: $("geminiTtsModel").value.trim() || LD.DEFAULTS.geminiTtsModel,
      systemVoiceMale: $("systemVoiceMale").value,
      systemVoiceFemale: $("systemVoiceFemale").value,
      listenDelay: +$("listenDelay").value,
      maleDepth: +$("maleDepth").value,
    };
    if (!providers.some((p) => p.id === settings.providerId)) patch.providerId = "google";
    settings = await LD.saveSettings(patch);
    const m = $("saveMsg");
    if (bad.length) { m.textContent = `Saved, but check the server address of: ${bad.map((p) => p.name).join(", ")}`; m.className = "msg warn"; }
    else if (!granted) { m.textContent = "Saved, but permission for a custom server was refused; that translator will not work."; m.className = "msg warn"; }
    else { m.textContent = "Saved. Choose the translator from the Live Dub button in the toolbar."; m.className = "msg ok"; }
  });

  $("clearCache").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("tr:"));
    await chrome.storage.local.remove(keys.concat("trIndex"));
    $("cacheMsg").textContent = `Deleted ${keys.length} saved translations.`;
    $("cacheMsg").className = "msg ok";
  });
})();

/* Live Dub app - "Playback" section of the settings screen (what the toolbar popup does in Chrome). */
(async function () {
  "use strict";
  var LD = window.LiveDub;
  var $ = function (id) { return document.getElementById(id); };
  var settings = await LD.loadSettings();

  async function save(patch) { settings = await LD.saveSettings(patch); }

  // ---- translator list (rebuilt when AI translators are saved below)
  function fillProviders() {
    var sel = $("q-providerId");
    sel.innerHTML = "";
    sel.add(new Option("Google Translate (free)", "google"));
    (settings.providers || []).forEach(function (p) {
      sel.add(new Option(p.name + (p.model ? " - " + p.model : ""), p.id));
    });
    sel.value = (settings.providers || []).some(function (p) { return p.id === settings.providerId; }) ? settings.providerId : "google";
  }
  fillProviders();
  $("q-providerId").addEventListener("change", function () { save({ providerId: $("q-providerId").value }); });
  chrome.storage.onChanged.addListener(function (ch) {
    if (ch.settings) { settings = Object.assign({}, LD.DEFAULTS, ch.settings.newValue || {}); fillProviders(); }
  });

  // ---- voice engine + speaker voice
  $("q-ttsEngine").value = settings.ttsEngine === "system" ? "android" : settings.ttsEngine;
  $("q-voiceGender").value = settings.voiceGender;
  function showEngine() {
    $("phoneVoices").hidden = $("q-ttsEngine").value !== "android";
  }
  showEngine();
  $("q-ttsEngine").addEventListener("change", function () { save({ ttsEngine: $("q-ttsEngine").value }); showEngine(); });
  $("q-voiceGender").addEventListener("change", function () { save({ voiceGender: $("q-voiceGender").value }); });

  // ---- phone voices
  var tries = 0;
  async function fillPhoneVoices() {
    var r = await chrome.runtime.sendMessage({ type: "androidVoices", lang: settings.targetLang });
    var list = (r && r.voices) || [];
    if (!list.length && tries++ < 10) { setTimeout(fillPhoneVoices, 700); return; }
    ["androidVoiceMale", "androidVoiceFemale"].forEach(function (key) {
      var el = $("q-" + key);
      el.innerHTML = "";
      el.add(new Option("Phone default voice", ""));
      list.forEach(function (v) {
        var label = v.name + (v.network ? " (online)" : "") + (v.installed === false ? " (not installed)" : "");
        el.add(new Option(label, v.name));
      });
      el.value = list.some(function (v) { return v.name === settings[key]; }) ? settings[key] : "";
    });
    var note = $("phoneNote");
    if (!list.length) {
      note.className = "msg warn";
      note.textContent = "No Bangla voice found on this phone. Tap 'Install Bangla voice', choose Google's speech engine, " +
        "open its settings, Install voice data, and download Bangla (Bangladesh). Then reopen this screen.";
    } else {
      note.className = "msg";
      note.textContent = list.length + " Bangla voices found. Use the test buttons to find a male and a female voice.";
    }
  }
  fillPhoneVoices();
  ["androidVoiceMale", "androidVoiceFemale"].forEach(function (key) {
    $("q-" + key).addEventListener("change", function () { var p = {}; p[key] = $("q-" + key).value; save(p); });
  });

  var testAudio = null;
  async function testPhone(gender) {
    var m = $("phoneTestMsg");
    m.textContent = "Preparing...";
    m.className = "msg";
    var key = gender === "male" ? "androidVoiceMale" : "androidVoiceFemale";
    var p = {}; p[key] = $("q-" + key).value;
    await save(p);
    var sample = settings.targetLang === "bn"
      ? "\u0986\u099c \u0986\u09ae\u09b0\u09be \u09a8\u09a6\u09c0\u09b0 \u0997\u09a4\u09bf\u09aa\u09a5 \u09a8\u09bf\u09af\u09bc\u09c7 \u0995\u09a5\u09be \u09ac\u09b2\u09ac\u0964"
      : "Today we will talk about how rivers change their course.";
    var r = await chrome.runtime.sendMessage({ type: "ttsAndroid", text: sample, gender: gender });
    if (!r.ok) { m.textContent = "Failed: " + r.error; m.className = "msg error"; return; }
    if (testAudio) testAudio.pause();
    testAudio = new Audio("data:audio/wav;base64," + r.audio);
    testAudio.play();
    m.textContent = "Playing the " + gender + " voice.";
    m.className = "msg ok";
  }
  $("q-testMale").addEventListener("click", function () { testPhone("male"); });
  $("q-testFemale").addEventListener("click", function () { testPhone("female"); });
  $("q-installVoice").addEventListener("click", function () { window.LiveDubNative.openTtsSettings(); });

  // ---- sliders and choices
  function bindRange(id, key, fmt) {
    var el = $(id);
    el.value = settings[key];
    $(id + "Val").textContent = fmt(+el.value);
    el.addEventListener("input", function () {
      $(id + "Val").textContent = fmt(+el.value);
      var p = {}; p[key] = +el.value; save(p);
    });
  }
  bindRange("q-originalVolume", "originalVolume", function (v) { return Math.round(v * 100) + "%"; });
  bindRange("q-voiceSpeed", "voiceSpeed", function (v) { return v.toFixed(2) + "x"; });
  document.querySelectorAll("input[name=q-overrun]").forEach(function (r) {
    r.checked = r.value === settings.overrun;
    r.addEventListener("change", function () { save({ overrun: r.value }); });
  });
  $("q-showSubs").checked = settings.showSubs;
  $("q-showSubs").addEventListener("change", function () { save({ showSubs: $("q-showSubs").checked }); });

  $("back").addEventListener("click", function () {
    if (history.length > 1) history.back(); else window.LiveDubNative.openHome();
  });
})();

})();
