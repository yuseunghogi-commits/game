package com.spatialsound.app

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

/** 헤드 트래킹 입력 (버즈 직접 연결 / Android 표준 머리 센서) 공통 모양 */
interface HeadSource {
    /** 정면 기준 머리 각도 (도, 오른쪽 +) */
    val yawDeg: Double
    /** 머리 위아래 각도 (도, 위 +) — 지원하지 않으면 0 */
    val pitchDeg: Double
    /** 실제로 머리 방향을 받고 있으면 기기 이름, 아니면 "" */
    val activeName: String
    /** 상태 설명 (화면 표시용) */
    val info: String
    var invert: Boolean
    fun start()
    fun stop()
    fun recenter()
}

/**
 * 갤럭시 버즈의 360 오디오용 모션 센서를 블루투스로 직접 읽는 헤드 트래커.
 *
 * Buds+ 이후 모델의 관리용 시리얼 서비스(RFCOMM, UUID 2e73a4ad-…)에 접속해
 * 공간 음향 센서를 켜고(124), 붙이고(195 [0]), 2초마다 유지 신호(195 [4])를 보내면
 * 초당 약 50번 머리 회전 쿼터니언(194, 종류 32 = 게임 회전 벡터)이 온다.
 *
 * 프로토콜과 각도 계산은 MIT 라이선스 프로젝트를 참고해 다시 구현했다:
 *  - BudsPro-Headtracking, GalaxyBudsClient — Tim Schneeberger (timschneeb), MIT
 *  - galaxy-buds-headtracker — AkbulutMirac, MIT (Galaxy Buds2 에서 검증된 각도 계산)
 *
 * 주의: 삼성 Galaxy Wearable(버즈 플러그인)이 같은 연결을 쓰고 있으면 접속이 거절될 수 있다.
 */
class BudsHeadTracker(private val context: Context, private val onChange: () -> Unit) : HeadSource {

    @Volatile override var yawDeg = 0.0
        private set
    @Volatile override var pitchDeg = 0.0
        private set
    private var smoothedPitch = 0.0
    @Volatile override var activeName = ""
        private set
    @Volatile override var info = "준비 중"
        private set
    @Volatile override var invert = false

    @Volatile private var running = false
    @Volatile private var recenterRequested = true
    @Volatile private var socket: BluetoothSocket? = null
    private var thread: Thread? = null

    // 쿼터니언 (x, y, z, w)
    private var ref: DoubleArray? = null
    private var lat = normalize(doubleArrayOf(0.99, 0.0, -0.13)) // 고개를 끄덕이는 축 (버즈 좌표, Buds2 측정값)
    private var smoothed = 0.0

