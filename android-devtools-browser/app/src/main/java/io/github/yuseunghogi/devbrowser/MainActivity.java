package io.github.yuseunghogi.devbrowser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.webkit.WebViewCompat;

import java.net.URISyntaxException;
import java.util.Locale;

/** 주소창 + WebView + 개발자 도구(Eruda) 버튼으로 된 브라우저 화면. */
public class MainActivity extends Activity {
    static final String START_URL = "file:///android_asset/start.html";

    private static final int REQUEST_FILE = 1;
    private static final String PREFS = "settings";
    private static final String KEY_AUTO = "auto_devtools";
    private static final String KEY_DESKTOP = "desktop_mode";
    private static final String KEY_STRIP_CSP = "strip_csp";
    private static final String KEY_LAST_URL = "last_url";

    private WebView web;
    private EditText urlBar;
    private ProgressBar progress;
    private ImageButton btnBack;
    private ImageButton btnForward;
    private ImageButton btnReload;

    private SharedPreferences prefs;
    private DevTools devTools;
    private boolean loading;
    private ValueCallback<Uri[]> fileCallback;

    // shouldInterceptRequest(백그라운드 스레드)에서 읽는 값
    private volatile boolean stripCsp;
    private volatile String userAgent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 개발용 앱이므로 항상 켠다: PC 크롬 chrome://inspect 에서 이 앱의 페이지를 원격 디버깅할 수 있다.
        WebView.setWebContentsDebuggingEnabled(true);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        stripCsp = prefs.getBoolean(KEY_STRIP_CSP, false);

        web = findViewById(R.id.web);
        urlBar = findViewById(R.id.url_bar);
        progress = findViewById(R.id.progress);
        btnBack = findViewById(R.id.btn_back);
        btnForward = findViewById(R.id.btn_forward);
        btnReload = findViewById(R.id.btn_reload);

        setUpWindow(findViewById(R.id.root));
        setUpWebView();
        setUpToolbar();

        devTools = new DevTools(this);
        devTools.setAuto(web, prefs.getBoolean(KEY_AUTO, true));

