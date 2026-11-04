package com.spatialsound.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import io.github.muntashirakon.adb.android.AdbMdns
import java.util.concurrent.Executors

/**
 * 무선 디버깅 페어링을 도와주는 서비스 (앱 하나로 권한 받기).
 *
 * 1) 설정 → 개발자 옵션 → 무선 디버깅 → '페어링 코드로 기기 페어링' 화면이 열리면 mDNS 로 그 포트를 찾고
 * 2) 알림에 '코드 입력' 칸을 띄운다 (설정 화면을 떠나면 페어링 창이 닫히므로 알림에서 입력)
 * 3) 코드가 들어오면 페어링 → 무선 디버깅으로 접속 → `pm grant <앱> android.permission.DUMP`
 * 4) 무선 디버깅을 이 과정 때문에 켠 경우라면 다시 꺼 준다
 */
class AdbPairService : Service() {

    companion object {
        private const val TAG = "AdbPairService"
        private const val ACTION_CODE = "com.spatialsound.app.PAIR_CODE"
        private const val ACTION_STOP = "com.spatialsound.app.PAIR_STOP"
        private const val KEY_CODE = "pairing_code"
        private const val CH_WAIT = "adb_pair_wait"
        private const val CH_INPUT = "adb_pair_input"
        private const val NID_WAIT = 31
        private const val NID_INPUT = 32
        /** 이 시간 안에 끝내지 못하면 알아서 종료 */
        private const val GIVE_UP_MS = 15 * 60_000L
        private const val PREFS = "adb_pair"
        /** 무선 디버깅이 꺼져 있던 것을 본 시각 — 실패 후 다시 시도해도(새 서비스) 끝나면 꺼 주려고 기억 */
        private const val KEY_WE_ENABLED = "wifiDebugOffSeenAt"
        private const val WE_ENABLED_VALID_MS = 24 * 3600_000L

        @Volatile
        var running = false
            private set

        /** 액티비티(화면이 보이는 상태)에서 호출 */
        fun start(ctx: Context) {
            ctx.startService(Intent(ctx, AdbPairService::class.java))
        }

        fun stop(ctx: Context) {
            if (running) ctx.startService(Intent(ctx, AdbPairService::class.java).setAction(ACTION_STOP))
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var mdns: AdbMdns? = null
    private var pairPort = -1
    private var busy = false
    private var done = false
    /** 이 과정(또는 하루 안의 이전 시도) 때문에 무선 디버깅을 켰으면, 끝나고 다시 꺼 준다 */
    @Volatile
    private var turnOffAfter = false
    /** 실제로 꺼졌는지 (끈 뒤 확인) */
    @Volatile
    private var turnedOff = false
    private val giveUp = Runnable { finish(removeNotifications = true) }

    private val nm get() = getSystemService(NotificationManager::class.java)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannels()
        when (intent?.action) {
            ACTION_STOP -> {
                finish(removeNotifications = true)
                return START_NOT_STICKY
            }
            ACTION_CODE -> {
                if (!running) begin()
                val code = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_CODE)?.toString()
                onCode(code)
            }
            else -> begin()
        }
        return START_NOT_STICKY
    }

