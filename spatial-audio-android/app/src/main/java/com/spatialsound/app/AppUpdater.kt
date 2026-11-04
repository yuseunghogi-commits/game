package com.spatialsound.app

import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.widget.ProgressBar
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * 앱 자동 업데이트.
 *
 * 앱을 열 때(6시간에 한 번) GitHub 의 최신 릴리스를 확인하고, 새 버전이면 바로 받아서 설치 창을 띄운다.
 * 설치는 Android 가 마지막에 '업데이트' 한 번만 물어본다 (휴대폰 정책상 몰래 설치는 불가).
 * 서명이 다른 APK 는 덮어쓰기가 안 되므로 받기 전에 확인해서 안내한다.
 */
object AppUpdater {
    private const val TAG = "AppUpdater"
    const val REPO = "yuseunghogi-commits/game"
    private const val LATEST_API = "https://api.github.com/repos/$REPO/releases/latest"
    const val RELEASES_PAGE = "https://github.com/$REPO/releases/latest"
    private const val APK_ASSET = "3DSound-Android.apk"
    private const val PREFS = "updater"
    private const val CHECK_EVERY_MS = 6 * 3600_000L
    const val ACTION_INSTALL_STATUS = "com.spatialsound.app.INSTALL_STATUS"
    private const val CH_UPDATE = "app_update"
    const val NID_UPDATE = 41
    /** '업데이트 완료' 안내 — 설치 결과(성공)가 늦게 와서 NID_UPDATE 를 지워도 남도록 따로 */
    const val NID_UPDATED = 42

    data class Release(
        val version: String,
        val notes: String,
        val apkUrl: String,
        val apkSize: Long,
        val page: String,
    )

    @Volatile
    private var busy = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun autoCheckEnabled(ctx: Context) = prefs(ctx).getBoolean("auto", true)

    fun setAutoCheck(ctx: Context, on: Boolean) = prefs(ctx).edit().putBoolean("auto", on).apply()

    fun currentVersion(ctx: Context): String = runCatching {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
    }.getOrNull() ?: "0"

