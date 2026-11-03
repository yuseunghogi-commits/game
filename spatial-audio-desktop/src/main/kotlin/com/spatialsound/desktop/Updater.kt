package com.spatialsound.desktop

import java.awt.Desktop
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.zip.ZipInputStream

/**
 * PC 앱 업데이트.
 *
 * 시작할 때 GitHub 최신 릴리스를 확인하고, 새 버전이면 알려 준다.
 * Windows 앱(3DSound.exe)은 zip 을 받아 풀고, 앱이 꺼진 뒤 파일을 바꿔 끼우고 다시 실행하는 작은 스크립트로 자동 업데이트.
 * jar(맥·리눅스)는 릴리스 페이지를 연다.
 */
object Updater {
    const val REPO = "yuseunghogi-commits/game"
    private const val LATEST_API = "https://api.github.com/repos/$REPO/releases/latest"
    const val RELEASES_PAGE = "https://github.com/$REPO/releases/latest"
    const val WEB_APP = "https://yuseunghogi-commits.github.io/game/"
    private const val WIN_ASSET = "3DSound-Windows.zip"
    private const val JAR_ASSET = "3DSound-Mac-Linux.jar"

    data class Release(
        val version: String,
        val notes: String,
        val page: String,
        val windowsZip: String?,
        val jar: String?,
    )

    /** 빌드할 때 RELEASE_VERSION 에서 넣은 버전 (개발 중 실행이면 "dev") */
    val currentVersion: String by lazy {
        runCatching {
            Updater::class.java.getResourceAsStream("/spatial-sound-version.txt")?.use {
                it.readBytes().toString(StandardCharsets.UTF_8).trim()
            }
        }.getOrNull()?.ifBlank { null } ?: "dev"
    }

    /** jpackage 로 만든 Windows 앱이면 실행 파일 경로 (아니면 null) */
    val appExe: File? by lazy {
        System.getProperty("jpackage.app-path")?.let { File(it) }?.takeIf { it.isFile }
    }

    val isWindows = System.getProperty("os.name").orEmpty().startsWith("Windows")

    fun isNewer(remote: String, local: String): Boolean {
        if (local == "dev") return false
        fun parts(v: String) = v.trim().removePrefix("v").split('.', '-', ' ')
            .map { p -> p.takeWhile { it.isDigit() }.toIntOrNull() ?: 0 }
        val a = parts(remote)
        val b = parts(local)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private val http: HttpClient by lazy {
        HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(15))
            .build()
    }

