package com.spatialsound.desktop

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 입력 장치(가상 케이블)와 출력 장치(헤드폰) 사이의 완충 + 시계 차이 보정.
 *
 * 소리가 끊기던 이유:
 * 1) 출력에 미리 채워 둔 소리가 없어서(블록 하나 ≈ 10ms) 스레드가 조금만 늦어도(GC·Windows 오디오 처리) 출력이 비었음
 * 2) 두 장치의 시계가 조금씩 달라서(블루투스 헤드폰은 특히) 출력 버퍼가 점점 비거나 넘쳐 주기적으로 끊김
 *
 * 그래서:
 * - 처음에 [targetFrames] 만큼 무음을 채워 두고 시작 (기본 블록 3개 ≈ 32ms)
 * - 출력 장치에 남은 양이 목표보다 많으면 입력을 아주 조금 빨리, 적으면 조금 느리게 읽어서 (선형 보간, 최대 ±0.5%
 *   = 음 높이로 0.09반음, 실제로는 대부분 0.02% 이하) 목표 근처를 유지
 * - 그래도 출력이 비면(끊김) 목표를 블록 하나만큼 늘려 다음부터 여유를 더 둠 (최대 [MAX_BLOCKS] 개 ≈ 85ms)
 */
class Elastic(val block: Int) {
    /** 출력 장치에 쌓아 둘 목표량 (프레임) */
    var targetFrames = START_BLOCKS * block
        private set
    /** 출력이 빈 횟수 (시작 직후 채우기는 빼고) */
    var underruns = 0
        private set
    /** 입력을 읽는 속도 (1 = 그대로, 1.001 = 0.1% 빨리) */
    var ratio = 1.0
        private set

    private var primed = false
    private var fillAvg = 0.0

    // 처리된 소리를 담아 두는 고리 버퍼 (스테레오 인터리브)
    private val cap = 64 * block
    private val buf = FloatArray(cap * 2)
    private var w = 0L      // 지금까지 넣은 프레임 수
    private var r = 0.0     // 다음에 읽을 위치 (프레임, 소수)

    /** 한 번에 [pull] 이 만들 수 있는 최대 프레임 수 (무음 채우기 포함) → 출력 배열 크기 */
    val maxPull = (MAX_BLOCKS + 8) * block

    /** 처리된 블록 넣기 */
    fun push(x: FloatArray, frames: Int) {
        for (i in 0 until frames) {
            val p = ((w + i) % cap).toInt()
            buf[2 * p] = x[2 * i]; buf[2 * p + 1] = x[2 * i + 1]
        }
        w += frames
        // 너무 쌓이면(출력이 오래 막혔을 때) 오래된 것부터 버려서 지연이 끝없이 늘지 않게
        val keep = (MAX_BLOCKS + 4) * block
        if (w - r > keep) r = (w - keep).toDouble()
    }

    /** 아직 출력하지 않은 처리된 프레임 수 */
    fun queued(): Double = w - r

    /**
     * 이번에 출력 장치에 쓸 프레임을 [out] 에 만들고 개수를 돌려준다.
     * @param fill 지금 출력 장치에 남아 있는(아직 재생 안 된) 프레임 수
     * @param backlog 입력 장치에 밀려 있는(아직 안 읽은) 프레임 수 — 곧 처리돼서 출력으로 갈 양
     */
    fun pull(out: FloatArray, fill: Int, backlog: Int = 0): Int {
        var n = 0
        // 1) 처음이거나 출력이 비었으면 → 무음으로 목표만큼 채움
        if (!primed || fill < block / 4) {
            if (primed) {
                underruns++
                targetFrames = min(targetFrames + block, MAX_BLOCKS * block)
            }
            primed = true
            // 스레드가 멈췄던 동안 입력에 밀린 소리가 곧 들어오므로 그만큼은 무음으로 채우지 않음 (지연이 튀지 않게)
            val pad = (targetFrames - fill - backlog).coerceIn(0, maxPull - 2 * block)
            java.util.Arrays.fill(out, 0, 2 * pad, 0f)
            n = pad
            fillAvg = targetFrames.toDouble()
        } else {
            // 2) 목표와의 차이로 읽는 속도 조절 (평균 내서 측정 오차 무시)
            fillAvg += (fill - fillAvg) * SMOOTH
        }
        // 출력 장치에 남은 양만으로 조절 (방금 넣은 블록·입력에 밀린 양은 곧 나갈 몫이라 넣으면 늘 많아 보여서 너무 빨리 읽게 됨)
        val err = fillAvg - targetFrames
        ratio = 1.0 + (err * GAIN / block).coerceIn(-MAX_ADJ, MAX_ADJ)
        // 3) 선형 보간으로 꺼냄 (보간에 다음 프레임이 필요하므로 하나는 남김)
        while (n < maxPull) {
            val i0 = floor(r).toLong()
            if (i0 + 1 >= w) break
            val f = (r - i0).toFloat()
            val p0 = (i0 % cap).toInt(); val p1 = ((i0 + 1) % cap).toInt()
            val l0 = buf[2 * p0]; val r0 = buf[2 * p0 + 1]
            out[2 * n] = l0 + (buf[2 * p1] - l0) * f
            out[2 * n + 1] = r0 + (buf[2 * p1 + 1] - r0) * f
            r += ratio
            n++
        }
        return n
    }

    /** 출력 장치에 쌓인 양 + 처리 대기 → 지연 (ms) */
    fun latencyMs(fs: Int): Double = (max(0.0, fillAvg) + queued()) * 1000.0 / fs

    companion object {
        const val START_BLOCKS = 3
        const val MAX_BLOCKS = 8
        /** 블록 하나만큼 어긋나면 0.2% 보정 (약 5초에 맞춰짐) → 시계 차이 500ppm 이면 블록 1/4 (약 3ms) 어긋난 채로 안정 */
        const val GAIN = 0.002
        const val MAX_ADJ = 0.005
        /** 출력 양 평균 (블록마다, 약 0.5초) */
        const val SMOOTH = 0.02
    }
}