    private fun begin() {
        if (running) {
            // 이미 기다리는 중 → 안내만 다시
            if (pairPort > 0 && !busy) postInput("6자리 페어링 코드를 입력하세요", withInput = true, alert = true)
            return
        }
        running = true
        done = false
        turnedOff = false
        // 지금 꺼져 있으면 기억해 둔다. 첫 시도가 실패해서 무선 디버깅이 켜진 채로 다시 시도해도,
        // 그 기억으로 끝나고 다시 꺼 준다 (서비스는 시도마다 새로 만들어지므로 저장해 둠)
        val p = getSharedPreferences(PREFS, MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!WirelessAdb.wirelessDebuggingOn(this)) p.edit().putLong(KEY_WE_ENABLED, now).apply()
        val seen = p.getLong(KEY_WE_ENABLED, 0L)
        turnOffAfter = seen > 0 && now - seen in 0 until WE_ENABLED_VALID_MS
        val wait = waitNotification("설정 → 개발자 옵션 → 무선 디버깅 → '페어링 코드로 기기 페어링'을 누르세요")
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NID_WAIT, wait, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            } else {
                startForeground(NID_WAIT, wait)
            }
        } catch (t: Throwable) {
            // 포그라운드가 안 돼도 화면 전환 몇 분 동안은 대부분 살아 있으므로 계속 진행
            Log.w(TAG, "startForeground 실패", t)
            nm.notify(NID_WAIT, wait)
        }
        mdns = AdbMdns(this, AdbMdns.SERVICE_TYPE_TLS_PAIRING) { _, port ->
            main.post { onPairPort(port) }
        }.also { it.start() }
        main.postDelayed(giveUp, GIVE_UP_MS)
    }

    /** 페어링 창이 열리면 포트 > 0, 닫히면 -1 */
    private fun onPairPort(port: Int) {
        if (!running || done) return
        if (busy) {
            // 페어링하는 동안에도 새 창(새 포트)은 기억해 둔다
            pairPort = port
            return
        }
        if (port > 0) {
            val first = pairPort <= 0
            pairPort = port
            if (first) postInput("6자리 페어링 코드를 입력하세요 (설정 화면은 그대로 두고)", withInput = true, alert = true)
            updateWait("페어링 코드 입력을 기다리는 중")
        } else {
            pairPort = -1
            nm.cancel(NID_INPUT)
            updateWait("설정 → 개발자 옵션 → 무선 디버깅 → '페어링 코드로 기기 페어링'을 누르세요")
        }
    }

    private fun onCode(raw: String?) {
        if (done) return
        val code = raw.orEmpty().filter { it.isDigit() }
        if (busy) return
        if (code.length != 6) {
            postInput("6자리 숫자를 입력하세요", withInput = true, alert = false)
            return
        }
        // 포트를 아직 못 찾았으면 잠깐 찾아본다 (알림을 빨리 누른 경우)
        busy = true
        postInput("페어링 중…", withInput = false, alert = false)
        val knownPort = pairPort
        worker.execute {
            val port = if (knownPort > 0) knownPort
            else WirelessAdb.discover(this, AdbMdns.SERVICE_TYPE_TLS_PAIRING, 5000)
            if (port <= 0) {
                main.post {
                    busy = false
                    if (!running) return@post
                    postInput(
                        "페어링 창이 보이지 않아요. 설정에서 '페어링 코드로 기기 페어링'을 다시 누르고 새 코드를 입력하세요",
                        withInput = true, alert = true,
                    )
                }
                return@execute
            }
            val pairErr = runCatching { WirelessAdb.pair(this, port, code) }.exceptionOrNull()
            if (pairErr != null) {
                Log.w(TAG, "페어링 실패", pairErr)
                main.post {
                    busy = false
                    // 창이 닫혔는데 mDNS 가 '사라짐'을 놓쳤으면 옛 포트로만 계속 시도하게 되므로,
                    // 다음 코드는 포트를 다시 찾아서 (창이 그대로면 바로 다시 찾음)
                    pairPort = -1
                    if (!running) return@post
                    postInput(
                        "페어링 실패 — 코드를 다시 확인하세요. 창이 닫혔다면 '페어링 코드로 기기 페어링'을 다시 눌러 새 코드로",
                        withInput = true, alert = true,
                    )
                }
                return@execute
            }
            main.post { if (running) postInput("페어링 성공! 권한 받는 중…", withInput = false, alert = false) }
            val result = runCatching { grantDump() }
            main.post {
                busy = false
                if (!running) return@post
                val ok = result.getOrNull() == true
                if (ok) onSuccess() else onGrantFailed(result.exceptionOrNull()?.message)
            }
        }
    }

    /** 무선 디버깅으로 접속해서 DUMP 권한 부여. 성공하면 true (작업 스레드) */
    private fun grantDump(): Boolean {
        var ok = false
        // 페어링 직후에는 연결 서비스가 늦게 잡힐 수 있어서 몇 번 시도
        var lastErr: Throwable? = null
        for (attempt in 0 until 3) {
            try {
                val out = WirelessAdb.shell(this, "pm grant $packageName ${Manifest.permission.DUMP}")
                if (out.isNotEmpty()) Log.i(TAG, "pm grant: $out")
                ok = waitForDump()
                break
            } catch (t: Throwable) {
                lastErr = t
                Log.w(TAG, "권한 부여 시도 ${attempt + 1} 실패", t)
                WirelessAdb.disconnect()
                Thread.sleep(1500)
            }
        }
        if (ok) {
            if (turnOffAfter) {
                // 이 과정 때문에 켠 무선 디버깅은 다시 꺼 둔다 (권한은 그대로 유지됨)
                runCatching { WirelessAdb.shell(this, "settings put global adb_wifi_enabled 0", 4000) }
                turnedOff = waitWirelessOff()
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_WE_ENABLED).apply()
        }
        WirelessAdb.disconnect()
        if (!ok && lastErr != null) throw lastErr
        return ok
    }

    private fun waitWirelessOff(): Boolean {
        repeat(15) {
            if (!WirelessAdb.wirelessDebuggingOn(this)) return true
            Thread.sleep(200)
        }
        return false
    }

    private fun waitForDump(): Boolean {
        repeat(10) {
            if (checkSelfPermission(Manifest.permission.DUMP) == PackageManager.PERMISSION_GRANTED) return true
            Thread.sleep(200)
        }
        return false
    }

    private fun onSuccess() {
        done = true
        val off = when {
            !turnOffAfter -> ""
            turnedOff -> "\n무선 디버깅은 다시 꺼 두었습니다 (앞으로 필요 없음)."
            else -> "\n무선 디버깅이 아직 켜져 있으면 설정 → 개발자 옵션에서 꺼 주세요 (앞으로 필요 없음)."
        }
        val n = Notification.Builder(this, CH_INPUT)
            .setSmallIcon(R.drawable.ic_headphones)
            .setContentTitle("✅ 권한 받기 완료!")
            .setContentText("눌러서 3D 사운드로 돌아가기")
            .setStyle(Notification.BigTextStyle().bigText("이제 강력 3D 모드를 쓸 수 있습니다. 눌러서 앱으로 돌아가 '3D 음향 켜기'를 누르세요.$off"))
            .setContentIntent(openAppIntent())
            .setAutoCancel(true)
            .build()
        nm.notify(NID_INPUT, n)
        finish(removeNotifications = false)
    }

    private fun onGrantFailed(msg: String?) {
        done = true
        val n = Notification.Builder(this, CH_INPUT)
            .setSmallIcon(R.drawable.ic_headphones)
            .setContentTitle("권한 받기 실패")
            .setContentText("앱을 열어 다시 시도하거나 'PC로 하기'를 써 주세요")
            .setStyle(Notification.BigTextStyle().bigText(
                "페어링은 됐지만 권한을 받지 못했습니다${if (msg.isNullOrBlank()) "" else " ($msg)"}.\n" +
                    "무선 디버깅이 켜져 있는지 확인하고 앱에서 다시 시도해 주세요."
            ))
            .setContentIntent(openAppIntent())
            .setAutoCancel(true)
            .build()
        nm.notify(NID_INPUT, n)
        finish(removeNotifications = false)
    }

    private fun finish(removeNotifications: Boolean) {
        main.removeCallbacks(giveUp)
        runCatching { mdns?.stop() }
        mdns = null
        running = false
        pairPort = -1
        if (removeNotifications) nm.cancel(NID_INPUT)
        stopForeground(STOP_FOREGROUND_REMOVE)
        nm.cancel(NID_WAIT)
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacks(giveUp)
        runCatching { mdns?.stop() }
        running = false
        worker.shutdown()
        super.onDestroy()
    }

    // --- 알림 -------------------------------------------------------------

    private fun ensureChannels() {
        if (nm.getNotificationChannel(CH_WAIT) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CH_WAIT, "권한 설정 진행 상태", NotificationManager.IMPORTANCE_LOW)
            )
        }
        if (nm.getNotificationChannel(CH_INPUT) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CH_INPUT, "페어링 코드 입력", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "무선 디버깅 페어링 코드를 입력하는 알림"
                }
            )
        }
    }

    private fun icon(): Icon = Icon.createWithResource(this, R.drawable.ic_headphones)

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun stopIntent(): PendingIntent = PendingIntent.getService(
        this, 2, Intent(this, AdbPairService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun waitNotification(text: String): Notification =
        Notification.Builder(this, CH_WAIT)
            .setSmallIcon(R.drawable.ic_headphones)
            .setContentTitle("3D 사운드 권한 설정 중")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setContentIntent(openAppIntent())
            .addAction(Notification.Action.Builder(icon(), "취소", stopIntent()).build())
            .build()

    private fun updateWait(text: String) {
        if (running) nm.notify(NID_WAIT, waitNotification(text))
    }

    private fun postInput(text: String, withInput: Boolean, alert: Boolean) {
        val b = Notification.Builder(this, CH_INPUT)
            .setSmallIcon(R.drawable.ic_headphones)
            .setContentTitle("무선 디버깅 페어링 코드")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(!alert)
            .setCategory(Notification.CATEGORY_STATUS)
            .setOngoing(true)
        if (withInput) {
            val remote = RemoteInput.Builder(KEY_CODE).setLabel("6자리 코드").build()
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pi = PendingIntent.getService(
                this, 1, Intent(this, AdbPairService::class.java).setAction(ACTION_CODE), flags,
            )
            b.addAction(
                Notification.Action.Builder(icon(), "코드 입력", pi)
                    .addRemoteInput(remote)
                    .build()
            )
        }
        b.addAction(Notification.Action.Builder(icon(), "취소", stopIntent()).build())
        nm.notify(NID_INPUT, b.build())
    }
}
