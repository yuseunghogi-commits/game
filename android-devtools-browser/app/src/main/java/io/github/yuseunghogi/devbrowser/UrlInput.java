package io.github.yuseunghogi.devbrowser;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 주소창 입력을 열 수 있는 주소로 바꾼다. 안드로이드 API를 쓰지 않아 JVM 단위 테스트로 확인한다. */
final class UrlInput {
    static final String SEARCH_URL = "https://www.google.com/search?q=";

    /** 그대로 여는 스킴. 그 밖의 "이름:..."은 localhost:3000 같은 호스트:포트일 수 있어 따로 판단한다. */
    private static final Pattern KNOWN_SCHEME =
            Pattern.compile("(?i)^(https?|file|about|data|javascript|mailto|tel|sms|intent|market|content):.*", Pattern.DOTALL);
    private static final Pattern ANY_SCHEME_WITH_SLASHES = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*://.*", Pattern.DOTALL);
    private static final Pattern IPV4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");
    private static final Pattern LABEL = Pattern.compile("^[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?$");
    private static final Pattern TLD = Pattern.compile("^(?:\\p{L}{2,}|xn--[a-z0-9-]+)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern WEB_URL_IN_TEXT = Pattern.compile("https?://[^\\s<>\"']+", Pattern.CASE_INSENSITIVE);

    private UrlInput() {}

    /** 주소처럼 보이면 주소로, 아니면 검색 주소로. 빈 입력은 null. */
    static String toUrl(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (KNOWN_SCHEME.matcher(s).matches() || ANY_SCHEME_WITH_SLASHES.matcher(s).matches()) return s;
        if (s.indexOf(' ') >= 0) return search(s);

        String host = hostOf(s);
        if (host == null) return search(s);
        // 개발 서버(로컬·사설 IP)는 대부분 TLS가 없으니 http로 연다.
        return (isLocalOrIp(host) ? "http://" : "https://") + s;
    }

    /** 공유받은 글에서 첫 웹 주소를 꺼낸다. 없으면 글 전체로 주소/검색을 만든다. */
    static String fromSharedText(String text) {
        if (text == null) return null;
        Matcher m = WEB_URL_IN_TEXT.matcher(text);
        if (m.find()) return m.group();
        return toUrl(text);
    }

    static String search(String query) {
        try {
            return SEARCH_URL + URLEncoder.encode(query, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new AssertionError(e);
        }
    }

    /** "host[:port][/path]"의 host. 호스트로 볼 수 없으면 null. */
    static String hostOf(String s) {
        int end = s.length();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                end = i;
                break;
            }
        }
        String authority = s.substring(0, end);
        int at = authority.lastIndexOf('@');
        if (at >= 0) authority = authority.substring(at + 1);
        if (authority.isEmpty()) return null;

        String host;
        if (authority.startsWith("[")) { // IPv6 [::1]:8080
            int close = authority.indexOf(']');
            if (close < 0) return null;
            host = authority.substring(0, close + 1);
            String rest = authority.substring(close + 1);
            if (!rest.isEmpty() && !rest.matches(":\\d{1,5}")) return null;
            return host.matches("\\[[0-9a-fA-F:.]+]") ? host.toLowerCase(Locale.ROOT) : null;
        }
        int colon = authority.indexOf(':');
        host = colon >= 0 ? authority.substring(0, colon) : authority;
        if (colon >= 0 && !authority.substring(colon + 1).matches("\\d{1,5}")) return null;
        host = host.toLowerCase(Locale.ROOT);

        if (host.equals("localhost") || isIpv4(host)) return host;
        String[] labels = host.split("\\.", -1);
        if (labels.length < 2) return null;
        for (String label : labels) {
            if (!LABEL.matcher(label).matches()) return null;
        }
        return TLD.matcher(labels[labels.length - 1]).matches() ? host : null;
    }

    static boolean isLocalOrIp(String host) {
        return host.equals("localhost")
                || host.endsWith(".localhost")
                || host.endsWith(".local")
                || host.startsWith("[")
                || isIpv4(host);
    }

    private static boolean isIpv4(String host) {
        Matcher m = IPV4.matcher(host);
        if (!m.matches()) return false;
        for (int i = 1; i <= 4; i++) {
            if (Integer.parseInt(m.group(i)) > 255) return false;
        }
        return true;
    }
}
