package com.livedub.player;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Functions the Live Dub web pages call through window.LiveDubNative:
 * settings storage, network requests without browser limits, the phone's
 * text-to-speech, the clipboard and screen navigation.
 */
public class NativeBridge {
    private final MainActivity activity;
    private final WebView web;
    private final SharedPreferences prefs;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, String> pendingSpeech = new ConcurrentHashMap<>();
    private final TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private String currentVoice = "";   // voice the engine was last switched to

    NativeBridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.prefs = activity.getSharedPreferences("livedub", Context.MODE_PRIVATE);
        this.tts = new TextToSpeech(activity.getApplicationContext(), status -> ttsReady = status == TextToSpeech.SUCCESS);
        this.tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
            }

            @Override
            public void onDone(String utteranceId) {
                finishSpeech(utteranceId, null);
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String utteranceId) {
                finishSpeech(utteranceId, "speech engine error");
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                finishSpeech(utteranceId, "speech engine error " + errorCode);
            }
        });
    }

    // ------------------------------------------------------------------ storage

    @JavascriptInterface
    public String storageGet(String key) {
        return prefs.getString("k:" + key, null);
    }

    @JavascriptInterface
    public void storageSet(String key, String value) {
        prefs.edit().putString("k:" + key, value).apply();
    }

    @JavascriptInterface
    public void storageRemove(String key) {
        prefs.edit().remove("k:" + key).apply();
    }

    @JavascriptInterface
    public String storageKeys() {
        JSONArray keys = new JSONArray();
        for (String k : prefs.getAll().keySet()) {
            if (k.startsWith("k:")) keys.put(k.substring(2));
        }
        return keys.toString();
    }

    // ------------------------------------------------------------------ network

    /** Runs a request in the background and answers window.__ldNative.httpDone(id, status, base64Body, error). */
    @JavascriptInterface
    public void http(final String id, final String method, final String url, final String headersJson, final String body) {
        pool.execute(() -> {
            int status = 0;
            String b64 = "";
            String error = null;
            HttpURLConnection conn = null;
            try {
                URL u = new URL(url);
                String host = u.getHost() == null ? "" : u.getHost();
                boolean local = host.equals("localhost") || host.equals("127.0.0.1");
                if (!"https".equals(u.getProtocol()) && !local) throw new IOException("only https addresses are allowed");
                conn = (HttpURLConnection) u.openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(120000);
                conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method.toUpperCase(Locale.ROOT));
                conn.setRequestProperty("User-Agent", MainActivity.DESKTOP_UA);
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject h = new JSONObject(headersJson);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        conn.setRequestProperty(k, h.getString(k));
                    }
                }
                if (body != null && !body.isEmpty() && !"GET".equals(conn.getRequestMethod())) {
                    conn.setDoOutput(true);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                status = conn.getResponseCode();
                InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                byte[] data = is == null ? new byte[0] : readAll(is);
                b64 = Base64.encodeToString(data, Base64.NO_WRAP);
            } catch (Exception e) {
                status = 0;
                error = String.valueOf(e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
            deliver("httpDone", id, status, b64, error);
        });
    }

    // ------------------------------------------------------------------ phone text-to-speech

    @JavascriptInterface
    public boolean ttsIsReady() {
        return ttsReady;
    }

    /** Voices of the phone's speech engine for a language code such as "bn" (all languages if empty). */
    @JavascriptInterface
    public String ttsVoices(String lang) {
        JSONArray out = new JSONArray();
        if (!ttsReady) return out.toString();
        try {
            Set<Voice> voices = tts.getVoices();
            if (voices == null) return out.toString();
            for (Voice v : voices) {
                Locale l = v.getLocale();
                if (lang != null && !lang.isEmpty() && !l.getLanguage().equals(lang)) continue;
                JSONObject o = new JSONObject();
                o.put("name", v.getName());
                o.put("locale", l.toLanguageTag());
                o.put("network", v.isNetworkConnectionRequired());
                o.put("installed", !v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
                out.put(o);
            }
        } catch (Exception ignored) {
        }
        return out.toString();
    }

    /** Speaks text into a WAV file and answers window.__ldNative.ttsDone(id, status, base64Wav, error). */
    @JavascriptInterface
    public void tts(final String id, final String text, final String voiceName, final String langTag) {
        ui.post(() -> speak(id, text, voiceName, langTag, 0));
    }

    /**
     * Selects the requested voice, then synthesizes. Right after the speech engine starts, a voice
     * switch can be refused while the voice is still loading; then we wait and retry instead of
     * silently speaking with the default voice (which may be the other gender).
     */
    private void speak(final String id, final String text, final String voiceName, final String langTag, final int attempt) {
        if (!ttsReady) {
            if (attempt < 20) {
                ui.postDelayed(() -> speak(id, text, voiceName, langTag, attempt + 1), 250);
            } else {
                deliver("ttsDone", id, 0, "", "The phone's speech engine is not ready");
            }
            return;
        }
        try {
            Voice chosen = null;
            Set<Voice> all = tts.getVoices();
            if (voiceName != null && !voiceName.isEmpty() && all != null) {
                for (Voice v : all) {
                    if (v.getName().equals(voiceName)) {
                        chosen = v;
                        break;
                    }
                }
            }
            int selected;
            if (chosen != null && !chosen.getName().equals(currentVoice)) {
                // Switch voice, then give the engine time to load it before the first sentence,
                // so that sentence is not spoken with the previous (or default) voice.
                selected = tts.setVoice(chosen);
                if (selected == TextToSpeech.SUCCESS) {
                    currentVoice = chosen.getName();
                    ui.postDelayed(() -> speak(id, text, voiceName, langTag, attempt + 1), 700);
                    return;
                }
            } else if (chosen != null) {
                selected = TextToSpeech.SUCCESS;
            } else {
                currentVoice = "";
                selected = tts.setLanguage(Locale.forLanguageTag(langTag == null || langTag.isEmpty() ? "bn-BD" : langTag));
                if (selected >= TextToSpeech.LANG_AVAILABLE) selected = TextToSpeech.SUCCESS;
            }
            if (selected != TextToSpeech.SUCCESS) {
                if (attempt < 20) {
                    ui.postDelayed(() -> speak(id, text, voiceName, langTag, attempt + 1), 300);
                } else {
                    deliver("ttsDone", id, 0, "", "The chosen voice could not be loaded: " + voiceName);
                }
                return;
            }
            String safe = id.replaceAll("[^A-Za-z0-9_-]", "");
            File file = new File(activity.getCacheDir(), "tts-" + safe + ".wav");
            String utterance = "u" + safe;
            pendingSpeech.put(utterance, id + "|" + file.getAbsolutePath());
            int r = tts.synthesizeToFile(text, new Bundle(), file, utterance);
            if (r != TextToSpeech.SUCCESS) {
                pendingSpeech.remove(utterance);
                deliver("ttsDone", id, 0, "", "The speech engine refused the text");
            }
        } catch (Exception e) {
            deliver("ttsDone", id, 0, "", String.valueOf(e.getMessage()));
        }
    }

    private void finishSpeech(String utterance, final String error) {
        final String entry = pendingSpeech.remove(utterance);
        if (entry == null) return;
        final int bar = entry.indexOf('|');
        final String id = entry.substring(0, bar);
        final File file = new File(entry.substring(bar + 1));
        pool.execute(() -> {
            String b64 = "";
            String err = error;
            if (err == null) {
                try (FileInputStream in = new FileInputStream(file)) {
                    b64 = Base64.encodeToString(readAll(in), Base64.NO_WRAP);
                } catch (Exception e) {
                    err = String.valueOf(e.getMessage());
                }
            }
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            deliver("ttsDone", id, err == null ? 200 : 0, b64, err);
        });
    }

    @JavascriptInterface
    public void openTtsSettings() {
        ui.post(() -> {
            Intent install = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                activity.startActivity(install);
            } catch (Exception e) {
                Intent settings = new Intent("com.android.settings.TTS_SETTINGS");
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    activity.startActivity(settings);
                } catch (Exception ignored) {
                }
            }
        });
    }

    // ------------------------------------------------------------------ clipboard and screens

    @JavascriptInterface
    public String clipboardText() {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence t = clip.getItemAt(0).coerceToText(activity);
            return t == null ? "" : t.toString();
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public void openHome() {
        ui.post(activity::openHome);
    }

    @JavascriptInterface
    public void openSettings() {
        ui.post(activity::openSettings);
    }

    @JavascriptInterface
    public void openSignIn() {
        ui.post(activity::openSignIn);
    }

    // ------------------------------------------------------------------ helpers

    private void deliver(String fn, String id, int status, String b64, String error) {
        final String js = "window.__ldNative&&window.__ldNative." + fn + "(" + JSONObject.quote(id) + "," + status + ","
                + JSONObject.quote(b64) + "," + (error == null ? "null" : JSONObject.quote(error)) + ")";
        ui.post(() -> web.evaluateJavascript(js, null));
    }

    void shutdown() {
        try {
            tts.shutdown();
        } catch (Exception ignored) {
        }
        pool.shutdownNow();
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
