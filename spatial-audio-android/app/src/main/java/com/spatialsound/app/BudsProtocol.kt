package com.spatialsound.app

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * 갤럭시 버즈 360 오디오 센서 프로토콜 + 머리 각도 계산 (안드로이드 의존성 없음 → PC 에서 검증 가능).
 *
 * 참고 (MIT License):
 *  - BudsPro-Headtracking, GalaxyBudsClient — Tim Schneeberger (timschneeb)
 *  - galaxy-buds-headtracker — AkbulutMirac (Galaxy Buds2 에서 검증된 각도 계산)
 */
object BudsProtocol {
    /** Buds+ 이후 모델의 관리용 시리얼 서비스 UUID (GalaxyBudsClient: SppNew) */
    const val SPP_UUID = "2e73a4ad-332d-41fc-90e2-16bef06523f2"
    const val SOM = 0xFD.toByte()
    const val EOM = 0xDD.toByte()
    const val SET_SPATIAL_AUDIO = 124.toByte()   // [1] 켜기, [0] 끄기
    const val DATA = 194.toByte()                // 버즈 → 폰: 센서 이벤트
    const val CONTROL = 195.toByte()             // [0] 붙이기, [4] 유지(2초마다), [1] 떼기
    const val CTRL_ATTACH: Byte = 0
    const val CTRL_DETACH: Byte = 1
    const val CTRL_ATTACH_OK: Byte = 2
    const val CTRL_KEEPALIVE: Byte = 4
    const val DATA_GRV = 32       // 게임 회전 벡터: int16 ×4 / 10000 쿼터니언 (x, y, z, w)
    const val DATA_WEAR_ON = 33
    const val DATA_WEAR_OFF = 34
    const val DATA_STUCK = 36

    /** 삼성 게임 회전 벡터 좌표에서 세계 X 축이 수직 (galaxy-buds-headtracker 측정) */
    private val WORLD_UP = doubleArrayOf(1.0, 0.0, 0.0)

    /** CRC-16/XMODEM (다항식 0x1021, 초기값 0) — 메시지 ID + 내용에 대해 */
    fun crc16(data: ByteArray): Int {
        var crc = 0
        for (b in data) {
            crc = crc xor ((b.toInt() and 0xFF) shl 8)
            repeat(8) { crc = (if (crc and 0x8000 != 0) (crc shl 1) xor 0x1021 else crc shl 1) and 0xFFFF }
        }
        return crc
    }

    /** FD | 크기(2바이트 LE: ID+내용+CRC) | 메시지 ID | 내용 | CRC(2, LE) | DD */
    fun encode(id: Byte, payload: ByteArray): ByteArray {
        val body = byteArrayOf(id) + payload
        val size = body.size + 2
        val crc = crc16(body)
        return byteArrayOf(SOM, (size and 0xFF).toByte(), (size shr 8).toByte()) + body +
            byteArrayOf((crc and 0xFF).toByte(), (crc shr 8).toByte(), EOM)
    }

    /**
     * buf[0, len) 에서 완성된 프레임을 꺼내 onFrame(메시지 ID, 내용)을 부르고, 남은(미완성) 바이트 수를 반환.
     * 깨진 프레임은 건너뛰고, CRC 가 틀린 프레임은 버린다.
     */
    fun extractFrames(buf: ByteArray, len0: Int, onFrame: (Int, ByteArray) -> Unit): Int {
        var len = len0
        while (true) {
            var start = -1
            for (i in 0 until len) if (buf[i] == SOM) { start = i; break }
            if (start < 0) return 0
            if (start > 0) { System.arraycopy(buf, start, buf, 0, len - start); len -= start }
            if (len < 3) return len
            val size = ((buf[1].toInt() and 0xFF) or ((buf[2].toInt() and 0xFF) shl 8)) and 0x3FF
            val total = 3 + size + 1
            if (len < total) return len
            if (size < 3 || buf[total - 1] != EOM) {
                System.arraycopy(buf, 1, buf, 0, len - 1); len -= 1; continue
            }
            val body = buf.copyOfRange(3, 1 + size)
            val crc = (buf[1 + size].toInt() and 0xFF) or ((buf[2 + size].toInt() and 0xFF) shl 8)
            if (crc16(body) == crc && body.isNotEmpty()) onFrame(body[0].toInt() and 0xFF, body.copyOfRange(1, body.size))
            System.arraycopy(buf, total, buf, 0, len - total)
            len -= total
        }
    }

    // ── 쿼터니언 (x, y, z, w) ──
    fun qMul(a: DoubleArray, b: DoubleArray) = doubleArrayOf(
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    )
    fun qConj(q: DoubleArray) = doubleArrayOf(-q[0], -q[1], -q[2], q[3])
    fun normalize(v: DoubleArray): DoubleArray {
        val n = sqrt(v.sumOf { it * it }).takeIf { it > 0 } ?: 1.0
        return DoubleArray(v.size) { v[it] / n }
    }
    /** q v q⁻¹ — 버즈 센서에서는 세계 벡터 → 버즈 좌표, qConj(q) 를 쓰면 반대 */
    fun rotate(v: DoubleArray, q: DoubleArray): DoubleArray {
        val r = qMul(qMul(q, doubleArrayOf(v[0], v[1], v[2], 0.0)), qConj(q))
        return doubleArrayOf(r[0], r[1], r[2])
    }
    fun cross(a: DoubleArray, b: DoubleArray) =
        doubleArrayOf(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

    private fun nose(ref: DoubleArray, lat: DoubleArray): DoubleArray {
        var n = cross(lat, rotate(WORLD_UP, ref))
        if (sqrt(n.sumOf { it * it }) < 1e-3) n = cross(doubleArrayOf(0.0, 1.0, 0.0), rotate(WORLD_UP, ref))
        return normalize(n)
    }

    /**
     * ref 대비 머리 좌우 회전각 (도, + = 왼쪽). "코 방향" 벡터를 세계 수평면에서 추적하므로
     * 버즈가 귀에 기울어져 꽂혀 있어도 좌우 회전만 잡힌다.
     */
    fun headYaw(q: DoubleArray, ref: DoubleArray, lat: DoubleArray): Double {
        val nz = nose(ref, lat)
        val s = rotate(nz, qConj(ref))
        val n = rotate(nz, qConj(q))
        return Math.toDegrees(atan2(s[1] * n[2] - s[2] * n[1], s[1] * n[1] + s[2] * n[2]))
    }

    /** 위/아래 각도 (+ = 위) */
    fun headPitch(q: DoubleArray, ref: DoubleArray, lat: DoubleArray): Double {
        val n = rotate(nose(ref, lat), qConj(q))
        return Math.toDegrees(asin(n[0].coerceIn(-1.0, 1.0)))
    }

    fun wrap(d: Double): Double {
        var x = d % 360.0
        if (x > 180) x -= 360.0
        if (x < -180) x += 360.0
        return x
    }
}
