package com.spatialsound.app

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.util.Log
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 이어폰의 머리 방향 센서(Android 13+ 표준 Sensor.TYPE_HEAD_TRACKER)를 읽어
 * 머리가 정면에서 좌우로 돌아간 각도(yaw, 도)를 알려 준다.
 *
 * 센서는 블루투스 이어폰이 "Android 헤드 트래킹" 규격을 지원할 때만 나타난다
 * (예: Pixel Buds Pro, 일부 최신 이어폰). 지원하지 않는 이어폰이면 [available] 이 false.
 */
class HeadTracker(
    context: Context,
    private val handler: Handler,
    private val onChange: () -> Unit,
) {
    private val sm = context.getSystemService(SensorManager::class.java)
    private var sensor: Sensor? = null
    private var running = false

    /** 정면 기준 머리 각도 (오른쪽 +) */
    @Volatile var yawDeg = 0.0
        private set
    var available = false
        private set
    var sensorName = ""
        private set
    var invert = false

    private var rawYaw = 0.0
    private var center = 0.0
    private var lastDiscontinuity = -1f
    private var smoothed = 0.0
    private var needCenter = true

    private val listener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val v = e.values
            // values[0..2]: 머리 자세 회전 벡터 (회전축 × 각도[rad])
            rawYaw = yawFromRotationVector(v[0].toDouble(), v[1].toDouble(), v[2].toDouble())
            // values[6]: 기준 좌표가 바뀐 횟수 → 바뀌면 다시 정면 맞추기
            if (v.size > 6 && v[6] != lastDiscontinuity) {
                lastDiscontinuity = v[6]
                needCenter = true
            }
            if (needCenter) {
                center = rawYaw
                smoothed = 0.0
                needCenter = false
            }
            var d = wrap(rawYaw - center)
            if (invert) d = -d
            // 약한 스무딩 (센서 잡음 제거), 각도 경계(±180°) 처리
            smoothed = wrap(smoothed + wrap(d - smoothed) * 0.35)
            yawDeg = smoothed
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    private val dynamicCallback = object : SensorManager.DynamicSensorCallback() {
        override fun onDynamicSensorConnected(s: Sensor) {
            if (Build.VERSION.SDK_INT >= 33 && s.type == Sensor.TYPE_HEAD_TRACKER && running && sensor == null) attach(s)
        }

        override fun onDynamicSensorDisconnected(s: Sensor) {
            if (s == sensor) detach()
        }
    }

    fun start() {
        if (running) return
        running = true
        if (Build.VERSION.SDK_INT < 33) {
            onChange()
            return
        }
        sm.registerDynamicSensorCallback(dynamicCallback, handler)
        sm.getDynamicSensorList(Sensor.TYPE_HEAD_TRACKER).firstOrNull()?.let { attach(it) }
        onChange()
    }

    fun stop() {
        if (!running) return
        running = false
        runCatching { sm.unregisterDynamicSensorCallback(dynamicCallback) }
        detach()
        yawDeg = 0.0
    }

    /** 지금 보고 있는 방향을 정면으로 */
    fun recenter() {
        needCenter = true
    }

    private fun attach(s: Sensor) {
        sensor = s
        available = sm.registerListener(listener, s, SensorManager.SENSOR_DELAY_GAME, handler)
        sensorName = s.name
        needCenter = true
        Log.i("HeadTracker", "헤드 트래커 연결: ${s.name} ok=$available")
        onChange()
    }

    private fun detach() {
        runCatching { sm.unregisterListener(listener) }
        sensor = null
        available = false
        sensorName = ""
        yawDeg = 0.0
        onChange()
    }

    companion object {
        /** 이 기기에 지금 헤드 트래커 센서가 있는지 (이어폰 연결 상태에 따라 달라짐) */
        fun hasSensor(context: Context): Boolean = Build.VERSION.SDK_INT >= 33 &&
            context.getSystemService(SensorManager::class.java)
                .getDynamicSensorList(Sensor.TYPE_HEAD_TRACKER).isNotEmpty()

        private fun wrap(d: Double): Double {
            var x = d % 360.0
            if (x > 180) x -= 360.0
            if (x < -180) x += 360.0
            return x
        }

        /**
         * 회전 벡터 → 수평 회전각.
         * 머리 좌표: X = 오른쪽 귀 방향, Y = 코 방향(앞), Z = 정수리 방향.
         * 머리의 앞 방향 (0,1,0) 을 기준 좌표로 돌린 뒤 수평면에서의 각도를 구한다.
         */
        fun yawFromRotationVector(rx: Double, ry: Double, rz: Double): Double {
            val angle = sqrt(rx * rx + ry * ry + rz * rz)
            if (angle < 1e-9) return 0.0
            val kx = rx / angle; val ky = ry / angle; val kz = rz / angle
            val c = cos(angle); val s = sin(angle); val t = 1 - c
            // 로드리게스 회전 행렬의 2열 (= R · (0,1,0))
            val fx = t * kx * ky - s * kz
            val fy = t * ky * ky + c
            // Z축 +회전(위에서 볼 때 반시계) = 왼쪽으로 고개 돌림 → atan2 가 음수 → 오른쪽 + 규칙과 일치
            return Math.toDegrees(atan2(fx, fy))
        }
    }
}
