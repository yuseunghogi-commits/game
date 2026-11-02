package com.spatialsound.app

import java.io.DataInputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * 실측 머리전달함수(HRIR) 묶음 — 수평면 360°, 2° 간격, 양 귀.
 * 데이터: KEMAR 45BA (큰 귀), TU Berlin / Univ. Rostock, CC BY 4.0
 *   (H. Wierstorf, M. Geier, S. Spors, V. Erbes — "KEMAR HRTFs with low frequency correction")
 * 48kHz 로 변환 + 확산음장 등화 (tools/export_hrir.py).
 *
 * 방향 θ: 0 = 정면, + = 오른쪽 (도). data[dir][ear][tap], ear 0 = 왼쪽.
 */
class HrirSet(
    val fs: Int,
    val taps: Int,
    val dirs: Int,
    val stepDeg: Int,
    val data: Array<Array<FloatArray>>,
) {
    /**
     * 머리/귀 크기 맞춤: 시간축을 factor 배로 늘림 (factor>1 = 큰 머리·귀 → 귓바퀴 특성 주파수↓, 양 귀 시간차↑).
     * 동시에 샘플레이트를 targetFs 로 변환.
     */
    fun adapted(targetFs: Int, factor: Double): HrirSet {
        val ratio = targetFs.toDouble() / fs * factor // 출력 1샘플당 입력 이동량의 역수
        val newTaps = (taps * ratio).roundToInt().coerceIn(64, 1024)
        val lp = ratio < 1.0 // 다운샘플/축소 시 앨리어싱 방지용 저역통과
        val out = Array(dirs) { d ->
            Array(2) { e ->
                val src = data[d][e]
                FloatArray(newTaps) { i ->
                    val x = i / ratio
                    if (lp) sincInterp(src, x, ratio) else cubic(src, x)
                } .also { arr -> if (ratio != 1.0) { val g = (1.0 / ratio).toFloat(); for (k in arr.indices) arr[k] *= g } }
            }
        }
        return HrirSet(targetFs, newTaps, dirs, stepDeg, out)
    }

    private fun cubic(s: FloatArray, x: Double): Float {
        val i = floor(x).toInt()
        val t = (x - i).toFloat()
        fun at(k: Int) = if (k in s.indices) s[k] else 0f
        val p0 = at(i - 1); val p1 = at(i); val p2 = at(i + 1); val p3 = at(i + 2)
        return p1 + 0.5f * t * (p2 - p0 + t * (2f * p0 - 5f * p1 + 4f * p2 - p3 + t * (3f * (p1 - p2) + p3 - p0)))
    }

    private fun sincInterp(s: FloatArray, x: Double, cutoff: Double): Float {
        val half = 8
        val c = floor(x).toInt()
        var acc = 0.0
        for (k in c - half..c + half) {
            if (k !in s.indices) continue
            val d = x - k
            val w = 0.5 + 0.5 * cos(PI * d / (half + 1))
            val a = PI * d * cutoff
            val sinc = if (kotlin.math.abs(a) < 1e-9) 1.0 else kotlin.math.sin(a) / a
            acc += s[k] * cutoff * sinc * w
        }
        return acc.toFloat()
    }

    companion object {
        /** 귀 맞춤 단계별 배율 (작은 머리 → 큰 머리) */
        val EAR_FACTORS = doubleArrayOf(0.88, 0.94, 1.0, 1.06, 1.12)
        val EAR_NAMES = listOf("1 (아주 작게)", "2 (작게)", "3 (보통 · 기본)", "4 (크게)", "5 (아주 크게)")

        fun load(input: InputStream): HrirSet {
            val din = DataInputStream(input.buffered())
            val magic = ByteArray(4).also { din.readFully(it) }
            require(String(magic) == "HRIR") { "HRIR 파일 형식이 아닙니다" }
            val head = ByteArray(24).also { din.readFully(it) }
            val bb = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
            bb.int // version
            val fs = bb.int
            val taps = bb.int
            val dirs = bb.int
            val scale = bb.float
            val step = bb.int
            val raw = ByteArray(dirs * 2 * taps * 2).also { din.readFully(it) }
            val sb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            val k = scale / 32767f
            val data = Array(dirs) { Array(2) { FloatArray(taps) { sb.get() * k } } }
            return HrirSet(fs, taps, dirs, step, data)
        }
    }
}