    fun fetchLatest(): Release {
        val req = HttpRequest.newBuilder(URI(LATEST_API))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "3DSound-PC")
            .timeout(Duration.ofSeconds(20))
            .GET().build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofString())
        if (res.statusCode() != 200) throw IllegalStateException("서버 응답 ${res.statusCode()}")
        return parseRelease(res.body())
    }

    /** GitHub 릴리스 JSON 에서 필요한 값만 (라이브러리 없이) */
    fun parseRelease(json: String): Release {
        val tag = jsonString(json, "tag_name") ?: throw IllegalStateException("버전 정보 없음")
        val urls = Regex("\"browser_download_url\"\\s*:\\s*\"([^\"]+)\"").findAll(json).map { it.groupValues[1] }.toList()
        val page = Regex("\"html_url\"\\s*:\\s*\"(https://github\\.com/[^\"]+/releases/tag/[^\"]+)\"").find(json)?.groupValues?.get(1)
        return Release(
            version = tag.trim().removePrefix("v"),
            notes = latestNotes(jsonString(json, "body").orEmpty()),
            page = page ?: RELEASES_PAGE,
            windowsZip = urls.firstOrNull { it.endsWith("/$WIN_ASSET") },
            jar = urls.firstOrNull { it.endsWith("/$JAR_ASSET") },
        )
    }

    /** JSON 에서 "key": "문자열" 값을 꺼낸다 (긴 문자열도 정규식 없이 한 글자씩) */
    fun jsonString(json: String, key: String): String? {
        val k = json.indexOf("\"$key\"")
        if (k < 0) return null
        var i = k + key.length + 2
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length || json[i] != ':') return null
        i++
        while (i < json.length && json[i].isWhitespace()) i++
        if (i >= json.length || json[i] != '"') return null
        val start = ++i
        while (i < json.length) {
            when (json[i]) {
                '\\' -> i += 2
                '"' -> return unescape(json.substring(start, i))
                else -> i++
            }
        }
        return null
    }

    private fun unescape(s: String): String {
        val out = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                when (val n = s[i + 1]) {
                    'n' -> out.append('\n')
                    'r' -> {}
                    't' -> out.append('\t')
                    'u' -> if (i + 5 < s.length) {
                        out.append(s.substring(i + 2, i + 6).toInt(16).toChar()); i += 4
                    }
                    else -> out.append(n)
                }
                i += 2
            } else {
                out.append(c); i++
            }
        }
        return out.toString()
    }

    /** 릴리스 설명에서 맨 위 '🆕' 항목만 평문으로 */
    fun latestNotes(body: String): String {
        val lines = body.lines()
        val start = lines.indexOfFirst { it.startsWith("### 🆕") }
        if (start < 0) return ""
        val out = mutableListOf<String>()
        for (i in start until lines.size) {
            val l = lines[i]
            if (i > start && (l.startsWith("### ") || l.startsWith("## "))) break
            out += l
        }
        return out.joinToString("\n")
            .replace(Regex("^### 🆕\\s*"), "")
            .replace(Regex("\\[([^\\]]+)]\\([^)]+\\)"), "$1")
            .replace("**", "").replace("`", "")
            .trim()
            .let { if (it.length > 700) it.take(700).trimEnd() + "…" else it }
    }

    fun browse(url: String) {
        runCatching { Desktop.getDesktop().browse(URI(url)) }
    }

    /** 파일 받기 (진행률 콜백: 받은 바이트, 전체 바이트) */
    fun download(url: String, to: Path, progress: (Long, Long) -> Unit) {
        val req = HttpRequest.newBuilder(URI(url)).header("User-Agent", "3DSound-PC")
            .timeout(Duration.ofMinutes(10)).GET().build()
        val res = http.send(req, HttpResponse.BodyHandlers.ofInputStream())
        if (res.statusCode() != 200) throw IllegalStateException("다운로드 응답 ${res.statusCode()}")
        val total = res.headers().firstValueAsLong("Content-Length").orElse(-1)
        res.body().use { input ->
            Files.newOutputStream(to).use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                var last = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    val now = System.currentTimeMillis()
                    if (now - last > 100) { last = now; progress(done, total) }
                }
                progress(done, total)
            }
        }
    }

    /** zip 풀기 (경로가 대상 폴더 밖으로 나가는 항목은 거부) */
    fun unzip(zip: Path, dir: Path) {
        val root = dir.toAbsolutePath().normalize()
        ZipInputStream(Files.newInputStream(zip)).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                val target = root.resolve(e.name.replace('\\', '/')).normalize()
                if (!target.startsWith(root)) throw IllegalStateException("잘못된 압축 파일")
                if (e.isDirectory) Files.createDirectories(target)
                else {
                    Files.createDirectories(target.parent)
                    Files.newOutputStream(target).use { z.copyTo(it) }
                }
            }
        }
    }

    /** 결과 표시용 파일 (스크립트가 실패하면 남김) */
    val resultFile: File get() = File(System.getProperty("java.io.tmpdir"), "3dsound-update-result.txt")

    /** 교체 스크립트 (PowerShell). 경로는 작은따옴표 문자열로 넣어 공백·한글·따옴표도 안전하게 */
    fun swapScript(pid: Long, newAppDir: File, exe: File, workDir: File, result: File): String {
        fun q(s: String) = "'" + s.replace("'", "''") + "'"
        val appDir = exe.parentFile
        return """
            ${'$'}ErrorActionPreference = 'SilentlyContinue'
            ${'$'}result = ${q(result.absolutePath)}
            for (${'$'}i = 0; ${'$'}i -lt 120; ${'$'}i++) {
              if (-not (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { break }
              Start-Sleep -Milliseconds 500
            }
            Start-Sleep -Milliseconds 700
            robocopy ${q(newAppDir.absolutePath)} ${q(appDir.absolutePath)} /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if (${'$'}LASTEXITCODE -ge 8) {
              Set-Content -LiteralPath ${'$'}result -Value "fail ${'$'}LASTEXITCODE" -Encoding UTF8
            } else {
              Set-Content -LiteralPath ${'$'}result -Value 'ok' -Encoding UTF8
            }
            Start-Process -FilePath ${q(exe.absolutePath)}
            Start-Sleep -Seconds 2
            Remove-Item -LiteralPath ${q(workDir.absolutePath)} -Recurse -Force
        """.trimIndent()
    }

    /**
     * Windows 앱 교체 스크립트를 실행한다. 이 함수가 끝나면 앱을 바로 종료해야 한다.
     * 스크립트: 이 프로세스가 끝나길 기다림 → 새 파일을 앱 폴더에 덮어쓰기 → 앱 다시 실행 → 임시 폴더 정리.
     */
    fun launchWindowsSwap(newAppDir: File, workDir: File) {
        val exe = appExe ?: throw IllegalStateException("Windows 앱이 아닙니다")
        val script = swapScript(ProcessHandle.current().pid(), newAppDir, exe, workDir, resultFile)
        val ps1 = File(workDir, "update.ps1")
        // Windows PowerShell 5.1 은 BOM 이 있어야 한글 경로를 UTF-8 로 읽는다
        ps1.writeBytes(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + script.replace("\n", "\r\n").toByteArray(Charsets.UTF_8))
        ProcessBuilder(
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1.absolutePath,
        ).directory(File(System.getProperty("java.io.tmpdir"))).start() // 지울 폴더 안에서 실행하면 지워지지 않으므로

    }
}