    /** "2.10" > "2.9", "v2.0" == "2.0" */
    fun isNewer(remote: String, local: String): Boolean {
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

    /** 화면이 열릴 때: 자동 확인이 켜져 있고 마지막 확인 뒤 6시간이 지났으면 조용히 확인 */
    fun maybeCheck(activity: Activity) {
        if (!autoCheckEnabled(activity)) return
        val last = prefs(activity).getLong("lastCheck", 0)
        if (System.currentTimeMillis() - last < CHECK_EVERY_MS) return
        check(activity, manual = false)
    }

    /** 업데이트 확인. manual=true 면 '최신 버전' 같은 결과도 알려 준다 */
    fun check(activity: Activity, manual: Boolean) {
        if (busy) return
        busy = true
        val app = activity.applicationContext
        if (manual) Toast.makeText(activity, "업데이트 확인 중…", Toast.LENGTH_SHORT).show()
        Thread {
            val res = runCatching { fetchLatest() }
            res.exceptionOrNull()?.let { Log.w(TAG, "업데이트 확인 실패", it) }
            if (res.isSuccess) prefs(app).edit().putLong("lastCheck", System.currentTimeMillis()).apply()
            activity.runOnUiThread {
                busy = false
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                val rel = res.getOrNull()
                val cur = currentVersion(app)
                when {
                    rel == null -> if (manual) Toast.makeText(
                        activity, "업데이트 확인 실패 — 인터넷 연결을 확인하세요", Toast.LENGTH_LONG,
                    ).show()
                    !isNewer(rel.version, cur) -> if (manual) Toast.makeText(
                        activity, "최신 버전입니다 (v$cur)", Toast.LENGTH_SHORT,
                    ).show()
                    !manual && prefs(app).getString("skip", "") == rel.version -> {}
                    else -> offer(activity, rel, cur)
                }
            }
        }.start()
    }

    private fun offer(activity: Activity, rel: Release, cur: String) {
        val size = if (rel.apkSize > 0) " (%.1f MB)".format(rel.apkSize / 1048576.0) else ""
        AlertDialog.Builder(activity)
            .setTitle("새 버전 v${rel.version} 이 나왔어요")
            .setMessage(
                "현재 v$cur → v${rel.version}$size\n\n" +
                    rel.notes.ifBlank { "변경 사항은 릴리스 페이지에서 볼 수 있습니다." } +
                    "\n\n설정과 권한은 그대로 유지됩니다."
            )
            .setPositiveButton("지금 업데이트") { _, _ -> startUpdate(activity, rel) }
            .setNeutralButton("이 버전 건너뛰기") { _, _ ->
                prefs(activity).edit().putString("skip", rel.version).apply()
            }
            .setNegativeButton("나중에", null)
            .show()
    }

    private fun startUpdate(activity: Activity, rel: Release) {
        // 처음 한 번: 이 앱이 업데이트 파일을 설치할 수 있게 허용
        if (!activity.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(activity)
                .setTitle("설치 허용 (처음 1번)")
                .setMessage(
                    "업데이트를 설치하려면 이 앱에 '출처를 알 수 없는 앱 설치' 허용이 필요합니다.\n\n" +
                        "다음 화면에서 '이 출처 허용'을 켠 뒤 뒤로 돌아오면 업데이트가 이어집니다."
                )
                .setPositiveButton("설정 열기") { _, _ ->
                    pendingRelease = rel
                    runCatching {
                        activity.startActivity(
                            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                        )
                    }
                }
                .setNegativeButton("취소", null)
                .show()
            return
        }
        download(activity, rel)
    }

    /** '설치 허용' 설정에서 돌아왔을 때 이어서 진행 */
    @Volatile
    private var pendingRelease: Release? = null

    fun resumePending(activity: Activity) {
        val rel = pendingRelease ?: return
        if (!activity.packageManager.canRequestPackageInstalls()) return
        pendingRelease = null
        download(activity, rel)
    }

    private fun download(activity: Activity, rel: Release) {
        if (busy) return
        busy = true
        val app = activity.applicationContext
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            setPadding(48, 24, 48, 0)
        }
        val dlg = AlertDialog.Builder(activity)
            .setTitle("v${rel.version} 받는 중…")
            .setView(bar)
            .setCancelable(false)
            .show()
        Thread {
            val res = runCatching {
                val f = fetchApk(app, rel) { done, total ->
                    if (total > 0) activity.runOnUiThread { bar.progress = (done * 1000 / total).toInt() }
                }
                checkApk(app, f)
                f
            }
            activity.runOnUiThread {
                busy = false
                runCatching { dlg.dismiss() }
                val apk = res.getOrNull()
                if (apk != null) {
                    runCatching { install(app, apk) }.onFailure {
                        Log.e(TAG, "설치 시작 실패", it)
                        failDialog(activity, rel, "설치를 시작하지 못했습니다: ${it.message}")
                    }
                } else {
                    val e = res.exceptionOrNull()
                    Log.w(TAG, "업데이트 받기 실패", e)
                    failDialog(activity, rel, e?.message ?: "알 수 없는 오류")
                }
            }
        }.start()
    }

    private fun failDialog(activity: Activity, rel: Release, msg: String) {
        if (activity.isFinishing || activity.isDestroyed) return
        AlertDialog.Builder(activity)
            .setTitle("업데이트 실패")
            .setMessage("$msg\n\n릴리스 페이지에서 직접 받아 설치할 수도 있습니다.")
            .setPositiveButton("릴리스 페이지 열기") { _, _ -> openPage(activity, rel.page) }
            .setNegativeButton("닫기", null)
            .show()
    }

    fun openPage(ctx: Context, url: String = RELEASES_PAGE) {
        runCatching {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    // --- 네트워크 ----------------------------------------------------------

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "3DSound-Android")
        }

