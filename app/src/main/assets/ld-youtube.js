/*
 * Live Dub - runs inside the YouTube page (MAIN world).
 * Captures the caption files the YouTube player downloads (these carry the
 * player's own access token, so they work when a direct download is refused)
 * and answers caption requests from the content script.
 */
(() => {
  "use strict";
  if (window.__liveDubHook) return;
  window.__liveDubHook = true;

  const FROM_PAGE = "LIVEDUB_PAGE";
  const FROM_EXT = "LIVEDUB_EXT";
  const captured = new Map();          // "videoId|lang|kind" -> body
  const origFetch = window.fetch;

  function keyOf(u) {
    try {
      const url = new URL(u, location.href);
      if (url.searchParams.get("tlang")) return null;  // skip YouTube's own translated tracks
      const v = url.searchParams.get("v");
      const lang = url.searchParams.get("lang");
      if (!v || !lang) return null;
      return `${v}|${lang}|${url.searchParams.get("kind") || ""}`;
    } catch (e) { return null; }
  }

  function store(u, body) {
    if (!body || body.length < 20) return;
    const k = keyOf(u);
    if (k) captured.set(k, body);
  }

  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const u = typeof input === "string" ? input : (input && input.url) || String(input);
      if (u && u.indexOf("/api/timedtext") >= 0) {
        p.then((res) => res.clone().text()).then((t) => store(u, t)).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__liveDubUrl = String(url || "");
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__liveDubUrl && this.__liveDubUrl.indexOf("/api/timedtext") >= 0) {
      this.addEventListener("load", () => {
        try {
          let t = null;
          if (this.responseType === "" || this.responseType === "text") t = this.responseText;
          else if (this.responseType === "arraybuffer" && this.response) t = new TextDecoder().decode(this.response);
          else if (typeof this.response === "string") t = this.response;
          store(this.__liveDubUrl, t);
        } catch (e) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ------------------------------------------------------------ requests

  function player() { return document.getElementById("movie_player"); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function trackName(t) {
    const n = t.name || {};
    return n.simpleText || (n.runs || []).map((r) => r.text).join("") || t.languageCode;
  }

  function getInfo() {
    const p = player();
    if (!p || !p.getPlayerResponse) return { videoId: null, tracks: [] };
    const pr = p.getPlayerResponse() || {};
    const vd = (p.getVideoData && p.getVideoData()) || {};
    const videoId = vd.video_id || (pr.videoDetails || {}).videoId || null;
    const list = (((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
    return {
      videoId,
      title: vd.title || (pr.videoDetails || {}).title || "",
      responseVideoId: (pr.videoDetails || {}).videoId || null,
      tracks: list.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || "",
        vssId: t.vssId || "",
        name: trackName(t),
        isTranslatable: !!t.isTranslatable,
      })),
    };
  }

  async function fetchTrack(track, videoId) {
    const key = `${videoId}|${track.languageCode}|${track.kind}`;
    if (captured.has(key)) return captured.get(key);

    // 1. Direct download
    try {
      const sep = track.baseUrl.indexOf("?") >= 0 ? "&" : "?";
      const r = await origFetch(track.baseUrl + sep + "fmt=json3", { credentials: "include" });
      const t = r.ok ? await r.text() : "";
      if (t && t.length > 50) { captured.set(key, t); return t; }
    } catch (e) { /* fall through */ }

    // 2. Ask the player to load this caption track and capture its download
    const p = player();
    if (!p || !p.setOption) throw new Error("YouTube player not found");
    let before = null;
    try { before = p.getOption("captions", "track"); } catch (e) { /* ignore */ }
    try { p.loadModule("captions"); } catch (e) { /* ignore */ }

    let list = [];
    for (let i = 0; i < 20 && !list.length; i++) {
      try { list = p.getOption("captions", "tracklist") || []; } catch (e) { list = []; }
      if (!list.length) await sleep(250);
    }
    const wantAsr = track.kind === "asr";
    const entry = list.find((x) => x.languageCode === track.languageCode && ((x.kind === "asr") === wantAsr))
      || list.find((x) => x.languageCode === track.languageCode);
    if (!entry) throw new Error("Caption track not available in the player");
    try { p.setOption("captions", "track", entry); } catch (e) { /* ignore */ }

    let body = null;
    for (let i = 0; i < 60 && !body; i++) {
      await sleep(200);
      body = captured.get(key) || captured.get(`${videoId}|${track.languageCode}|`) ||
             captured.get(`${videoId}|${track.languageCode}|asr`) || null;
    }

    // restore the viewer's caption state (hide captions if they were off)
    try {
      if (!before || !before.languageCode) p.setOption("captions", "track", {});
      else p.setOption("captions", "track", before);
    } catch (e) { /* ignore */ }

    if (!body) throw new Error("Could not download captions for this video");
    return body;
  }

  function setCaptionsVisible(show) {
    const p = player();
    if (!p || !p.setOption) return;
    try { if (!show) p.setOption("captions", "track", {}); } catch (e) { /* ignore */ }
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.source !== FROM_EXT) return;
    const reply = (data) => window.postMessage(Object.assign({ source: FROM_PAGE, id: m.id }, data), "*");
    try {
      if (m.type === "getInfo") reply({ ok: true, result: getInfo() });
      else if (m.type === "fetchTrack") reply({ ok: true, result: await fetchTrack(m.track, m.videoId) });
      else if (m.type === "hideCaptions") { setCaptionsVisible(false); reply({ ok: true }); }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });
})();

;(function () {
if (window.top !== window || window.__ldBundle) return;
window.__ldBundle = true;
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
window.__ldContentCss = ".livedub-btn { opacity: 0.9; }\n.livedub-btn svg { padding: 2px; box-sizing: border-box; }\n.livedub-btn.livedub-on { color: #2dd4bf; opacity: 1; }\n\n.livedub-overlay {\n  position: absolute;\n  left: 0; right: 0; bottom: 70px;\n  z-index: 60;\n  pointer-events: none;\n  text-align: center;\n}\n.ytp-autohide .livedub-overlay { bottom: 28px; }\n\n.livedub-sub {\n  display: none;\n  max-width: 82%;\n  padding: 4px 12px 6px;\n  border-radius: 6px;\n  background: rgba(8, 8, 8, 0.78);\n  color: #fff;\n  font-family: \"Nirmala UI\", \"Noto Sans Bengali\", \"Segoe UI\", Roboto, sans-serif;\n  line-height: 1.45;\n  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);\n}\n\n.livedub-status {\n  display: none;\n  position: absolute;\n  left: 50%; transform: translateX(-50%);\n  bottom: calc(100% + 8px);\n  max-width: 80%;\n  padding: 5px 12px;\n  border-radius: 14px;\n  font: 500 13px/1.4 \"Segoe UI\", Roboto, sans-serif;\n  color: #fff;\n  background: rgba(17, 94, 89, 0.92);\n}\n.livedub-status[data-kind=\"warn\"] { background: rgba(146, 64, 14, 0.94); }\n.livedub-status[data-kind=\"error\"] { background: rgba(153, 27, 27, 0.94); }\n.livedub-status[data-kind=\"ok\"] { background: rgba(21, 128, 61, 0.92); }\n";
/* Live Dub - content script on YouTube watch pages. */
(() => {
  "use strict";
  if (window.__liveDubContent) return;
  window.__liveDubContent = true;

  const LD = window.LiveDub;
  const FROM_PAGE = "LIVEDUB_PAGE";
  const FROM_EXT = "LIVEDUB_EXT";
  const CACHE_MAX = 80;

  const S = {
    settings: Object.assign({}, LD.DEFAULTS),
    enabled: false,
    run: 0,
    videoId: null,
    title: "",
    segs: [],
    status: "",
    statusKind: "",
    trackLabel: "",
    speaker: null,            // last detected speaker gender
    geminiOff: false,         // Gemini voice failed for this video; stay on Google voice
    switchVotes: 0,           // consecutive sentences that disagree with the current speaker
  };

  // ------------------------------------------------------------ page bridge

  let reqId = 0;
  const waiting = new Map();
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== FROM_PAGE) return;
    const w = waiting.get(ev.data.id);
    if (!w) return;
    waiting.delete(ev.data.id);
    ev.data.ok ? w.resolve(ev.data.result) : w.reject(new Error(ev.data.error));
  });

  function page(type, data, timeout = 25000) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      waiting.set(id, { resolve, reject });
      window.postMessage(Object.assign({ source: FROM_EXT, id, type }, data || {}), "*");
      setTimeout(() => {
        if (waiting.has(id)) { waiting.delete(id); reject(new Error("YouTube page did not respond")); }
      }, timeout);
    });
  }

  async function bg(msg) {
    const r = await chrome.runtime.sendMessage(msg);
    if (!r || !r.ok) throw new Error((r && r.error) || "Extension error");
    return r;
  }

  // ------------------------------------------------------------ helpers

  const playerEl = () => document.getElementById("movie_player");
  const video = () => document.querySelector("#movie_player video.html5-main-video") ||
                      document.querySelector("#movie_player video");
  const isAd = () => { const p = playerEl(); return !!(p && p.classList.contains("ad-showing")); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function currentVideoId() {
    if (location.pathname !== "/watch") return null;
    return new URLSearchParams(location.search).get("v");
  }

  function provider() {
    const id = S.settings.providerId;
    const p = (S.settings.providers || []).find((x) => x.id === id);
    return p || { id: "google", type: "google", name: "Google Translate" };
  }

  // ------------------------------------------------------------ voices

  class AudioVoice {
    constructor() {
      this.a = new Audio();
      this.a.preservesPitch = true;
      this.resolve = null;
      this.a.addEventListener("ended", () => this.done());
      this.a.addEventListener("error", () => this.done());
    }
    done() { const r = this.resolve; this.resolve = null; if (r) r(); }
    play(seg, rate) {
      this.done();
      this.a.src = seg.audioUrl;
      this.a.playbackRate = rate;
      this.a.volume = clamp01(S.settings.voiceVolume);
      return new Promise((res) => {
        this.resolve = res;
        this.a.play().catch(() => this.done());
      });
    }
    stop() { try { this.a.pause(); } catch (e) { /* ignore */ } this.done(); }
    pause() { if (this.resolve) this.a.pause(); }
    resume() { if (this.resolve && this.a.paused) this.a.play().catch(() => {}); }
    isPlaying() { return !!this.resolve; }
    remaining() {
      const d = this.a.duration;
      return isFinite(d) ? Math.max(0, (d - this.a.currentTime) / (this.a.playbackRate || 1)) : 0;
    }
    setRate(r, factor) {
      this.a.playbackRate = Math.min(4, Math.max(0.5, r != null ? r : this.a.playbackRate * factor));
    }
    setVolume(v) { this.a.volume = clamp01(v); }
  }

  const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;

  class SpeechVoice {
    constructor() { this.resolve = null; this.started = 0; this.est = 0; }
    done() { const r = this.resolve; this.resolve = null; if (r) r(); }
    pickVoice(gender) {
      const all = synth ? synth.getVoices() : [];
      const st = S.settings;
      const mine = all.filter((v) => v.lang.toLowerCase().startsWith(st.targetLang));
      const named = gender === "female" ? st.systemVoiceFemale : gender === "male" ? st.systemVoiceMale : "";
      return all.find((v) => named && v.name === named) ||
             (gender ? mine.find((v) => LD.systemVoiceGender(v.name) === gender) : null) ||
             all.find((v) => v.name === st.systemVoice) || mine[0] || null;
    }
    play(seg, rate) {
      this.done();
      if (!synth) return Promise.resolve();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(seg.tr);
      const v = this.pickVoice(seg.gender);
      if (v) u.voice = v;
      u.lang = v ? v.lang : S.settings.targetLang;
      u.rate = Math.min(3, rate);
      u.volume = clamp01(S.settings.voiceVolume);
      this.started = Date.now();
      this.est = (seg.audioDur || 2) / (rate || 1);
      return new Promise((res) => {
        this.resolve = res;
        u.onend = () => this.done();
        u.onerror = () => this.done();
        synth.speak(u);
      });
    }
    stop() { if (synth) synth.cancel(); this.done(); }
    pause() { if (this.resolve && synth) synth.pause(); }
    resume() { if (this.resolve && synth) synth.resume(); }
    isPlaying() { return !!this.resolve; }
    remaining() { return Math.max(0, this.est - (Date.now() - this.started) / 1000); }
    setRate() { /* cannot change a running utterance */ }
    setVolume() { /* applies to the next segment */ }
  }

  const voices = { google: new AudioVoice(), system: new SpeechVoice() };
  const voiceProxy = {
    cur() { return S.settings.ttsEngine === "system" ? voices.system : voices.google; },  // google + gemini = audio files
    play(seg, rate) { return this.cur().play(seg, rate); },
    stop() { voices.google.stop(); voices.system.stop(); },
    pause() { this.cur().pause(); },
    resume() { this.cur().resume(); },
    isPlaying() { return this.cur().isPlaying(); },
    remaining() { return this.cur().remaining(); },
    setRate(r, f) { this.cur().setRate(r, f); },
  };

  function clamp01(x) { return Math.min(1, Math.max(0, Number(x) || 0)); }

  // ------------------------------------------------------------ audio preparation

  const prep = { queue: [], active: 0 };

  /** Can the current voice engine speak in both a male and a female voice? */
  function engineHasGenders() {
    const e = S.settings.ttsEngine;
    if (e === "gemini" || e === "google" || e === "android") return true;   // google: male = deepened Google voice
    if (e === "system" && synth) {
      const mine = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(S.settings.targetLang));
      const has = (g) => (g === "male" ? S.settings.systemVoiceMale : S.settings.systemVoiceFemale) ||
                         mine.some((v) => LD.systemVoiceGender(v.name) === g);
      return !!(has("male") && has("female"));
    }
    return false;
  }

  /** Gender to use for a segment that has not been decided yet. */
  function predictedGender() {
    const g = S.settings.voiceGender;
    if (g === "male" || g === "female") return g;
    return S.speaker || "male";
  }

  /** Voice engine actually in use: once Gemini voice fails, Google voice is used for the rest of the video. */
  function effectiveEngine() {
    const e = S.settings.ttsEngine;
    return e === "gemini" && S.geminiOff ? "google" : e;
  }

  function variantKey(gender) {
    const e = effectiveEngine();
    if (e === "google" && S.noDeepen) return "google:female";   // deepening unavailable: one voice for all
    return `${e}:${gender}`;
  }

  function isReady(i) {
    const s = S.segs[i];
    if (!s || s.tr == null) return false;
    if (s.skip) return true;
    if (S.settings.ttsEngine === "system") return true;
    const v = s.v && s.v[variantKey(s.gender || predictedGender())];
    if (!v || !v.url) return false;
    s.audioUrl = v.url;
    s.audioDur = v.dur;
    return true;
  }

  function prepare(i, urgent) {
    const s = S.segs[i];
    if (!s || s.tr == null || s.skip || S.settings.ttsEngine === "system") return;
    const gender = s.gender || predictedGender();
    const key = variantKey(gender);
    s.v = s.v || {};
    const v = s.v[key];
    if (v && (v.url || v.loading || (v.retryAt && Date.now() < v.retryAt))) return;
    const job = { i, key, gender };
    prep.queue = prep.queue.filter((j) => !(j.i === i && j.key === key));
    if (urgent) prep.queue.unshift(job); else prep.queue.push(job);
    pump(S.run);
  }

  function pump(run) {
    const limit = 2;
    while (prep.active < limit && prep.queue.length) {
      const job = prep.queue.shift();
      const s = S.segs[job.i];
      if (!s || s.skip || s.tr == null) continue;
      s.v = s.v || {};
      const v = s.v[job.key] = s.v[job.key] || {};
      if (v.url || v.loading || (v.retryAt && Date.now() < v.retryAt)) continue;
      prep.active++;
      v.loading = true;
      loadAudio(s, v, job.gender, run).finally(() => {
        v.loading = false;
        prep.active--;
        if (run === S.run) pump(run);
      });
    }
  }

  async function loadAudio(s, v, gender, run) {
    const st = S.settings;
    if (!LD.isInTargetScript(s.tr, st.targetLang)) { s.skip = true; return; }   // never voice a wrong-language line
    try {
      let r = null;
      if (effectiveEngine() === "gemini") {
        try {
          r = await bg({ type: "ttsGemini", text: s.tr, gender });
        } catch (e) {
          const limited = /429|quota|rate|exhaust/i.test(e.message);
          if (run === S.run && !S.geminiOff) {
            S.geminiOff = true;
            setStatus((limited ? "Gemini voice limit reached" : "Gemini voice error: " + e.message.slice(0, 120)) +
                      ". Using Google voice for the rest of this video.", "warn", 8000);
          }
        }
      }
      if (effectiveEngine() === "android") {
        // Phone's own text-to-speech (Android app only). Failures are retried, never mixed with another voice.
        r = await bg({ type: "ttsAndroid", text: s.tr, gender });
      }
      let bytes, mime;
      if (r) {
        bytes = b64ToBytes(r.audio);
        mime = r.mime;
      } else {
        // Google voice (female). Downloaded once per sentence, deepened for male speakers.
        if (!s.googleRaw) {
          s.googleRaw = bg({ type: "tts", text: s.tr, lang: st.targetLang }).then((x) => b64ToBytes(x.audio));
          s.googleRaw.catch(() => { s.googleRaw = null; });
        }
        bytes = await s.googleRaw;
        mime = "audio/mpeg";
        if (gender === "male") {
          const deep = await deepen(bytes, st.maleDepth);
          if (deep && !S.noDeepen) { bytes = deep; mime = "audio/wav"; }
          else if (!S.noDeepen && run === S.run) {
            S.noDeepen = true;                  // keep one voice: use the original Google voice from now on
            setStatus("Male voice not available here; using the Google voice for this video.", "warn", 6000);
          }
        }
      }
      if (run !== S.run) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const dur = await audioDuration(url, s.tr.length / 13);
      if (run !== S.run) { URL.revokeObjectURL(url); return; }
      v.url = url;
      v.dur = dur;
      S.voiceFailures = 0;
    } catch (e) {
      v.errors = (v.errors || 0) + 1;
      v.retryAt = Date.now() + 1500 * v.errors;
      if (v.errors >= 4) s.skip = true;
      S.voiceFailures = (S.voiceFailures || 0) + 1;
      // a single failed sentence is retried quietly; only report repeated trouble
      if (run === S.run && S.voiceFailures >= 3) setStatus("Voice service not responding (" + e.message + "). Retrying...", "warn", 5000);
    }
  }

  function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

  /** Lower pitch and timbre of an audio clip (female Google voice -> male). Returns WAV bytes or null. */
  async function deepen(bytes, factor) {
    try {
      if (typeof OfflineAudioContext === "undefined") return null;
      const ctx = new OfflineAudioContext(1, 1, 24000);
      const buf = await ctx.decodeAudioData(bytes.slice().buffer);
      const x = buf.getChannelData(0);
      const y = LD.shiftPitch(x, buf.sampleRate, Number(factor) || 0.72);
      return LD.encodeWav(y, buf.sampleRate);
    } catch (e) {
      return null;
    }
  }

  function audioDuration(url, fallback) {
    return new Promise((res) => {
      const a = new Audio();
      const t = setTimeout(() => res(fallback), 3000);
      a.addEventListener("loadedmetadata", () => {
        clearTimeout(t);
        res(isFinite(a.duration) && a.duration > 0 ? a.duration : fallback);
      });
      a.addEventListener("error", () => { clearTimeout(t); res(fallback); });
      a.preload = "metadata";
      a.src = url;
    });
  }

  function clearAudio() {
    for (const s of S.segs) { for (const k in s.v || {}) if (s.v[k].url) URL.revokeObjectURL(s.v[k].url); s.googleRaw = null; }
    prep.queue = [];
  }

  // ------------------------------------------------------------ speaker pitch (gender detection)

  const PT = { ctx: null, el: null, src: null, gain: null, an: null, buf: null, samples: [], timer: null };

  function graphActive() {
    return !!(PT.src && PT.el === video() && PT.ctx && PT.ctx.state === "running");
  }

  /**
   * Route the video's sound through Web Audio so its pitch can be measured.
   * Only done while the audio engine is running (otherwise the video would go silent).
   */
  async function ensureAudioGraph() {
    const v = video();
    if (!v) return false;
    if (PT.el === v && PT.src) return PT.ctx.state === "running";
    try {
      if (!PT.ctx) PT.ctx = new AudioContext();
      if (PT.ctx.state !== "running") await Promise.race([PT.ctx.resume(), sleep(400)]);
      if (PT.ctx.state !== "running") return false;
      const src = PT.ctx.createMediaElementSource(v);
      PT.src = src;
      PT.el = v;
      PT.gain = PT.ctx.createGain();
      src.connect(PT.gain).connect(PT.ctx.destination);
      const hp = PT.ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 70;
      const lp = PT.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1000;
      PT.an = PT.ctx.createAnalyser();
      PT.an.fftSize = 2048;
      PT.buf = new Float32Array(PT.an.fftSize);
      src.connect(hp).connect(lp).connect(PT.an);
      clearInterval(PT.timer);
      PT.timer = setInterval(samplePitch, 45);
      return true;
    } catch (e) {
      return false;
    }
  }

  function samplePitch() {
    const v = video();
    if (!S.enabled || !v || v.paused || isAd() || !graphActive()) return;
    if (S.settings.voiceGender !== "auto" || !engineHasGenders()) return;
    PT.an.getFloatTimeDomainData(PT.buf);
    const r = LD.detectPitch(PT.buf, PT.ctx.sampleRate, { minRms: 0.002 });
    const t = v.currentTime;
    if (r.f0 > 0) PT.samples.push({ t, f0: r.f0 });
    if (PT.samples.length > 400) PT.samples.splice(0, PT.samples.length - 400);
  }

  /** Decide the voice gender for segment i (called just before it is voiced). */
  function beforeStart(i) {
    const s = S.segs[i];
    if (!s) return;
    const g = S.settings.voiceGender;
    if (g === "male" || g === "female") { s.gender = g; return; }
    if (!engineHasGenders()) { s.gender = s.gender || predictedGender(); return; }
    const now = videoAdapter.currentTime;
    const inSeg = PT.samples.filter((x) => x.t >= s.start - 0.05 && x.t <= now + 0.05).map((x) => x.f0);
    let found = LD.genderFromPitches(inSeg, S.speaker);
    if (!found) {
      const recent = PT.samples.filter((x) => x.t >= now - 4 && x.t <= now + 0.05).map((x) => x.f0);
      found = LD.genderFromPitches(recent, S.speaker, 6);
    }
    if (found && S.speaker && found !== S.speaker) {
      S.switchVotes++;
      if (S.switchVotes >= 2) { S.speaker = found; S.switchVotes = 0; }
    } else {
      if (found) S.speaker = found;
      S.switchVotes = 0;
    }
    s.gender = S.speaker || predictedGender();
  }

  function listenDelay() {
    return S.settings.voiceGender === "auto" && engineHasGenders() && graphActive()
      ? Math.max(0, Math.min(1, Number(S.settings.listenDelay) || 0)) : 0;
  }

  // ------------------------------------------------------------ timing engine

  const videoAdapter = {
    get currentTime() { const v = video(); return v ? v.currentTime : 0; },
    get paused() { const v = video(); return !v || v.paused; },
    get playbackRate() { const v = video(); return v ? v.playbackRate : 1; },
    play() { const v = video(); if (v) v.play().catch(() => {}); },
    pause() { const v = video(); if (v) v.pause(); },
    isAd,
  };

  const sync = new LD.DubSync({
    video: videoAdapter,
    voice: voiceProxy,
    segments: () => S.segs,
    isReady,
    prepare,
    settings: () => S.settings,
    startDelay: listenDelay,
    beforeStart,
  });

  let boundVideo = null;
  function bindVideo() {
    const v = video();
    if (!v || v === boundVideo) return;
    boundVideo = v;
    v.addEventListener("seeking", () => { if (S.enabled) sync.onSeek(); });
    v.addEventListener("pause", () => { if (S.enabled) sync.onPause(); });
    v.addEventListener("play", () => { if (S.enabled) sync.onPlay(); });
    v.addEventListener("ratechange", () => { if (S.enabled) sync.onRateChange(); });
    v.addEventListener("volumechange", onVolumeChange);
  }

  setInterval(() => {
    bindVideo();
    ensureButton();
    if (!S.enabled || !S.segs.length) { showSub(""); return; }
    const i = sync.tick();
    const v = video();
    if (S.settings.showSubs && i >= 0 && v && v.currentTime <= S.segs[i].end + 0.4 && !isAd()) {
      showSub(S.segs[i].tr || "");
    } else showSub("");
  }, 100);

  // ------------------------------------------------------------ original volume

  const duck = { on: false, base: 1, expect: -1 };

  function applyDuck() {
    const v = video();
    if (!v) return;
    if (graphActive()) {                       // lower the original sound inside Web Audio
      if (duck.on) { duck.expect = -1; v.volume = duck.base; duck.on = false; }
      PT.gain.gain.value = clamp01(S.settings.originalVolume);
      return;
    }
    if (!duck.on) { duck.on = true; duck.base = v.volume; }
    duck.expect = clamp01(duck.base * S.settings.originalVolume);
    v.volume = duck.expect;
  }

  function removeDuck() {
    if (PT.gain) PT.gain.gain.value = 1;
    const v = video();
    if (duck.on && v) { duck.expect = -1; v.volume = duck.base; }
    duck.on = false;
  }

  function onVolumeChange() {
    const v = video();
    if (!duck.on || !v) return;
    if (Math.abs(v.volume - duck.expect) < 0.002) return;   // our own change
    duck.base = v.volume;                                   // user or YouTube changed it
    applyDuck();
  }

  // ------------------------------------------------------------ captions & translation

  function chooseTrack(tracks, target) {
    const base = (c) => String(c || "").toLowerCase().split("-")[0];
    const manual = tracks.filter((t) => t.kind !== "asr");
    const asr = tracks.find((t) => t.kind === "asr");
    const tgt = manual.find((t) => base(t.languageCode) === target);
    if (tgt) return { track: tgt, direct: true };
    if (asr) {
      const same = manual.find((t) => base(t.languageCode) === base(asr.languageCode));
      if (same) return { track: same };
    }
    const en = manual.find((t) => base(t.languageCode) === "en");
    if (en) return { track: en };
    if (asr) return { track: asr, direct: base(asr.languageCode) === target };
    if (manual.length) return { track: manual[0] };
    return null;
  }

  function cacheKey(track) {
    const p = provider();
    const pk = p.type === "google" ? "google" : `${p.id}:${p.model}`;
    return `tr:${S.videoId}:${track.languageCode}:${track.kind}:${S.settings.targetLang}:${pk}`;
  }

  async function readCache(key) {
    const r = await chrome.storage.local.get(key);
    return r[key] || null;
  }

  async function writeCache(key) {
    const data = { ts: Date.now(), tr: S.segs.map((s) => s.tr) , n: S.segs.length };
    const idx = (await chrome.storage.local.get("trIndex")).trIndex || [];
    const next = idx.filter((k) => k !== key);
    next.push(key);
    const drop = next.splice(0, Math.max(0, next.length - CACHE_MAX));
    if (drop.length) await chrome.storage.local.remove(drop);
    await chrome.storage.local.set({ [key]: data, trIndex: next });
  }

  async function removeCache(key) {
    const idx = (await chrome.storage.local.get("trIndex")).trIndex || [];
    await chrome.storage.local.remove(key);
    await chrome.storage.local.set({ trIndex: idx.filter((k) => k !== key) });
  }

  async function translateAll(run, key, onFirst) {
    const p = provider();
    const ai = p.type !== "google";
    const segs = S.segs;
    const batches = LD.makeBatches(segs, ai ? 2500 : 1800, ai ? 40 : 50);
    const order = LD.orderBatches(batches, segs, videoAdapter.currentTime);
    // A busy AI server only affects the batch that failed; the next batch tries the AI again.
    // The AI is given up for this video only after 3 failures in a row.
    let done = 0, aiFailed = false, aiMisses = 0, usedGoogle = false, firstSent = false, lostBatches = 0;

    for (const [a, b] of order) {
      if (run !== S.run) return;
      const lines = segs.slice(a, b).map((s) => s.text);
      const context = segs.slice(Math.max(0, a - 3), a).map((s) => s.text);
      let res = null;
      if (ai && !aiFailed) {
        try {
          res = (await bg({ type: "translate", lines, provider: p, lang: S.settings.targetLang, src: S.srcLang,
                            title: S.title, context, extraPrompt: S.settings.extraPrompt })).lines;
          aiMisses = 0;
        } catch (e) {
          aiMisses++;
          if (aiMisses >= 3) {
            aiFailed = true;
            setStatus(`${p.name} is not responding (${e.message}). Using Google Translate for the rest of this video.`, "warn", 9000);
          } else {
            setStatus(`${p.name} busy (${e.message}); this part uses Google Translate, retrying ${p.name} next.`, "warn", 6000);
          }
        }
      }
      if (!res) {
        if (ai) usedGoogle = true;      // an AI video that needed Google for some parts
        try {
          res = (await bg({ type: "translate", lines, provider: { type: "google" }, lang: S.settings.targetLang, src: S.srcLang })).lines;
        } catch (e) {
          if (run !== S.run) return;
          setStatus("Translation error: " + e.message, "error");
          lostBatches++;
          res = lines.map(() => "");
        }
      }
      if (run !== S.run) return;
      res = await checkTranslations(lines, res, run);
      if (run !== S.run) return;
      for (let k = a; k < b; k++) {
        const t = (res[k - a] || "").trim();
        segs[k].tr = t;
        if (!t) segs[k].skip = true;
        if (S.settings.ttsEngine === "system") segs[k].audioDur = t.length / 13;
      }
      done++;
      if (!firstSent) { firstSent = true; onFirst(); }
      if (done < order.length) setStatus(`Translating ${Math.round((done / order.length) * 100)}%`, "info");
    }
    if (run !== S.run) return;
    if (!usedGoogle && !lostBatches) await writeCache(key).catch(() => {});   // only fully AI-translated videos are saved
    const who = aiFailed ? "Google Translate" : usedGoogle ? p.name + " (some parts Google)" : p.name;
    if (lostBatches) setStatus(`Dubbing with ${who}, but ${lostBatches} of ${order.length} parts could not be translated (check the internet connection).`, "warn", 9000);
    else setStatus(`Dubbing with ${who}`, "ok", 3000);
  }

  /**
   * Lines that came back untranslated (wrong script) are translated again with
   * Google Translate from the caption language; if still wrong they stay silent.
   */
  async function checkTranslations(lines, res, run) {
    const lang = S.settings.targetLang;
    const out = lines.map((_, i) => String(res[i] || "").trim());
    const bad = out.map((t, i) => (t && !LD.isInTargetScript(t, lang) ? i : -1)).filter((i) => i >= 0);
    if (!bad.length) return out;
    try {
      const again = (await bg({ type: "translate", lines: bad.map((i) => lines[i]),
                                provider: { type: "google" }, lang, src: S.srcLang })).lines;
      bad.forEach((i, k) => { out[i] = String(again[k] || "").trim(); });
    } catch (e) { /* handled below */ }
    let dropped = 0;
    for (const i of bad) if (!LD.isInTargetScript(out[i], lang)) { out[i] = ""; dropped++; }
    if (dropped && run === S.run) setStatus(`${dropped} line(s) could not be translated and are skipped.`, "warn", 5000);
    return out;
  }

  // ------------------------------------------------------------ start / stop

  async function loadVideo() {
    const run = ++S.run;
    sync.reset();
    clearAudio();
    S.segs = [];
    S.speaker = null;
    S.switchVotes = 0;
    S.geminiOff = false;
    S.noDeepen = false;
    PT.samples = [];
    S.videoId = currentVideoId();
    if (!S.videoId) { setStatus("Open a YouTube video to start dubbing.", "info", 4000); return; }

    setStatus("Loading captions...", "info");
    try {
      let info = null;
      for (let i = 0; i < 30; i++) {
        info = await page("getInfo");
        if (info.videoId === S.videoId && info.responseVideoId === S.videoId) break;
        await sleep(300);
      }
      if (run !== S.run) return;
      S.title = info.title || "";
      if (!info.tracks.length) { setStatus("This video has no captions, so it cannot be dubbed.", "error"); return; }

      const choice = chooseTrack(info.tracks, S.settings.targetLang);
      if (!choice) { setStatus("No usable captions found.", "error"); return; }
      S.srcLang = choice.track.languageCode;
      S.trackLabel = choice.track.name +
        (choice.track.kind === "asr" && !/auto/i.test(choice.track.name) ? " (auto)" : "");

      const body = await page("fetchTrack", { track: choice.track, videoId: S.videoId });
      if (run !== S.run) return;
      const cues = LD.parseCaptions(body);
      if (!cues.length) { setStatus("Captions were empty for this video.", "error"); return; }
      S.segs = LD.groupCues(cues).map((g) => Object.assign(g, { tr: null }));
      if (S.settings.hideOriginal) page("hideCaptions").catch(() => {});
      applyDuck();

      const key = cacheKey(choice.track);
      if (choice.direct) {
        S.segs.forEach((s) => { s.tr = s.text; if (S.settings.ttsEngine === "system") s.audioDur = s.text.length / 13; });
        setStatus("Video already has captions in this language; reading them aloud.", "ok", 4000);
        return;
      }
      const cached = await readCache(key);
      if (run !== S.run) return;
      if (cached && cached.n === S.segs.length) {
        S.segs.forEach((s, i) => {
          s.tr = cached.tr[i] || "";
          if (s.tr && !LD.isInTargetScript(s.tr, S.settings.targetLang)) s.tr = "";
          if (!s.tr) s.skip = true;
          if (S.settings.ttsEngine === "system") s.audioDur = s.tr.length / 13;
        });
        setStatus(`Dubbing (saved translation, ${provider().name})`, "ok", 3000);
        return;
      }

      // Pause while the first part is prepared, then continue automatically.
      const v = video();
      const wasPlaying = v && !v.paused;
      if (wasPlaying) v.pause();
      setStatus(`Translating with ${provider().name}...`, "info");
      let firstDone;
      const first = new Promise((r) => { firstDone = r; });
      const all = translateAll(run, key, () => firstDone());
      await Promise.race([first, all]);
      if (run !== S.run) return;
      if (wasPlaying) {
        const i = Math.max(0, LD.findSegmentIndex(S.segs, videoAdapter.currentTime));
        prepare(i, true);
        prepare(i + 1, false);
        for (let k = 0; k < 40 && !isReady(i); k++) await sleep(200);
        if (run === S.run && v.paused) v.play().catch(() => {});
      }
      await all;
    } catch (e) {
      if (run === S.run) setStatus("Error: " + e.message, "error");
    }
  }

  function startDub() {
    if (S.enabled) return;
    S.enabled = true;
    ensureAudioGraph().then((ok) => { if (ok && S.enabled) applyDuck(); });
    try { sessionStorage.setItem("livedub-on", "1"); } catch (e) { /* ignore */ }
    updateButton();
    loadVideo();
  }

  function stopDub() {
    S.enabled = false;
    S.run++;
    try { sessionStorage.removeItem("livedub-on"); } catch (e) { /* ignore */ }
    sync.reset();
    voiceProxy.stop();
    removeDuck();
    clearAudio();
    S.segs = [];
    showSub("");
    setStatus("Dubbing off", "info", 1500);
    updateButton();
  }

  async function retranslate() {
    if (!S.enabled) return startDub();
    const info = await page("getInfo").catch(() => null);
    if (info && info.tracks) {
      const c = chooseTrack(info.tracks, S.settings.targetLang);
      if (c) await removeCache(cacheKey(c.track)).catch(() => {});
    }
    loadVideo();
  }

  // follow navigation between videos
  let lastSeen = currentVideoId();
  function onNavigate() {
    const id = currentVideoId();
    if (id === lastSeen) return;
    lastSeen = id;
    if (!id) { if (S.enabled) { S.run++; sync.reset(); clearAudio(); S.segs = []; } return; }
    if (S.enabled) {
      if (S.settings.keepOnNext) { removeDuck(); loadVideo(); } else stopDub();
    } else if (S.settings.autoStart) startDub();
  }
  document.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("pointerdown", () => {
    if (S.enabled && !graphActive()) ensureAudioGraph().then((ok) => { if (ok && S.enabled) applyDuck(); });
  }, true);
  setInterval(onNavigate, 1000);

  // ------------------------------------------------------------ UI

  let overlay = null, subEl = null, statusEl = null, statusTimer = null;

  function ensureOverlay() {
    const p = playerEl();
    if (!p) return false;
    if (overlay && overlay.parentNode === p) return true;
    overlay = document.createElement("div");
    overlay.className = "livedub-overlay";
    subEl = document.createElement("div");
    subEl.className = "livedub-sub";
    statusEl = document.createElement("div");
    statusEl.className = "livedub-status";
    overlay.append(statusEl, subEl);
    p.appendChild(overlay);
    return true;
  }

  function showSub(text) {
    if (!ensureOverlay()) return;
    subEl.style.fontSize = (S.settings.subSize || 22) + "px";
    if (subEl.textContent !== text) subEl.textContent = text;
    subEl.style.display = text ? "inline-block" : "none";
  }

  function setStatus(text, kind, hideAfter) {
    S.status = text;
    S.statusKind = kind || "info";
    if (ensureOverlay()) {
      statusEl.textContent = text;
      statusEl.dataset.kind = S.statusKind;
      statusEl.style.display = text ? "block" : "none";
      clearTimeout(statusTimer);
      if (hideAfter) statusTimer = setTimeout(() => { statusEl.style.display = "none"; }, hideAfter);
    }
    updateButton();
  }

  const ICON =
    '<svg viewBox="0 0 36 36" width="100%" height="100%" aria-hidden="true">' +
    '<path d="M9 11h13a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-7l-4 3v-3h-2a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M28 13.5c1.3 1.2 2 2.8 2 4.5s-.7 3.3-2 4.5M13 17h7M13 20h4" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round"/></svg>';

  let btn = null;
  function ensureButton() {
    const bar = document.querySelector("#movie_player .ytp-right-controls");
    if (!bar) return;
    if (btn && btn.parentNode === bar) return;
    btn = document.createElement("button");
    btn.className = "ytp-button livedub-btn";
    btn.innerHTML = ICON;
    btn.addEventListener("click", (e) => { e.stopPropagation(); S.enabled ? stopDub() : startDub(); });
    bar.insertBefore(btn, bar.firstChild);
    updateButton();
  }

  function updateButton() {
    if (!btn) return;
    btn.classList.toggle("livedub-on", S.enabled);
    const label = S.enabled ? "Live Dub: on (click to turn off)" : "Live Dub: translate voice";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  // ------------------------------------------------------------ settings & messages

  LD.loadSettings().then((s) => {
    S.settings = s;
    let wasOn = false;
    try { wasOn = sessionStorage.getItem("livedub-on") === "1"; } catch (e) { /* ignore */ }
    if ((wasOn && s.keepOnNext) || s.autoStart) { if (currentVideoId()) startDub(); }
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch.settings) return;
    const old = S.settings;
    S.settings = Object.assign({}, LD.DEFAULTS, ch.settings.newValue || {});
    if (!S.enabled) return;
    if (old.originalVolume !== S.settings.originalVolume) applyDuck();
    if (old.voiceVolume !== S.settings.voiceVolume) voices.google.setVolume(S.settings.voiceVolume);
    if (old.voiceGender !== S.settings.voiceGender) S.segs.forEach((x) => { x.gender = null; });
    if (old.ttsEngine !== S.settings.ttsEngine) {
      sync.onSeek();
      if (S.settings.ttsEngine === "system") S.segs.forEach((x) => { x.audioDur = (x.tr || "").length / 13; });
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "getStatus") {
      const total = S.segs.length;
      const translated = S.segs.filter((s) => s.tr != null).length;
      sendResponse({
        enabled: S.enabled, videoId: currentVideoId(), status: S.status, kind: S.statusKind,
        track: S.trackLabel, total, translated, provider: provider().name,
        speaker: S.settings.voiceGender === "auto" ? (engineHasGenders() ? (S.speaker || "listening") : "n/a") : S.settings.voiceGender,
        genderCapable: engineHasGenders(), detecting: graphActive(),
      });
    } else if (msg.type === "toggle") { S.enabled ? stopDub() : startDub(); sendResponse({ ok: true }); }
    else if (msg.type === "start") { startDub(); sendResponse({ ok: true }); }
    else if (msg.type === "stop") { stopDub(); sendResponse({ ok: true }); }
    else if (msg.type === "retranslate") { retranslate(); sendResponse({ ok: true }); }
    return false;
  });
})();

