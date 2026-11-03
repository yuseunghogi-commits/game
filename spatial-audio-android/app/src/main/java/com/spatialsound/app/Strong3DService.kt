package com.spatialsound.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log

/**
 * 강력 3D 모드 (Android 10+).
 *
 *   다른 앱 소리 ──(내부 오디오 캡처)──▶ BinauralProcessor ──▶ AudioTrack ──▶ 블루투스/유선 헤드폰
 *        └── 원래 소리는 SessionMuter 가 음소거
 *
 * 폰 내장 3D 이펙트에 의존하지 않고 직접 계산하므로 어떤 폰·블루투스 이어폰에서도 효과가 확실하다.
 */
@android.annotation.TargetApi(29)
class Strong3DService : Service() {

    private lateinit var audioManager: AudioManager
    private val main = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var worker: Thread? = null
    @Volatile private var record: AudioRecord? = null
    @Volatile private var running = false

    private var muterThread: HandlerThread? = null
    private var muterHandler: Handler? = null
    private var muter: SessionMuter? = null

    private var processor: BinauralProcessor? = null
    private var headTracker: HeadTracker? = null
    private var headTick = 0

    /** 센서 각도를 오디오 엔진에 계속 전달 (50Hz) */
    private val headPump = object : Runnable {
        override fun run() {
            val t = headTracker ?: return
            processor?.headYawDeg = t.yawDeg
            // 화면 표시는 10Hz 면 충분
            if (++headTick % 5 == 0) EngineState.update { it.copy(headYaw = t.yawDeg) }
            main.postDelayed(this, 20)
        }
    }

    private fun updateHeadTracking() {
        if (settings.headTracking) {
            val t = headTracker ?: HeadTracker(this, main) { publishState() }.also {
                headTracker = it
                it.start()
                main.post(headPump)
            }
            t.invert = settings.headInvert
        } else {
            headTracker?.stop()
            headTracker = null
            main.removeCallbacks(headPump)
            processor?.headYawDeg = 0.0
        }
        publishState()
    }

