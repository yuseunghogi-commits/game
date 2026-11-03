package com.spatialsound.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 가상의 방 — 직육면체 방의 이미지 소스(거울상) 모델.
 *
 * 앞 왼쪽/오른쪽 가상 스피커에서 나간 소리가 벽·바닥·천장에 1~2번 튕겨 귀에 도착하는 경로를
 * 실제 기하학으로 계산한다: 도착 시간차(경로 길이), 세기(거리 감쇠 × 벽 반사율), 도착 방향(방위각).
 * 각 반사음은 방향이 가장 가까운 두 "방향 버스"(45° 간격 8개)에 나눠 넣고,
 * 버스는 HrtfRenderer 가 실측 HRTF 로 들려준다 → 반사음 하나하나가 실제 귀 특성을 거쳐 들린다.
 */
object RoomModel {

    /** 버스 i 의 방향 = i × 45° (0 = 정면, 오른쪽 +). HrtfRenderer.BUS_ANGLES 와 같다. */
    const val BUSES = 8

    class Taps(val n: Int) {
        val input = IntArray(n)      // 0 = 왼쪽 스피커(L 입력), 1 = 오른쪽 스피커(R 입력)
        val delay = IntArray(n)      // 직접음 대비 늦게 도착하는 시간 (샘플)
        val gain = FloatArray(n)
        val lpc = FloatArray(n)      // 벽 흡수(고음 감소) 1차 저역통과 계수
        val lp = FloatArray(n)       // 필터 상태
        val busA = IntArray(n); val busB = IntArray(n)
        val wA = FloatArray(n); val wB = FloatArray(n)
        val azimuth = DoubleArray(n) // 검증/표시용
        var energy = 0.0             // 스피커 하나당 반사음 에너지 합 (음량 보정용)
    }

    /** 방 크기(m)와 벽 반사율 — REVERB_NAMES 순서: 없음, 작은 방, 중간 방, 큰 방, 중간 홀, 큰 홀, 플레이트 */
    private class Geo(val w: Double, val l: Double, val h: Double, val beta: Double)
    private val GEOS = arrayOf(
        Geo(4.0, 4.5, 2.5, 0.60),
        Geo(3.5, 4.0, 2.5, 0.65),
        Geo(5.0, 6.0, 2.8, 0.70),
        Geo(7.0, 8.5, 3.2, 0.72),
        Geo(12.0, 16.0, 6.0, 0.78),
        Geo(18.0, 26.0, 9.0, 0.80),
        Geo(4.0, 5.0, 2.6, 0.75),
    )

    private const val C = 343.0
    private const val EAR_H = 1.2
    private const val FLOOR_BETA = 0.45 // 바닥(카펫/가구)은 덜 반사 — 직접음과 너무 가까운 반사는 음색을 탁하게 함

    /**
     * @param frontDeg 앞 스피커 각도 (±)
     * @param amount   반사음 양 (0..~1.2)
     */
    fun build(fs: Int, frontDeg: Double, roomIdx: Int, amount: Double): Taps {
        val g = GEOS[roomIdx.coerceIn(0, GEOS.lastIndex)]
        // 방 좌표: x = 오른쪽, y = 앞, z = 위. 청취자 (0, 0, EAR_H), 방 중앙보다 약간 뒤에 앉음
        val x0 = -g.w / 2; val x1 = g.w / 2
        val y0 = -0.45 * g.l; val y1 = 0.55 * g.l
        val z0 = 0.0; val z1 = g.h
        val d0 = (0.35 * minOf(g.w, g.l)).coerceIn(1.5, 3.0) // 스피커까지 거리
        data class T(val input: Int, val delay: Int, val gain: Double, val lpc: Float, val az: Double)
        val list = ArrayList<T>()
        for (input in 0..1) {
            val th = Math.toRadians(if (input == 0) -frontDeg else frontDeg)
            val sx = d0 * sin(th); val sy = d0 * cos(th); val sz = EAR_H
            for (nx in -2..2) for (ny in -2..2) for (nz in -2..2) {
                val order = abs(nx) + abs(ny) + abs(nz)
                if (order !in 1..2) continue
                val ix = mirror(sx, x0, x1, nx)
                val iy = mirror(sy, y0, y1, ny)
                val iz = mirror(sz, z0, z1, nz)
                val dx = ix; val dy = iy; val dz = iz - EAR_H
                val r = sqrt(dx * dx + dy * dy + dz * dz)
                val floors = if (nz > 0) abs(nz) / 2 else (abs(nz) + 1) / 2
                val others = order - floors
                var gain = (d0 / r) * g.beta.pow(others) * FLOOR_BETA.pow(floors) * amount
                // 옆에서 위/아래로 크게 꺾여 오는 소리는 수평 HRTF 로 근사하므로 약간 줄임
                val elev = abs(atan2(dz, sqrt(dx * dx + dy * dy)))
                gain *= cos(elev).coerceAtLeast(0.5)
                if (gain < 0.015) continue
                val delaySec = (r - d0) / C
                val cutoff = (if (order == 1) 8000.0 else 5000.0).let { if (floors > 0) minOf(it, 3500.0) else it }
                val lpc = (1.0 - exp(-2.0 * PI * cutoff / fs)).toFloat()
                val az = Math.toDegrees(atan2(dx, dy)) // 0 = 정면, + = 오른쪽
                list += T(input, (delaySec * fs).toInt(), gain, lpc, az)
            }
        }
        val t = Taps(list.size)
        var e = 0.0
        for ((i, v) in list.withIndex()) {
            t.input[i] = v.input; t.delay[i] = v.delay; t.gain[i] = v.gain.toFloat(); t.lpc[i] = v.lpc
            t.azimuth[i] = v.az
            // 가장 가까운 두 버스에 등파워로 나눔
            val a = ((v.az % 360.0) + 360.0) % 360.0
            val pos = a / (360.0 / BUSES)
            val i0 = floor(pos).toInt() % BUSES
            val frac = pos - floor(pos)
            t.busA[i] = i0; t.busB[i] = (i0 + 1) % BUSES
            t.wA[i] = cos(frac * PI / 2).toFloat(); t.wB[i] = sin(frac * PI / 2).toFloat()
            if (v.input == 0) e += v.gain * v.gain
        }
        t.energy = e
        return t
    }

    /** 1차원 거울상: 벽 a(아래)·b(위) 사이에서 n 번 반사 (n>0 이면 b 먼저, n<0 이면 a 먼저) */
    private fun mirror(x: Double, a: Double, b: Double, n: Int): Double {
        var p = x
        for (i in 1..abs(n)) {
            p = if ((i % 2 == 1) == (n > 0)) 2 * b - p else 2 * a - p
        }
        return p
    }
}
