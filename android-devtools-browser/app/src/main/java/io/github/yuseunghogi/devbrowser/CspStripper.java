package io.github.yuseunghogi.devbrowser;

import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 'CSP 해제(실험적)' 옵션. 최상위 문서(GET)를 앱이 대신 받아 Content-Security-Policy 헤더를 빼고 WebView에 넘긴다.
 * eval이 막힌 사이트에서도 개발자 도구 콘솔에 입력한 코드가 실행되게 하려는 것이다.
 *
 * <p>한계: HTML 안의 &lt;meta http-equiv="Content-Security-Policy"&gt;는 그대로 남는다. 리다이렉트 응답은 WebView가
 * 직접 다시 받는다(null 반환). POST 등 본문이 있는 요청은 건드리지 않는다.
 */
final class CspStripper {
    private CspStripper() {}

    /** 처리할 수 없는 경우 null(그러면 WebView가 평소처럼 직접 받는다). 백그라운드 스레드에서 불린다. */
    static WebResourceResponse fetch(WebResourceRequest request, String userAgent) {
        String url = request.getUrl().toString();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                // 압축은 HttpURLConnection이 알아서 풀도록 Accept-Encoding은 넘기지 않는다.
                if (h.getKey() != null && !h.getKey().equalsIgnoreCase("Accept-Encoding")) {
                    conn.setRequestProperty(h.getKey(), h.getValue());
                }
            }
            if (userAgent != null) conn.setRequestProperty("User-Agent", userAgent);
            CookieManager cookies = CookieManager.getInstance();
            String cookie = cookies.getCookie(url);
            if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);

            int code = conn.getResponseCode();
            if (code < 200 || code > 599 || (code >= 300 && code < 400)) {
                conn.disconnect();
                return null;
            }

            Map<String, String> headers = new HashMap<>();
            for (Map.Entry<String, List<String>> h : conn.getHeaderFields().entrySet()) {
                String name = h.getKey();
                if (name == null || h.getValue() == null) continue; // 상태 줄
                if (name.equalsIgnoreCase("Set-Cookie")) {
                    for (String v : h.getValue()) cookies.setCookie(url, v);
                    continue;
                }
                if (isDroppedHeader(name)) continue;
                headers.put(name, join(h.getValue()));
            }
            cookies.flush();

            String[] type = parseContentType(conn.getContentType());
            InputStream body = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            String reason = conn.getResponseMessage();
            if (reason == null || reason.trim().isEmpty()) reason = code < 400 ? "OK" : "Error"; // HTTP/2에는 사유 문구가 없다
            return new WebResourceResponse(type[0], type[1], code, reason, headers, body);
        } catch (IOException | RuntimeException e) {
            if (conn != null) conn.disconnect();
            return null;
        }
    }

    /** 빼는 헤더: CSP, 그리고 본문을 다시 넘기면서 맞지 않게 되는 길이·인코딩·연결 관련 헤더. */
    static boolean isDroppedHeader(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        return n.equals("content-security-policy")
                || n.equals("content-security-policy-report-only")
                || n.equals("content-length")
                || n.equals("content-encoding")
                || n.equals("transfer-encoding")
                || n.equals("connection")
                || n.equals("keep-alive");
    }

    /** "text/html; charset=UTF-8" → {"text/html", "UTF-8"}. 값이 없으면 text/html, 문자셋은 null(WebView가 추정). */
    static String[] parseContentType(String contentType) {
        String mime = "text/html";
        String charset = null;
        if (contentType != null) {
            String[] parts = contentType.split(";");
            if (!parts[0].trim().isEmpty()) mime = parts[0].trim().toLowerCase(Locale.ROOT);
            for (int i = 1; i < parts.length; i++) {
                String p = parts[i].trim();
                if (p.toLowerCase(Locale.ROOT).startsWith("charset=")) {
                    charset = p.substring("charset=".length()).trim().replace("\"", "");
                    if (charset.isEmpty()) charset = null;
                }
            }
        }
        return new String[] {mime, charset};
    }

    private static String join(List<String> values) {
        StringBuilder sb = new StringBuilder();
        for (String v : values) {
            if (sb.length() > 0) sb.append(", ");
            sb.append(v);
        }
        return sb.toString();
    }
}