        String fromIntent = urlFromIntent(getIntent());
        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) {
            // 프로세스가 다시 만들어졌을 때: 보던 페이지로 돌아간다.
        } else if (fromIntent != null) {
            web.loadUrl(fromIntent);
        } else {
            web.loadUrl(prefs.getString(KEY_LAST_URL, START_URL));
        }
        updateNavButtons();
    }

    // ---------------------------------------------------------------- 화면

    /**
     * Android 11+는 화면 끝까지 그리고(edge-to-edge) 상태 표시줄·내비게이션 바·키보드 높이만큼 직접 여백을 준다.
     * targetSdk 35부터 Android 15에서는 어차피 강제되므로 11 이상을 같은 방식으로 맞춘다.
     * 그 이전 버전은 시스템이 자리를 비워 주고 테마 색을 칠한다.
     */
    private void setUpWindow(View root) {
        if (Build.VERSION.SDK_INT < 30) return;
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller != null) {
            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(isNightMode() ? 0 : mask, mask);
        }
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });
    }

    private boolean isNightMode() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    private void setUpToolbar() {
        urlBar.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null
                    && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                String url = UrlInput.toUrl(urlBar.getText().toString());
                if (url != null) {
                    web.loadUrl(url);
                    leaveUrlBar();
                }
                return true;
            }
            return false;
        });
        urlBar.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) showUrl(web.getUrl());
        });

        btnBack.setOnClickListener(v -> {
            if (web.canGoBack()) web.goBack();
        });
        btnForward.setOnClickListener(v -> {
            if (web.canGoForward()) web.goForward();
        });
        btnReload.setOnClickListener(v -> {
            if (loading) web.stopLoading();
            else web.reload();
        });
        findViewById(R.id.btn_home).setOnClickListener(v -> web.loadUrl(START_URL));
        findViewById(R.id.btn_devtools).setOnClickListener(v -> devTools.toggle(web));
        findViewById(R.id.btn_menu).setOnClickListener(this::showMenu);
    }

    private void leaveUrlBar() {
        urlBar.clearFocus();
        web.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(urlBar.getWindowToken(), 0);
    }

    private void showUrl(String url) {
        if (urlBar.hasFocus()) return;
        urlBar.setText(url == null || url.equals(START_URL) ? "" : url);
    }

    private void setLoading(boolean value) {
        loading = value;
        btnReload.setImageResource(value ? R.drawable.ic_close : R.drawable.ic_refresh);
        btnReload.setContentDescription(getString(value ? R.string.stop : R.string.reload));
        if (!value) progress.setVisibility(View.GONE);
    }

    private void updateNavButtons() {
        btnBack.setEnabled(web.canGoBack());
        btnBack.setAlpha(web.canGoBack() ? 1f : 0.35f);
        btnForward.setEnabled(web.canGoForward());
        btnForward.setAlpha(web.canGoForward() ? 1f : 0.35f);
    }

    // ---------------------------------------------------------------- 메뉴

    private void showMenu(View anchor) {
        PopupMenu popup = new PopupMenu(this, anchor);
        popup.getMenuInflater().inflate(R.menu.main, popup.getMenu());
        Menu menu = popup.getMenu();
        menu.findItem(R.id.action_auto).setChecked(prefs.getBoolean(KEY_AUTO, true));
        menu.findItem(R.id.action_desktop).setChecked(prefs.getBoolean(KEY_DESKTOP, false));
        menu.findItem(R.id.action_strip_csp).setChecked(stripCsp);
        popup.setOnMenuItemClickListener(this::onMenuItem);
        popup.show();
    }

    private boolean onMenuItem(MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_auto) {
            boolean on = !item.isChecked();
            prefs.edit().putBoolean(KEY_AUTO, on).apply();
            devTools.setAuto(web, on);
            if (on) devTools.ensure(web);
            toast(on ? R.string.auto_on : R.string.auto_off);
        } else if (id == R.id.action_desktop) {
            boolean on = !item.isChecked();
            prefs.edit().putBoolean(KEY_DESKTOP, on).apply();
            applyUserAgent(on);
            web.reload();
        } else if (id == R.id.action_strip_csp) {
            stripCsp = !item.isChecked();
            prefs.edit().putBoolean(KEY_STRIP_CSP, stripCsp).apply();
            toast(stripCsp ? R.string.strip_csp_on : R.string.strip_csp_off);
            web.reload();
        } else if (id == R.id.action_share) {
            String url = web.getUrl();
            if (url != null && !url.equals(START_URL)) {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url);
                startActivity(Intent.createChooser(send, getString(R.string.share)));
            }
        } else if (id == R.id.action_external) {
            String url = web.getUrl();
            if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) openExternal(url);
        } else if (id == R.id.action_clear) {
            confirmClearData();
        } else if (id == R.id.action_about) {
            showAbout();
        } else {
            return false;
        }
        return true;
    }

    private void confirmClearData() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.clear_data)
                .setMessage(R.string.clear_data_message)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.delete, (d, w) -> {
                    CookieManager.getInstance().removeAllCookies(null);
                    CookieManager.getInstance().flush();
                    WebStorage.getInstance().deleteAllData();
                    web.clearCache(true);
                    web.clearFormData();
                    web.clearHistory();
                    updateNavButtons();
                    toast(R.string.cleared);
                })
                .show();
    }

    private void showAbout() {
        String webViewVersion = "?";
        PackageInfo pkg = WebViewCompat.getCurrentWebViewPackage(this);
        if (pkg != null) webViewVersion = pkg.packageName + " " + pkg.versionName;
        String appVersion = "?";
        try {
            appVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        String message = getString(R.string.about_message,
                appVersion,
                webViewVersion,
                getString(devTools.isDocumentStartSupported() ? R.string.yes : R.string.no));
        new AlertDialog.Builder(this)
                .setTitle(R.string.about)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private void setUpWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        applyUserAgent(prefs.getBoolean(KEY_DESKTOP, false));

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(this::onDownload);
    }

    /** 데스크톱 모드: 기본 UA에서 안드로이드·모바일 표시를 빼 PC 크롬처럼 보이게 한다. */
    private void applyUserAgent(boolean desktop) {
        WebSettings s = web.getSettings();
        s.setUserAgentString(desktop ? desktopUserAgent(WebSettings.getDefaultUserAgent(this)) : null);
        userAgent = s.getUserAgentString();
    }

    static String desktopUserAgent(String mobile) {
        return mobile.replaceFirst("\\(Linux; Android[^)]*\\)", "(X11; Linux x86_64)")
                .replace(" Version/4.0", "")
                .replace(" Mobile", "");
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            String scheme = request.getUrl().getScheme();
            scheme = scheme == null ? "" : scheme.toLowerCase(Locale.ROOT);
            switch (scheme) {
                case "http":
                case "https":
                case "file":
                case "about":
                case "data":
                case "blob":
                case "javascript":
                    return false;
                default:
                    openExternal(url); // tel:, mailto:, intent:, market: 등은 다른 앱으로
                    return true;
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            setLoading(true);
            progress.setProgress(0);
            progress.setVisibility(View.VISIBLE);
            showUrl(url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            setLoading(false);
            showUrl(url);
            updateNavButtons();
            if (prefs.getBoolean(KEY_AUTO, true)) devTools.ensure(view);
            if (url != null && (url.startsWith("http://") || url.startsWith("https://") || url.equals(START_URL))) {
                prefs.edit().putString(KEY_LAST_URL, url).apply();
            }
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            showUrl(url);
            updateNavButtons();
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!stripCsp || !request.isForMainFrame() || !"GET".equalsIgnoreCase(request.getMethod())) return null;
            String scheme = request.getUrl().getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
            return CspStripper.fetch(request, userAgent);
        }

        /** 로컬 개발 서버의 자체 서명 인증서 등. 사용자가 고르게 한다(기본은 취소). */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            if (isFinishing()) {
                handler.cancel();
                return;
            }
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.ssl_error_title)
                    .setMessage(getString(R.string.ssl_error_message, error.getUrl()))
                    .setNegativeButton(R.string.ssl_cancel, (d, w) -> handler.cancel())
                    .setPositiveButton(R.string.ssl_proceed, (d, w) -> handler.proceed())
                    .setOnCancelListener(d -> handler.cancel())
                    .show();
        }

        /** 렌더러가 죽으면 이 WebView는 더 쓸 수 없다. 화면을 다시 만든다(앱 전체가 죽지 않게). */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.destroy();
            if (view == web) {
                web = null;
                toast(R.string.renderer_gone);
                recreate();
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setProgress(newProgress);
            if (newProgress >= 100) progress.setVisibility(View.GONE);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(intent, REQUEST_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                toast(R.string.no_file_picker);
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] {data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    private void onDownload(String url, String ua, String contentDisposition, String mimeType, long length) {
        boolean http = url.startsWith("http://") || url.startsWith("https://");
        if (!http) {
            toast(R.string.download_unsupported); // blob:, data: 는 페이지 안에서만 의미가 있다
            return;
        }
        if (Build.VERSION.SDK_INT < 29) { // 그 전에는 공용 다운로드 폴더에 쓰려면 저장소 권한이 필요하다
            openExternal(url);
            return;
        }
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                    .setMimeType(mimeType)
                    .addRequestHeader("User-Agent", ua)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) req.addRequestHeader("Cookie", cookie);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(req);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            openExternal(url);
        }
    }

    // ---------------------------------------------------------------- 다른 앱과 주고받기

    private void openExternal(String url) {
        Intent intent;
        try {
            if (url.startsWith("intent:")) {
                intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                // 웹 페이지가 앱 내부 화면을 직접 열지 못하게 한다.
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            }
        } catch (URISyntaxException e) {
            toast(R.string.cannot_open);
            return;
        }
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException e) {
            String fallback = intent.getStringExtra("browser_fallback_url");
            if (fallback != null && (fallback.startsWith("http://") || fallback.startsWith("https://"))) {
                web.loadUrl(fallback);
            } else {
                toast(R.string.cannot_open);
            }
        }
    }

    private static String urlFromIntent(Intent intent) {
        if (intent == null) return null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            return intent.getDataString();
        }
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            return UrlInput.fromSharedText(intent.getStringExtra(Intent.EXTRA_TEXT));
        }
        return null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = urlFromIntent(intent);
        if (url != null && web != null) web.loadUrl(url);
    }

    // ---------------------------------------------------------------- 생명주기

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (urlBar.hasFocus()) {
            leaveUrlBar();
        } else if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void toast(int resId) {
        Toast.makeText(this, resId, Toast.LENGTH_SHORT).show();
    }
}