/* Live Dub app - adjustments to the YouTube page inside the app: compact top bar, phone-friendly layout. */
(function () {
  if (window.__ldAppUi) return;
  window.__ldAppUi = true;

  var css =
    "#masthead-container, ytd-masthead, #guide, ytd-mini-guide-renderer, tp-yt-app-drawer { display: none !important; }" +
    "ytd-app { --ytd-masthead-height: 0px !important; }" +
    "#page-manager { margin-top: 44px !important; }" +
    "ytd-watch-flexy #secondary, #related, ytd-merch-shelf-renderer { display: none !important; }" +
    ".ld-appbar { position: fixed; top: 0; left: 0; right: 0; height: 44px; z-index: 99999; display: flex;" +
    "  align-items: center; gap: 8px; padding: 0 10px; background: #0f766e; color: #fff;" +
    "  font: 600 15px/1 Roboto, 'Segoe UI', sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,.25); }" +
    ".ld-appbar .ld-title { flex: 1; }" +
    ".ld-appbar button { background: rgba(255,255,255,.16); color: #fff; border: 0; border-radius: 16px;" +
    "  padding: 7px 12px; font: 600 13px/1 Roboto, sans-serif; }" +
    ".livedub-sub { font-size: 17px !important; }";

  function addUi() {
    if (!document.head || !document.body) return false;
    if (!document.getElementById("ld-app-style")) {
      var st = document.createElement("style");
      st.id = "ld-app-style";
      st.textContent = css + (window.__ldContentCss || "");
      document.head.appendChild(st);
    }
    if (!document.querySelector(".ld-appbar")) {
      var bar = document.createElement("div");
      bar.className = "ld-appbar";
      var title = document.createElement("span");
      title.className = "ld-title";
      title.textContent = "Live Dub";
      var link = document.createElement("button");
      link.textContent = "New link";
      link.addEventListener("click", function () { window.LiveDubNative.openHome(); });
      var set = document.createElement("button");
      set.textContent = "Settings";
      set.addEventListener("click", function () { window.LiveDubNative.openSettings(); });
      bar.append(title, link, set);
      document.body.appendChild(bar);
    }
    return true;
  }

  // Remember played videos for the Home screen's "Recent" list
  var lastSaved = "";
  setInterval(function () {
    var id = new URLSearchParams(location.search).get("v");
    var title = (document.title || "").replace(/\s*-\s*YouTube\s*$/, "").replace(/^\(\d+\)\s*/, "").trim();
    if (!id || !title || title === "YouTube" || lastSaved === id + title) return;
    lastSaved = id + title;
    var list = [];
    try { list = JSON.parse(window.LiveDubNative.storageGet("recentVideos") || "[]") || []; } catch (e) { list = []; }
    list = [{ id: id, title: title }].concat(list.filter(function (r) { return r.id !== id; })).slice(0, 12);
    window.LiveDubNative.storageSet("recentVideos", JSON.stringify(list));
  }, 3000);

  if (!addUi()) {
    var t = setInterval(function () { if (addUi()) clearInterval(t); }, 200);
  }
})();

})();
