package io.github.yuseunghogi.devbrowser;

import android.content.Context;
import android.webkit.WebView;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.util.Collections;

/**
 * 페이지에 Eruda(모바일 개발자 도구)를 붙인다. 실제 동작은 assets/devtools/boot.js 참고.
 *
 * <ul>
 *   <li>자동 실행 켬 + 문서 시작 주입 지원: 모든 페이지가 만들어지는 순간 boot.js(early)가 들어가 콘솔 로그를 처음부터 모은다.</li>
 *   <li>그 밖의 경우(file://, 오래된 WebView 등): 페이지 로드가 끝나면 {@link #ensure}가 붙인다.</li>
 *   <li>도구 버튼: {@link #toggle}로 열고 닫는다. 아직 없으면 그때 불러온다.</li>
 * </ul>
 */
final class DevTools {
    private static final String ERUDA_MARK = "//@@ERUDA@@";
    private static final String MODE_MARK = "'@@MODE@@'";
    /** 이 페이지에 eruda(또는 문서 시작 때 넣어 둔 eruda 코드)가 이미 있는지. 있으면 500KB짜리 본문을 다시 보내지 않는다. */
    private static final String PROBE =
            "(function(){return (window.eruda||typeof window.__devtoolsBrowserLoad==='function')?'present':'absent'})()";

    private final String template;
    private final String eruda;
    private boolean documentStartSupported;
    private ScriptHandler earlyScript;

    DevTools(Context context) {
        template = readAsset(context, "devtools/boot.js");
        eruda = readAsset(context, "devtools/eruda.js");
        documentStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
    }

    /** 이 WebView가 문서 시작 주입을 지원하는지(지원하면 로딩 초반 로그까지 잡힌다). */
    boolean isDocumentStartSupported() {
        return documentStartSupported;
    }

    /** 페이지마다 자동 실행. 다음에 여는 페이지부터 적용된다(지금 페이지는 {@link #ensure}로). */
    void setAuto(WebView web, boolean on) {
        if (on) {
            if (earlyScript == null && documentStartSupported) {
                try {
                    earlyScript = WebViewCompat.addDocumentStartJavaScript(web, build("early", true), Collections.singleton("*"));
                } catch (RuntimeException e) {
                    // 등록을 거부하는 WebView가 있으면 로드 후 주입(ensure)으로만 동작한다.
                    documentStartSupported = false;
                }
            }
        } else if (earlyScript != null) {
            earlyScript.remove();
            earlyScript = null;
        }
    }

    /** 자동 실행일 때 페이지 로드가 끝나면 부른다. 이미 붙어 있으면 아무 일도 하지 않는다. */
    void ensure(final WebView web) {
        web.evaluateJavascript(PROBE, value -> web.evaluateJavascript(build("auto", !isPresent(value)), null));
    }

    /** 개발자 도구 창 열기/닫기. */
    void toggle(final WebView web) {
        web.evaluateJavascript(PROBE, value -> web.evaluateJavascript(build("toggle", !isPresent(value)), null));
    }

    private static boolean isPresent(String probeResult) {
        return "\"present\"".equals(probeResult);
    }

    private String build(String mode, boolean withEruda) {
        return template.replace(ERUDA_MARK, withEruda ? eruda : "").replace(MODE_MARK, "'" + mode + "'");
    }

    private static String readAsset(Context context, String path) {
        try (InputStream in = context.getAssets().open(path)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(in.available(), 8192));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), Charset.forName("UTF-8"));
        } catch (IOException e) {
            throw new IllegalStateException("asset 읽기 실패: " + path, e);
        }
    }
}