    override fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "buds-head").apply { isDaemon = true; start() }
    }

    override fun stop() {
        running = false
        val s = socket
        if (s != null) {
            runCatching {
                s.outputStream.write(encode(CONTROL, byteArrayOf(CTRL_DETACH)))
                s.outputStream.write(encode(SET_SPATIAL_AUDIO, byteArrayOf(0)))
            }
            runCatching { s.close() }
        }
        thread?.interrupt()
        thread = null
        yawDeg = 0.0
        pitchDeg = 0.0
        activeName = ""
    }

    override fun recenter() {
        recenterRequested = true
    }

    private fun setInfo(text: String) {
        if (info != text) {
            info = text
            onChange()
        }
    }

    private fun loop() {
        while (running) {
            var dev: BluetoothDevice? = null
            try {
                dev = findBuds()
                if (dev == null) {
                    setInfo("연결된 갤럭시 버즈를 찾지 못했습니다 (버즈를 먼저 폰에 연결하세요)")
                    pause(3000); continue
                }
                val name = dev.name ?: "Galaxy Buds"
                setInfo("$name 에 연결 중…")
                val s = dev.createRfcommSocketToServiceRecord(SPP_UUID)
                socket = s
                s.connect()
                stream(s, name)
            } catch (e: SecurityException) {
                setInfo("블루투스 권한이 필요합니다 (앱 설정 → 권한 → 근처 기기)")
                pause(3000)
            } catch (e: IOException) {
                if (!running) break
                setInfo("버즈에 연결하지 못했습니다. 삼성 Galaxy Wearable 앱이 버즈 연결을 쓰고 있으면 실패할 수 있어요 — 잠시 후 다시 시도합니다.")
                Log.w(TAG, "연결 실패: ${e.message}")
                pause(5000)
            } finally {
                runCatching { socket?.close() }
                socket = null
                activeName = ""
                yawDeg = 0.0
                pitchDeg = 0.0
                onChange()
            }
        }
    }

    private fun pause(ms: Long) {
        try { Thread.sleep(ms) } catch (e: InterruptedException) { }
    }

    /** 센서 켜기 → 데이터 받기. 연결이 끊기면 예외로 빠져나감 */
    private fun stream(s: BluetoothSocket, name: String) {
        val out: OutputStream = s.outputStream
        val inp: InputStream = s.inputStream
        out.write(encode(SET_SPATIAL_AUDIO, byteArrayOf(1)))
        out.write(encode(CONTROL, byteArrayOf(CTRL_ATTACH)))
        setInfo("$name 연결됨 — 센서 시작을 기다리는 중…")
        // 2초마다 유지 신호 (읽기와 별도 스레드)
        val keep = Thread({
            try {
                while (running && socket === s) {
                    Thread.sleep(2000)
                    out.write(encode(CONTROL, byteArrayOf(CTRL_KEEPALIVE)))
                }
            } catch (e: Exception) { }
        }, "buds-keepalive").apply { isDaemon = true; start() }

        val buf = ByteArray(4096)
        var len = 0
        val chunk = ByteArray(1024)
        try {
            while (running) {
                val n = inp.read(chunk)
                if (n < 0) throw IOException("버즈가 연결을 닫았습니다")
                if (len + n > buf.size) len = 0 // 비정상 데이터: 버림
                System.arraycopy(chunk, 0, buf, len, n)
                len += n
                len = parseFrames(buf, len, name)
            }
        } finally {
            keep.interrupt()
        }
    }

    /** buf[0, len) 에서 완성된 프레임을 처리하고, 남은 바이트 수를 반환 */
    private fun parseFrames(buf: ByteArray, len: Int, name: String): Int =
        BudsProtocol.extractFrames(buf, len) { id, payload -> handle(id, payload, name) }

    private fun handle(id: Int, payload: ByteArray, name: String) {
        if (id == (CONTROL.toInt() and 0xFF) && payload.isNotEmpty()) {
            if (payload[0] == CTRL_ATTACH_OK) setInfo("$name 헤드 트래킹 동작 중")
            return
        }
        if (id != (DATA.toInt() and 0xFF) || payload.isEmpty()) return
        when (payload[0].toInt() and 0xFF) {
            DATA_GRV -> if (payload.size >= 9) {
                val raw = DoubleArray(4) { i ->
                    val lo = payload[1 + 2 * i].toInt() and 0xFF
                    val hi = payload[2 + 2 * i].toInt()
                    ((hi shl 8) or lo).toShort() / 10000.0
                }
                val q = normalize(raw)
                if (recenterRequested || ref == null) {
                    ref = q; recenterRequested = false; smoothed = 0.0; smoothedPitch = 0.0
                }
                // + 왼쪽 → 엔진 규칙(+ 오른쪽)으로 뒤집기
                var yaw = -headYaw(q, ref!!, lat)
                if (invert) yaw = -yaw
                smoothed += wrap(yaw - smoothed) * 0.5
                yawDeg = wrap(smoothed)
                smoothedPitch += (BudsProtocol.headPitch(q, ref!!, lat) - smoothedPitch) * 0.5
                pitchDeg = smoothedPitch.coerceIn(-60.0, 60.0)
                if (activeName != name) { activeName = name; setInfo("$name 헤드 트래킹 동작 중") }
            }
            DATA_WEAR_ON -> { recenterRequested = true; setInfo("$name 착용됨 — 지금 보는 방향을 정면으로 맞췄습니다") }
            DATA_WEAR_OFF -> setInfo("$name 을(를) 귀에서 뺐습니다")
            DATA_STUCK -> setInfo("버즈 센서가 멈췄습니다 — 버즈를 케이스에 넣었다 빼 보세요")
        }
    }

    /** 연결된(또는 페어링된) 갤럭시 버즈 찾기 */
    private fun findBuds(): BluetoothDevice? {
        val adapter: BluetoothAdapter = context.getSystemService(BluetoothManager::class.java)?.adapter ?: return null
        fun supports(d: BluetoothDevice) = d.uuids?.any { it.uuid == SPP_UUID } == true || (d.name ?: "").contains("Buds", true)
        // 1) 지금 소리가 나가는 블루투스 기기
        if (Build.VERSION.SDK_INT >= 28) {
            val am = context.getSystemService(AudioManager::class.java)
            for (o in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                if (o.type != AudioDeviceInfo.TYPE_BLUETOOTH_A2DP && o.type != 26 /* BLE 헤드셋 */) continue
                val addr = o.address
                if (BluetoothAdapter.checkBluetoothAddress(addr)) {
                    val d = adapter.getRemoteDevice(addr)
                    if (supports(d)) return d
                }
            }
        }
        // 2) 페어링된 기기 중 버즈
        return adapter.bondedDevices?.firstOrNull { supports(it) }
    }

    companion object {
        private const val TAG = "BudsHeadTracker"
        val SPP_UUID: UUID = UUID.fromString(BudsProtocol.SPP_UUID)
        private const val SET_SPATIAL_AUDIO = BudsProtocol.SET_SPATIAL_AUDIO
        private const val DATA = BudsProtocol.DATA
        private const val CONTROL = BudsProtocol.CONTROL
        private const val CTRL_ATTACH = BudsProtocol.CTRL_ATTACH
        private const val CTRL_DETACH = BudsProtocol.CTRL_DETACH
        private const val CTRL_ATTACH_OK = BudsProtocol.CTRL_ATTACH_OK
        private const val CTRL_KEEPALIVE = BudsProtocol.CTRL_KEEPALIVE
        private const val DATA_GRV = BudsProtocol.DATA_GRV
        private const val DATA_WEAR_ON = BudsProtocol.DATA_WEAR_ON
        private const val DATA_WEAR_OFF = BudsProtocol.DATA_WEAR_OFF
        private const val DATA_STUCK = BudsProtocol.DATA_STUCK
        private fun encode(id: Byte, payload: ByteArray) = BudsProtocol.encode(id, payload)
        private fun normalize(v: DoubleArray) = BudsProtocol.normalize(v)
        private fun headYaw(q: DoubleArray, ref: DoubleArray, lat: DoubleArray) = BudsProtocol.headYaw(q, ref, lat)
        private fun wrap(d: Double) = BudsProtocol.wrap(d)
    }
}
