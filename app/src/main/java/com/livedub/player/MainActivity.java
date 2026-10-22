package com.livedub.player;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Live Dub player: a WebView showing the YouTube watch page (official player)
 * with the Live Dub engine injected, plus local Home and Settings pages.
 */
public class MainActivity extends Activity {
    static final String HOME = "file:///android_asset/home.html";
    static final String SETTINGS = "file:///android_asset/settings.html";
    static final String YOUTUBE_ORIGIN = "https://www.youtube.com";
    // Desktop browser identity, so YouTube serves the page the dub engine was built for
    static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private static final Pattern VIDEO_ID =
            Pattern.compile("(?:v=|youtu\\.be/|/shorts/|/live/|/embed/)([A-Za-z0-9_-]{11})");

    private FrameLayout root;
    private WebView web;
    private NativeBridge bridge;
    private String injectScript = "";
    private boolean documentStartSupported = false;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setUserAgentString(DESKTOP_UA);
        // Do not announce the app as an embedded browser (Google refuses sign-in from those)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(s, Collections.<String>emptySet());
        }
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        bridge = new NativeBridge(this, web);
        web.addJavascriptInterface(bridge, "LiveDubNative");

        injectScript = readAsset("ld-youtube.js");
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, injectScript, Collections.singleton(YOUTUBE_ORIGIN));
            documentStartSupported = true;
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (!documentStartSupported && url != null && url.startsWith(YOUTUBE_ORIGIN)) {
                    view.evaluateJavascript(injectScript, null);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // The scripts guard against running twice, so this is a safe second chance.
                if (url != null && url.startsWith(YOUTUBE_ORIGIN)) view.evaluateJavascript(injectScript, null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                enterFullscreen(view, callback);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        if (!openFromIntent(getIntent())) web.loadUrl(HOME);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openFromIntent(intent);
    }

    /** Opens a YouTube link shared from another app. Returns true if a video was opened. */
    private boolean openFromIntent(Intent intent) {
        if (intent == null) return false;
        String text = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            text = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else if (intent.getData() != null) {
            text = intent.getData().toString();
        }
        String id = videoId(text);
        if (id == null) return false;
        web.loadUrl(watchUrl(id));
        return true;
    }

    /** Decides which pages stay inside the app. */
    private boolean handleNavigation(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        String host = uri.getHost() == null ? "" : uri.getHost();
        if (scheme.equals("file")) return false;
        if (host.equals("m.youtube.com") || host.equals("youtube.com") || host.equals("youtu.be")) {
            String id = videoId(uri.toString());
            if (id != null) {
                web.loadUrl(watchUrl(id));
                return true;
            }
        }
        if (host.endsWith("youtube.com") || host.endsWith("google.com") || host.endsWith("gstatic.com")
                || host.endsWith("googleusercontent.com") || host.endsWith("ggpht.com") || host.endsWith("ytimg.com")) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));    // other websites open in the normal browser
        } catch (Exception ignored) {
        }
        return true;
    }

    static String videoId(String text) {
        if (text == null) return null;
        Matcher m = VIDEO_ID.matcher(text);
        return m.find() ? m.group(1) : null;
    }

    static String watchUrl(String id) {
        return YOUTUBE_ORIGIN + "/watch?v=" + id;
    }

    void openHome() {
        web.loadUrl(HOME);
    }

    void openSettings() {
        web.loadUrl(SETTINGS);
    }

    void openSignIn() {
        web.loadUrl("https://accounts.google.com/ServiceLogin?service=youtube&continue="
                + Uri.encode(YOUTUBE_ORIGIN + "/"));
    }

    // ------------------------------------------------------------------ fullscreen video

    private void enterFullscreen(View view, WebChromeClient.CustomViewCallback callback) {
        if (customView != null) {
            callback.onCustomViewHidden();
            return;
        }
        customView = view;
        customCallback = callback;
        root.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setVisibility(View.GONE);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        setFullscreenUi(true);
    }

    private void exitFullscreen() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        if (customCallback != null) customCallback.onCustomViewHidden();
        customCallback = null;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        setFullscreenUi(false);
    }

    @SuppressWarnings("deprecation")
    private void setFullscreenUi(boolean on) {
        View decor = getWindow().getDecorView();
        if (on) {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        } else {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (customView != null) {
            exitFullscreen();
        } else if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }
}
