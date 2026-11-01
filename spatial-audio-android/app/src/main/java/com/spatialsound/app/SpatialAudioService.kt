package com.spatialsound.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.AudioEffect
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * 백그라운드에서 계속 3D 음향을 유지하는 포그라운드 서비스.
 *
 * 적용 방식 두 가지를 동시에 사용한다.
 *  1) 전체 출력(세션 0) — 유튜브, 넷플릭스, 브라우저 등 모든 앱
 *  2) 앱별 세션 — 스포티파이·삼성뮤직·Poweramp 등 "오디오 이펙트 세션"을 알려주는 앱
 *     (이 경우 잔향(리버브)까지 적용 가능)
 */
class SpatialAudioService : Service() {

    private lateinit var audioManager: AudioManager
    private val handler = Handler(Looper.getMainLooper())

    private var globalEngine: SpatialEngine? = null
    private val sessionEngines = mutableMapOf<Int, SpatialEngine>()
    private val sessionPackages = mutableMapOf<Int, String>()

    private var settings = SpatialSettings()
    private var headphones = false
    private var headphoneName = ""

    private val sessionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val session = intent.getIntExtra(AudioEffect.EXTRA_AUDIO_SESSION, AudioManager.ERROR)
            if (session == AudioManager.ERROR || session == 0) return
            val pkg = intent.getStringExtra(AudioEffect.EXTRA_PACKAGE_NAME) ?: "?"
            when (intent.action) {
                AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION -> openSession(session, pkg)
                AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION -> closeSession(session)
            }
        }
    }

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refreshDevices()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refreshDevices()
    }

    /** 다른 이퀄라이저 앱이 제어권을 뺏어갔는지 주기적으로 확인하고 되찾는다. */
    private val watchdog = object : Runnable {
        override fun run() {
            val g = globalEngine
            if (settings.globalMode && g != null && !g.hasControl()) {
                Log.i(TAG, "세션 0 제어권을 잃음 → 다시 연결")
                rebuildGlobal()
            }
            publishState()
            handler.postDelayed(this, WATCHDOG_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        createChannel()
        startInForeground()

        val filter = IntentFilter().apply {
            addAction(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION)
            addAction(AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(sessionReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(sessionReceiver, filter)
        }
        audioManager.registerAudioDeviceCallback(deviceCallback, handler)

        settings = SpatialSettings.load(this)
        refreshDevices()
        rebuildGlobal()
        handler.postDelayed(watchdog, WATCHDOG_MS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                SpatialSettings.load(this).copy(enabled = false).save(this)
                SpatialTileService.requestUpdate(this)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> reloadSettings()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        runCatching { unregisterReceiver(sessionReceiver) }
        runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
        globalEngine?.release(); globalEngine = null
        sessionEngines.values.forEach { it.release() }
        sessionEngines.clear()
        sessionPackages.clear()
        EngineState.update { EngineState.Snapshot(running = false) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------------------------------------------------------------------

    private fun reloadSettings() {
        val old = settings
        settings = SpatialSettings.load(this)
        if (old.globalMode != settings.globalMode || globalEngine == null) rebuildGlobal()
        applyAll()
        updateNotification()
    }

    private fun rebuildGlobal() {
        globalEngine?.release()
        globalEngine = null
        if (settings.globalMode) {
            val e = SpatialEngine(0)
            if (e.open()) globalEngine = e else e.release()
        }
        applyAll()
    }

    private fun openSession(session: Int, pkg: String) {
        if (sessionEngines.containsKey(session)) return
        val e = SpatialEngine(session)
        if (e.open()) {
            sessionEngines[session] = e
            sessionPackages[session] = pkg
            Log.i(TAG, "세션 연결: $session ($pkg)")
            applyAll()
        } else {
            e.release()
        }
    }

    private fun closeSession(session: Int) {
        sessionEngines.remove(session)?.release()
        sessionPackages.remove(session)
        publishState()
    }

    private fun isActive(): Boolean = settings.enabled && (!settings.headphonesOnly || headphones)

    private fun applyAll() {
        val active = isActive()
        // 전체 출력(세션 0)에 3D 처리가 걸려 있으면 앱별 세션에는 잔향만 추가해서
        // 가상 서라운드가 두 번 걸려 소리가 뭉개지는 것을 막는다.
        val globalWorks = globalEngine?.isOpen == true
        globalEngine?.apply(settings, active, headphones)
        sessionEngines.values.forEach { it.apply(settings, active, headphones, reverbOnly = globalWorks) }
        publishState()
    }

    private fun refreshDevices() {
        val outs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val hp = outs.firstOrNull { it.type in HEADPHONE_TYPES }
        val changed = (hp != null) != headphones
        headphones = hp != null
        headphoneName = hp?.productName?.toString().orEmpty()
        if (changed) {
            applyAll()
            updateNotification()
        } else {
            publishState()
        }
    }

    private fun publishState() {
        val g = globalEngine
        EngineState.update {
            it.copy(
                running = true,
                headphones = headphones,
                headphoneName = headphoneName,
                globalOk = g?.isOpen == true,
                globalVirtualizerOk = g?.virtualizerOk == true,
                globalHasControl = g?.hasControl() ?: true,
                sessions = sessionPackages.toMap(),
            )
        }
    }

    // --- 알림 ---------------------------------------------------------------

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL_ID, "3D 사운드 실행 중", NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, SpatialAudioService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val preset = SOUND_PRESETS.getOrNull(settings.presetIndex)?.name ?: ""
        val text = when {
            !settings.enabled -> "꺼짐"
            isActive() -> "적용 중 · $preset"
            else -> "헤드폰을 연결하면 적용됩니다"
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_headphones)
            .setContentTitle("3D 사운드")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "끄기", stop).build())
            .build()
    }

    private fun startInForeground() {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun updateNotification() {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    companion object {
        private const val TAG = "SpatialAudioService"
        private const val CHANNEL_ID = "spatial_audio"
        private const val NOTIFICATION_ID = 3001
        private const val WATCHDOG_MS = 5_000L
        const val ACTION_STOP = "com.spatialsound.app.STOP"

        private val HEADPHONE_TYPES = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            26, // TYPE_BLE_HEADSET (API 31)
        )

        /** 설정을 저장한 뒤 호출하면 서비스가 켜지거나 갱신/종료된다. */
        fun sync(context: Context) {
            val s = SpatialSettings.load(context)
            val intent = Intent(context, SpatialAudioService::class.java)
            if (s.enabled) {
                context.startForegroundService(intent)
            } else {
                context.stopService(intent)
            }
        }
    }
}