    fun fetchLatest(): Release {
        val c = open(LATEST_API)
        c.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (c.responseCode != 200) throw IOException("서버 응답 ${c.responseCode}")
            val json = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val tag = json.getString("tag_name").trim().removePrefix("v")
            val assets = json.optJSONArray("assets")
            var url = ""
            var size = 0L
            if (assets != null) for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.optString("name") == APK_ASSET) {
                    url = a.optString("browser_download_url")
                    size = a.optLong("size")
                }
            }
            if (url.isEmpty()) throw IOException("릴리스에 APK 가 없습니다")
            return Release(tag, latestNotes(json.optString("body")), url, size, json.optString("html_url", RELEASES_PAGE))
        } finally {
            c.disconnect()
        }
    }

    /** 릴리스 설명(마크다운)에서 맨 위 '🆕' 항목만 골라 평문으로 */
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
            .replace("**", "")
            .replace("`", "")
            .trim()
            .let { if (it.length > 900) it.take(900).trimEnd() + "…" else it }
    }

    private fun fetchApk(ctx: Context, rel: Release, progress: (Long, Long) -> Unit): File {
        val dir = File(ctx.cacheDir, "update").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // 예전에 받다 만 파일 정리
        val out = File(dir, "3DSound-${rel.version}.apk")
        val c = open(rel.apkUrl)
        try {
            if (c.responseCode != 200) throw IOException("다운로드 응답 ${c.responseCode}")
            val total = if (c.contentLengthLong > 0) c.contentLengthLong else rel.apkSize
            var done = 0L
            var lastTick = 0L
            c.inputStream.use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - lastTick > 100) { lastTick = now; progress(done, total) }
                    }
                }
            }
            progress(done, total)
            if (rel.apkSize > 0 && out.length() != rel.apkSize) throw IOException("받은 파일 크기가 맞지 않습니다")
        } finally {
            c.disconnect()
        }
        return out
    }

    // --- 확인 / 설치 --------------------------------------------------------

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo?): Set<String> {
        if (info == null) return emptySet()
        val sigs = if (Build.VERSION.SDK_INT >= 28) {
            info.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory }
        } else info.signatures
        return sigs.orEmpty().map { it.toCharsString() }.toSet()
    }

    /** 받은 APK 가 이 앱의 새 버전이고 같은 키로 서명됐는지 확인 (아니면 덮어쓰기 설치가 안 됨) */
    @Suppress("DEPRECATION")
    private fun checkApk(ctx: Context, apk: File) {
        val pm = ctx.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val newInfo = pm.getPackageArchiveInfo(apk.absolutePath, flags)
            ?: throw IOException("받은 파일이 올바른 APK 가 아닙니다")
        if (newInfo.packageName != ctx.packageName) throw IOException("다른 앱의 파일입니다")
        val mine = signers(pm.getPackageInfo(ctx.packageName, flags))
        val theirs = signers(newInfo)
        if (mine.isNotEmpty() && theirs.isNotEmpty() && mine.intersect(theirs).isEmpty()) {
            throw IOException(
                "새 버전의 서명 키가 달라서 덮어쓰기 업데이트가 안 됩니다.\n" +
                    "이 앱을 지운 뒤 새로 설치해 주세요 (강력 모드 권한은 다시 1번 받아야 합니다)"
            )
        }
    }

    private fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            setSize(apk.length())
            // 가능하면 확인 창 없이 (Android 12+, 이 앱이 설치한 앱일 때만 적용됨)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out, 64 * 1024) }
                s.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pi = PendingIntent.getBroadcast(
                ctx, id,
                Intent(ctx, UpdateReceiver::class.java).setAction(ACTION_INSTALL_STATUS),
                flags,
            )
            s.commit(pi.intentSender)
        }
    }

    // --- 알림 (설치 상태) ----------------------------------------------------

    fun notify(ctx: Context, title: String, text: String, intent: PendingIntent?, id: Int = NID_UPDATE) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CH_UPDATE) == null) {
            nm.createNotificationChannel(NotificationChannel(CH_UPDATE, "앱 업데이트", NotificationManager.IMPORTANCE_HIGH))
        }
        val b = Notification.Builder(ctx, CH_UPDATE)
            .setSmallIcon(R.drawable.ic_headphones)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
        if (intent != null) b.setContentIntent(intent)
        nm.notify(id, b.build())
    }
}
