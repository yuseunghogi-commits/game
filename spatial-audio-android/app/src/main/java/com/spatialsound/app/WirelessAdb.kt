package com.spatialsound.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.provider.Settings
import io.github.muntashirakon.adb.AbsAdbConnectionManager
import io.github.muntashirakon.adb.android.AdbMdns
import java.io.File
import java.io.IOException
import java.security.PrivateKey
import java.security.cert.Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 무선 디버깅으로 '이 폰 자신'의 ADB 에 접속해서, 이 앱에 DUMP 권한을 스스로 준다.
 * → Shizuku 같은 다른 앱이나 PC 가 필요 없다. 처음 1번만 페어링 코드(6자리)를 넣으면 끝.
 *
 * ADB 프로토콜(페어링 SPAKE2 + TLS, 셸 명령)은 libadb-android 라이브러리가 처리한다.
 */
object WirelessAdb {
    const val DEVICE_NAME = "3DSound"
    private const val HOST = "127.0.0.1"

    /** 무선 디버깅은 Android 11 부터 */
    fun supported() = Build.VERSION.SDK_INT >= 30

    fun developerOptionsOn(ctx: Context) =
        Settings.Global.getInt(ctx.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1

    fun wirelessDebuggingOn(ctx: Context) =
        Settings.Global.getInt(ctx.contentResolver, "adb_wifi_enabled", 0) == 1

    /** 무선 디버깅은 Wi-Fi 에 연결돼 있어야 켤 수 있다 (인터넷은 안 돼도 됨) */
    @Suppress("DEPRECATION")
    fun wifiConnected(ctx: Context): Boolean = runCatching {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
    }.getOrDefault(true)

    private class Manager(private val key: AdbKey) : AbsAdbConnectionManager() {
        init {
            setApi(Build.VERSION.SDK_INT)
            setTimeout(20, TimeUnit.SECONDS)
        }

        override fun getPrivateKey(): PrivateKey = key.privateKey
        override fun getCertificate(): Certificate = key.certificate
        override fun getDeviceName(): String = DEVICE_NAME
    }

    @Volatile
    private var manager: Manager? = null

    private fun manager(ctx: Context): Manager =
        manager ?: synchronized(this) {
            manager ?: Manager(AdbKey.loadOrCreate(File(ctx.noBackupFilesDir, "adb"))).also { manager = it }
        }

    /** 함께 넣은 Conscrypt 가 안 되면 시스템 Conscrypt(숨김 API)로 대신 하도록 접근을 연다 */
    private fun allowSystemTls() {
        if (Build.VERSION.SDK_INT >= 28) runCatching {
            org.lsposed.hiddenapibypass.HiddenApiBypass.addHiddenApiExemptions("L")
        }
    }

    /** '페어링 코드로 기기 페어링' 화면의 6자리 코드로 페어링. 실패하면 예외. (작업 스레드에서) */
    fun pair(ctx: Context, port: Int, code: String) {
        allowSystemTls()
        manager(ctx).pair(HOST, port, code)
    }

    /**
     * 무선 디버깅 연결 포트를 찾아 접속한 뒤 셸 명령을 실행하고 출력을 돌려준다. (작업 스레드에서)
     */
    fun shell(ctx: Context, cmd: String, timeoutMs: Long = 15_000): String {
        allowSystemTls()
        val m = manager(ctx)
        if (!m.isConnected) {
            val port = discover(ctx, AdbMdns.SERVICE_TYPE_TLS_CONNECT, timeoutMs)
            if (port <= 0) throw IOException("무선 디버깅 연결 포트를 찾지 못했습니다 (무선 디버깅이 켜져 있나요?)")
            if (!m.connect(HOST, port) && !m.isConnected) throw IOException("ADB 연결 실패")
        }
        val stream = m.openStream("shell:$cmd")
        // 명령이 끝나지 않는 경우를 대비해 시간이 지나면 스트림을 닫아 읽기를 풀어 준다
        val watchdog = Thread {
            try {
                Thread.sleep(timeoutMs)
                runCatching { stream.close() }
            } catch (_: InterruptedException) {
            }
        }.apply { isDaemon = true; start() }
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(4096)
        try {
            while (true) {
                val n = stream.read(buf, 0, buf.size)
                if (n < 0) break
                out.write(buf, 0, n)
            }
        } catch (_: IOException) {
            // 상대가 스트림을 닫으면 여기로 온다 (정상 종료)
        } finally {
            watchdog.interrupt()
            runCatching { stream.close() }
        }
        return out.toString("UTF-8").trim()
    }

    fun disconnect() {
        runCatching { manager?.disconnect() }
    }

    /** mDNS 로 이 폰의 무선 디버깅 서비스 포트를 찾는다 (못 찾으면 -1) */
    fun discover(ctx: Context, type: String, timeoutMs: Long): Int {
        val port = AtomicInteger(-1)
        val found = CountDownLatch(1)
        val mdns = AdbMdns(ctx, type) { host, p ->
            if (host != null && p > 0) {
                port.set(p)
                found.countDown()
            }
        }
        mdns.start()
        try {
            found.await(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
            mdns.stop()
        }
        return port.get()
    }
}
