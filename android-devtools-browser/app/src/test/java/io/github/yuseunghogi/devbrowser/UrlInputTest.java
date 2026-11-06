package io.github.yuseunghogi.devbrowser;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UrlInputTest {
    private static String search(String q) {
        return UrlInput.search(q);
    }

    @Test
    public void emptyInputIsIgnored() {
        assertNull(UrlInput.toUrl(null));
        assertNull(UrlInput.toUrl("   "));
    }

    @Test
    public void fullUrlsPassThrough() {
        assertEquals("https://example.com/a?b=1", UrlInput.toUrl("  https://example.com/a?b=1 "));
        assertEquals("http://example.com", UrlInput.toUrl("http://example.com"));
        assertEquals("about:blank", UrlInput.toUrl("about:blank"));
        assertEquals("javascript:alert(1)", UrlInput.toUrl("javascript:alert(1)"));
        assertEquals("ftp://files.example.com/x", UrlInput.toUrl("ftp://files.example.com/x"));
        assertEquals("HTTPS://EXAMPLE.COM", UrlInput.toUrl("HTTPS://EXAMPLE.COM"));
    }

    @Test
    public void domainsGetHttps() {
        assertEquals("https://example.com", UrlInput.toUrl("example.com"));
        assertEquals("https://www.naver.com/path?q=1#top", UrlInput.toUrl("www.naver.com/path?q=1#top"));
        assertEquals("https://example.com:8443/x", UrlInput.toUrl("example.com:8443/x"));
        assertEquals("https://한글.kr", UrlInput.toUrl("한글.kr"));
        assertEquals("https://xn--3e0b707e.xn--3e0b707e", UrlInput.toUrl("xn--3e0b707e.xn--3e0b707e"));
        assertEquals("https://user@example.com", UrlInput.toUrl("user@example.com"));
    }

    @Test
    public void localDevServersGetHttp() {
        assertEquals("http://localhost:5173", UrlInput.toUrl("localhost:5173"));
        assertEquals("http://localhost", UrlInput.toUrl("localhost"));
        assertEquals("http://192.168.0.10:3000/app", UrlInput.toUrl("192.168.0.10:3000/app"));
        assertEquals("http://10.0.2.2:8080", UrlInput.toUrl("10.0.2.2:8080"));
        assertEquals("http://myapp.local", UrlInput.toUrl("myapp.local"));
        assertEquals("http://api.localhost:4000", UrlInput.toUrl("api.localhost:4000"));
        assertEquals("http://[::1]:8080/", UrlInput.toUrl("[::1]:8080/"));
    }

    @Test
    public void everythingElseIsSearched() {
        assertEquals(search("hello world"), UrlInput.toUrl("hello world"));
        assertEquals(search("eruda"), UrlInput.toUrl("eruda"));
        assertEquals(search("3.14"), UrlInput.toUrl("3.14"));
        assertEquals(search("a.b"), UrlInput.toUrl("a.b"));
        assertEquals(search("999.1.1.1"), UrlInput.toUrl("999.1.1.1"));
        assertEquals(search("example.com:abc"), UrlInput.toUrl("example.com:abc"));
        assertEquals(search("-bad-.com"), UrlInput.toUrl("-bad-.com"));
        assertEquals(search("view-source:https://example.com"), UrlInput.toUrl("view-source:https://example.com"));
    }

    @Test
    public void searchEncodesQuery() {
        assertEquals("https://www.google.com/search?q=%ED%95%9C%EA%B8%80+a%26b", UrlInput.search("한글 a&b"));
    }

    @Test
    public void sharedTextPicksFirstLink() {
        assertEquals("https://example.com/x?y=1",
                UrlInput.fromSharedText("이것 좀 봐 https://example.com/x?y=1 그리고 https://other.com"));
        assertEquals("https://example.com", UrlInput.fromSharedText("example.com"));
        assertEquals(search("그냥 글"), UrlInput.fromSharedText("그냥 글"));
        assertNull(UrlInput.fromSharedText(null));
    }

    @Test
    public void localDetection() {
        assertTrue(UrlInput.isLocalOrIp("127.0.0.1"));
        assertTrue(UrlInput.isLocalOrIp("8.8.8.8"));
        assertFalse(UrlInput.isLocalOrIp("example.com"));
    }

    @Test
    public void cspHeadersAreDropped() {
        assertTrue(CspStripper.isDroppedHeader("Content-Security-Policy"));
        assertTrue(CspStripper.isDroppedHeader("content-security-policy-report-only"));
        assertTrue(CspStripper.isDroppedHeader("Content-Length"));
        assertFalse(CspStripper.isDroppedHeader("Cache-Control"));
        assertFalse(CspStripper.isDroppedHeader("X-Frame-Options"));
    }

    @Test
    public void contentTypeParsing() {
        assertArrayEquals(new String[] {"text/html", "utf-8"}, CspStripper.parseContentType("text/html; charset=utf-8"));
        assertArrayEquals(new String[] {"text/html", "EUC-KR"}, CspStripper.parseContentType("Text/HTML;Charset=\"EUC-KR\""));
        assertArrayEquals(new String[] {"application/xhtml+xml", null}, CspStripper.parseContentType("application/xhtml+xml"));
        assertArrayEquals(new String[] {"text/html", null}, CspStripper.parseContentType(null));
    }

    @Test
    public void desktopUserAgent() {
        String mobile = "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36";
        assertEquals("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Safari/537.36",
                MainActivity.desktopUserAgent(mobile));
    }
}