    fun recenterHead() {
        headTracker?.recenter()
    }
    private var settings = SpatialSettings()
    private var headphones = false
    private var headphoneName = ""

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refreshDevices()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refreshDevices()
    }

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "화면/오디오 공유가 중지됨")
            main.post { stopSelf() }
        }
    }

    // --- "처음 소리가 두 번 들림" 방지 ---------------------------------------
    //  새 재생이 시작되면 원래 소리가 음소거될 때까지 처리된 소리를 잠깐 멈춘다(hold).
    //  그 사이에는 원래 소리만 들리고, 음소거되는 순간 3D 소리로 부드럽게 넘어간다.
    @Volatile private var hold = false
    private var holdDeadline = 0L
    private var lastMediaPlayers = 0

    private fun pollNow() {
        val m = muter ?: return
        if (!running) return
        val allMuted = runCatching { m.poll() }.getOrDefault(false)
        if (hold && (allMuted || android.os.SystemClock.uptimeMillis() > holdDeadline)) hold = false
        publishState()
    }

    private val periodicPoll = object : Runnable {
        override fun run() {
            if (!running) return
            pollNow()
            muterHandler?.postDelayed(this, 1000)
        }
    }

    private val playbackCallback = object : AudioManager.AudioPlaybackCallback() {
        override fun onPlaybackConfigChanged(configs: MutableList<android.media.AudioPlaybackConfiguration>) {
            val media = configs.count {
                when (it.audioAttributes.usage) {
                    AudioAttributes.USAGE_MEDIA, AudioAttributes.USAGE_GAME, AudioAttributes.USAGE_UNKNOWN -> true
                    else -> false
                }
            }
            if (media > lastMediaPlayers) {
                hold = true
                holdDeadline = android.os.SystemClock.uptimeMillis() + 800
            }
            lastMediaPlayers = media
            // 덤프에 세션이 늦게 나타날 수 있어서 몇 번 연달아 확인
            val h = muterHandler ?: return
            for (d in longArrayOf(0, 60, 150, 300, 550)) h.postDelayed({ pollNow() }, d)
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android 14+: getMediaProjection 전에 반드시 mediaProjection 타입으로 포그라운드 시작
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)

        when (intent?.action) {
            ACTION_STOP -> {
                SpatialSettings.load(this).copy(enabled = false).save(this)
                SpatialTileService.requestUpdate(this)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val code = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                @Suppress("DEPRECATION")
                val data: Intent? = if (Build.VERSION.SDK_INT >= 33)
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                else intent.getParcelableExtra(EXTRA_RESULT_DATA)
                if (projection == null && data != null) start(code, data)
            }
        }
        if (projection == null) {
            // 동의 정보 없이 재시작된 경우(시스템이 서비스를 되살림) — 다시 동의를 받아야 함
            stopSelf()
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    private fun start(code: Int, data: Intent) {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val p = try {
            mpm.getMediaProjection(code, data)
        } catch (t: Throwable) {
            Log.e(TAG, "MediaProjection 실패", t); null
        } ?: run { stopSelf(); return }
        p.registerCallback(projectionCallback, main)
        projection = p

        settings = SpatialSettings.load(this)
        updateHeadTracking()
        audioManager.registerAudioDeviceCallback(deviceCallback, main)
        refreshDevices()

        running = true

        // 원래 소리 음소거 담당 (별도 스레드). 새 소리가 시작되면 즉시, 평소엔 1초마다.
        val ht = HandlerThread("muter").also { it.start() }
        muterThread = ht
        val mh = Handler(ht.looper)
        muterHandler = mh
        muter = SessionMuter(this)
        // 이미 재생 중인 소리가 있으면 첫 음소거가 끝날 때까지 hold
        lastMediaPlayers = audioManager.activePlaybackConfigurations.count {
            it.audioAttributes.usage == AudioAttributes.USAGE_MEDIA ||
                it.audioAttributes.usage == AudioAttributes.USAGE_GAME ||
                it.audioAttributes.usage == AudioAttributes.USAGE_UNKNOWN
        }
        hold = true
        holdDeadline = android.os.SystemClock.uptimeMillis() + 800
        mh.post(periodicPoll)
        audioManager.registerAudioPlaybackCallback(playbackCallback, mh)
        worker = Thread({ audioLoop(p) }, "strong3d-audio").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
        publishState()
    }

    private fun audioLoop(p: MediaProjection) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val rate = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)
            ?.toIntOrNull()?.takeIf { it > 0 } ?: 48000
        val framesPerBuffer = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)
            ?.toIntOrNull()?.takeIf { it > 0 } ?: 256
        val chunk = framesPerBuffer.coerceIn(128, 1024) * 2 // 프레임 → 샘플(스테레오)

        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(rate)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()

        val capture = AudioPlaybackCaptureConfiguration.Builder(p)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .excludeUid(Process.myUid()) // 내가 내보내는 소리를 다시 잡지 않게
            .build()

        val minRec = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
        val record = try {
            AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(maxOf(minRec, chunk * 4 * 4))
                .setAudioPlaybackCaptureConfig(capture)
                .build()
        } catch (t: Throwable) {
            Log.e(TAG, "AudioRecord 생성 실패 (마이크 권한?)", t)
            main.post { stopSelf() }
            return
        }

        val minTrack = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .setBufferSizeInBytes(maxOf(minTrack, chunk * 4 * 2))
            .build()

        this.record = record
        ensureAssets(this)
        val dsp = BinauralProcessor(rate).also { it.setParams(settings); processor = it }
        updateBypass()

        val buf = FloatArray(chunk)
        var outGain = 0f
        val rampStep = 1f / (0.015f * rate)
        try {
            record.startRecording()
            track.play()
            while (running) {
                val n = record.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)
                if (n <= 0) {
                    if (n < 0) Log.w(TAG, "read 오류 $n")
                    continue
                }
                dsp.process(buf, n / 2)
                // hold 중엔 0, 아니면 1 로 15ms 동안 부드럽게 (딸깍 소리 방지)
                val target = if (hold) 0f else 1f
                if (outGain != target || target == 0f) {
                    var i = 0
                    while (i < n) {
                        outGain += (target - outGain).coerceIn(-rampStep, rampStep)
                        buf[i] *= outGain
                        buf[i + 1] *= outGain
                        i += 2
                    }
                }
                track.write(buf, 0, n, AudioTrack.WRITE_BLOCKING)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "오디오 루프 오류", t)
        } finally {
            this.record = null
            runCatching { record.stop() }; record.release()
            runCatching { track.stop() }; track.release()
            processor = null
        }
    }

    override fun onDestroy() {
        running = false
        instance = null
        runCatching { record?.stop() } // 블로킹 read 깨우기
        worker?.join(500)
        worker = null
        headTracker?.stop(); headTracker = null
        main.removeCallbacks(headPump)
        runCatching { audioManager.unregisterAudioPlaybackCallback(playbackCallback) }
        muterHandler?.removeCallbacksAndMessages(null)
        val m = muter
        val ht = muterThread
        if (m != null && ht != null) {
            Handler(ht.looper).post { m.releaseAll(); ht.quitSafely() }
        }
        muter = null; muterThread = null; muterHandler = null
        runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
        projection?.let { runCatching { it.unregisterCallback(projectionCallback); it.stop() } }
        projection = null
        EngineState.update { it.copy(strongRunning = false, mutedApps = emptyList(), restrictedApps = emptySet(), headTrackingOn = false, headSensor = "", headYaw = 0.0) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------------------------------------------------------------------

    fun applySettings(s: SpatialSettings) {
        settings = s
        processor?.setParams(s)
        updateHeadTracking()
        updateBypass()
        updateNotification()
    }

    private fun updateBypass() {
        processor?.bypass = !(settings.enabled && (!settings.headphonesOnly || headphones))
    }

    private fun refreshDevices() {
        val hp = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.type in HEADPHONE_TYPES }
        headphones = hp != null
        headphoneName = hp?.productName?.toString().orEmpty()
        updateBypass()
        publishState()
        updateNotification()
    }

    private fun publishState() {
        val m = muter
        EngineState.update {
            it.copy(
                strongRunning = running,
                headphones = headphones,
                headphoneName = headphoneName,
                dumpGranted = SessionMuter.hasDumpPermission(this),
                mutedApps = m?.mutedPackages ?: emptyList(),
                restrictedApps = m?.restrictedPackages ?: emptySet(),
                headTrackingOn = headTracker != null,
                headSensor = if (headTracker?.available == true) headTracker?.sensorName.orEmpty() else "",
            )
        }
    }

    // --- 알림 ---------------------------------------------------------------

    private fun createChannel() {
        val ch = NotificationChannel(CHANNEL_ID, "강력 3D 모드", NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 2, Intent(this, Strong3DService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = when {
            settings.headphonesOnly && !headphones -> "헤드폰을 연결하면 적용됩니다"
            else -> "강력 3D 적용 중 · " + (SOUND_PRESETS.getOrNull(settings.presetIndex)?.name ?: "")
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_headphones)
            .setContentTitle("3D 사운드 (강력 모드)")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "끄기", stop).build())
            .build()
    }

    private fun updateNotification() {
        if (projection == null) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    companion object {
        private const val TAG = "Strong3DService"
        private const val CHANNEL_ID = "strong_3d"
        private const val NOTIFICATION_ID = 3002
        const val ACTION_START = "com.spatialsound.app.STRONG_START"
        const val ACTION_STOP = "com.spatialsound.app.STRONG_STOP"
        const val EXTRA_RESULT_CODE = "code"
        const val EXTRA_RESULT_DATA = "data"

        @Volatile
        var instance: Strong3DService? = null
            private set

        val isRunning get() = instance?.running == true

        fun start(context: Context, resultCode: Int, data: Intent) {
            context.startForegroundService(
                Intent(context, Strong3DService::class.java)
                    .setAction(ACTION_START)
                    .putExtra(EXTRA_RESULT_CODE, resultCode)
                    .putExtra(EXTRA_RESULT_DATA, data)
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, Strong3DService::class.java))
        }

        /** 실측 HRIR + 헤드폰 보정 데이터를 한 번만 불러 둔다 */
        fun ensureAssets(context: Context) {
            ensureHrir(context)
            if (HeadphoneEq.profiles.isEmpty()) {
                runCatching { context.assets.open("headphone_eq.txt").use { HeadphoneEq.profiles = HeadphoneEq.parse(it) } }
                    .onFailure { Log.e(TAG, "헤드폰 보정 데이터 로드 실패", it) }
            }
        }

        /** 실측 HRIR 을 앱 assets 에서 한 번만 불러 둔다 */
        fun ensureHrir(context: Context): HrirSet? {
            BinauralProcessor.hrirBase?.let { return it }
            return runCatching {
                context.assets.open("hrir_kemar.bin").use { HrirSet.load(it) }
            }.onFailure { Log.e(TAG, "HRIR 로드 실패", it) }
                .getOrNull()?.also { BinauralProcessor.hrirBase = it }
        }

        private val HEADPHONE_TYPES = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            26, // TYPE_BLE_HEADSET
        )
    }
}
