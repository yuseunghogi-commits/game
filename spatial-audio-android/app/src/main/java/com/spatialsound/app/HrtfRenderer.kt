package com.spatialsound.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 실측 HRTF 렌더러 (주파수 영역, STFT 50% 겹침, 제로패딩 → 선형 컨볼루션과 동일).
 *
 *  ■ SPEAKERS (공간 모드 · 실측): 스테레오 L/R 을 앞 가상 스피커 ±front 와 뒤 스피커 ±rear 에 놓고
 *    실제 사람 귀(더미헤드)에서 측정한 HRTF 로 들려준다.
 *
 *  ■ LOCALIZE (정위 모드): 소리를 주파수 성분별로 쪼개서 각 성분이 스테레오에서 얼마나 왼쪽/오른쪽에
 *    있는지 분석 → 그 성분만 정확히 해당 방향(각도)에 놓는다. 두 스피커 사이의 "흐릿한 가상 음상" 대신
 *    성분마다 진짜 방향을 줘서 어디서 소리가 나는지 훨씬 또렷하다.
 *    좌우 상관이 낮은 성분(공간 울림, 관중, 바람소리 등)은 뒤/옆으로 보내 앞쪽 소리와 분리한다.
 *
 * 지연(latency) = [WIN] 샘플 (48kHz 에서 21ms).
 */
class HrtfRenderer(private val fs: Int, base: HrirSet) {

    enum class Mode { SPEAKERS, LOCALIZE }

    @Volatile var mode = Mode.SPEAKERS
    @Volatile var frontAngle = 45.0
    @Volatile var rearAngle = 125.0
    @Volatile var rearLevel = 0.4
    /** 정위 모드: 스테레오 끝(완전 왼쪽/오른쪽)이 몇 도에 놓일지 */
    @Volatile var spread = 90.0
    @Volatile var headYaw = 0.0

    private val fft = Fft(N)
    private val bins = N / 2 + 1

    // HRTF 스펙트럼 표: [dir][ear] → re/im (bins)
    private class Table(val dirs: Int, val step: Int, val re: Array<Array<FloatArray>>, val im: Array<Array<FloatArray>>)

    @Volatile private var table: Table = buildTable(base.adapted(fs, 1.0))
    private val baseSet = base
    @Volatile private var earIdx = 2

    /** 귀 맞춤 단계 변경 (백그라운드에서 다시 계산 후 교체) */
    fun setEarSize(idx: Int) {
        val i = idx.coerceIn(0, HrirSet.EAR_FACTORS.lastIndex)
        if (i == earIdx) return
        earIdx = i
        Thread({
            val t = buildTable(baseSet.adapted(fs, HrirSet.EAR_FACTORS[i]))
            if (earIdx == i) table = t
        }, "hrtf-table").apply { isDaemon = true; start() }
    }

    private fun buildTable(set: HrirSet): Table {
        val f = Fft(N)
        val re = Array(set.dirs) { Array(2) { FloatArray(bins) } }
        val im = Array(set.dirs) { Array(2) { FloatArray(bins) } }
        val bufR = FloatArray(N)
        val bufI = FloatArray(N)
        val taps = min(set.taps, N - WIN)
        for (d in 0 until set.dirs) for (e in 0..1) {
            bufR.fill(0f); bufI.fill(0f)
            System.arraycopy(set.data[d][e], 0, bufR, 0, taps)
            f.transform(bufR, bufI)
            System.arraycopy(bufR, 0, re[d][e], 0, bins)
            System.arraycopy(bufI, 0, im[d][e], 0, bins)
        }
        return Table(set.dirs, set.stepDeg, re, im)
    }

    // --- STFT 버퍼 ----------------------------------------------------------
    private val window = FloatArray(WIN) { (0.5 - 0.5 * cos(2 * PI * it / WIN)).toFloat() } // 주기 Hann (50% 겹침 합 = 1)
    private val inL = FloatArray(WIN)
    private val inR = FloatArray(WIN)
    private var inPos = WIN - HOP // 앞쪽은 0 으로 채운 상태에서 시작 → 첫 프레임까지 HOP 샘플
    private val olaL = FloatArray(N)
    private val olaR = FloatArray(N)
    private val outL = FloatArray(HOP)
    private val outR = FloatArray(HOP)
    private var outPos = 0

    private val xLr = FloatArray(N); private val xLi = FloatArray(N)
    private val xRr = FloatArray(N); private val xRi = FloatArray(N)
    private val yLr = FloatArray(N); private val yLi = FloatArray(N)
    private val yRr = FloatArray(N); private val yRi = FloatArray(N)

    // 정위 모드 통계 (주파수별, 프레임 간 평활)
    private val pLL = FloatArray(bins)
    private val pRR = FloatArray(bins)
    private val pLRr = FloatArray(bins)
    private val pLRi = FloatArray(bins)

    // 주변음(앰비언스) 성분 버퍼
    private val aLr = FloatArray(bins); private val aLi = FloatArray(bins)
    private val aRr = FloatArray(bins); private val aRi = FloatArray(bins)

    private val lowBin = (130.0 * N / fs).roundToInt() // 이 아래 저음은 방향 없이 가운데로 (펀치감 유지)

    /** 샘플 하나 입력 → [WIN] 샘플 전의 처리 결과를 out[0], out[1] 에 */
    fun process(l: Float, r: Float, out: FloatArray) {
        out[0] = outL[outPos]
        out[1] = outR[outPos]
        outPos++
        inL[inPos] = l
        inR[inPos] = r
        inPos++
        if (inPos == WIN) {
            frame()
            // 다음 프레임을 위해 반(HOP) 만큼 밀기
            System.arraycopy(inL, HOP, inL, 0, WIN - HOP)
            System.arraycopy(inR, HOP, inR, 0, WIN - HOP)
            inPos = WIN - HOP
            outPos = 0
        }
    }

    private fun dirIndex(t: Table, deg: Double): Int {
        var a = (deg - headYaw) % 360.0
        if (a < 0) a += 360.0
        return ((a / t.step).roundToInt()) % t.dirs
    }

    private fun frame() {
        val t = table
        for (i in 0 until N) {
            if (i < WIN) {
                xLr[i] = inL[i] * window[i]; xRr[i] = inR[i] * window[i]
            } else {
                xLr[i] = 0f; xRr[i] = 0f
            }
            xLi[i] = 0f; xRi[i] = 0f
        }
        fft.transform(xLr, xLi)
        fft.transform(xRr, xRi)

        yLr.fill(0f); yLi.fill(0f); yRr.fill(0f); yRi.fill(0f)
        if (mode == Mode.SPEAKERS) speakers(t) else localize(t)

        // 실수 신호 → 켤레 대칭 채우고 역변환
        for (k in 1 until N / 2) {
            yLr[N - k] = yLr[k]; yLi[N - k] = -yLi[k]
            yRr[N - k] = yRr[k]; yRi[N - k] = -yRi[k]
        }
        yLi[0] = 0f; yRi[0] = 0f; yLi[N / 2] = 0f; yRi[N / 2] = 0f
        fft.transform(yLr, yLi, inverse = true)
        fft.transform(yRr, yRi, inverse = true)

        // 겹쳐 더하기
        for (i in 0 until N) { olaL[i] += yLr[i]; olaR[i] += yRr[i] }
        System.arraycopy(olaL, 0, outL, 0, HOP)
        System.arraycopy(olaR, 0, outR, 0, HOP)
        System.arraycopy(olaL, HOP, olaL, 0, N - HOP); java.util.Arrays.fill(olaL, N - HOP, N, 0f)
        System.arraycopy(olaR, HOP, olaR, 0, N - HOP); java.util.Arrays.fill(olaR, N - HOP, N, 0f)
    }

    /** y += x · H(dir) · g · e^{-jωd} (d = 지연 샘플) */
    private fun addSource(t: Table, xr: FloatArray, xi: FloatArray, deg: Double, g: Float, delay: Int) {
        val d = dirIndex(t, deg)
        val hLr = t.re[d][0]; val hLi = t.im[d][0]
        val hRr = t.re[d][1]; val hRi = t.im[d][1]
        for (k in 0 until bins) {
            var ar = xr[k] * g
            var ai = xi[k] * g
            if (delay != 0) {
                val ph = -2.0 * PI * k * delay / N
                val c = cos(ph).toFloat(); val s = sin(ph).toFloat()
                val tr = ar * c - ai * s
                ai = ar * s + ai * c
                ar = tr
            }
            yLr[k] += ar * hLr[k] - ai * hLi[k]; yLi[k] += ar * hLi[k] + ai * hLr[k]
            yRr[k] += ar * hRr[k] - ai * hRi[k]; yRi[k] += ar * hRi[k] + ai * hRr[k]
        }
    }

    private fun speakers(t: Table) {
        val f = frontAngle
        addSource(t, xLr, xLi, -f, 1f, 0)
        addSource(t, xRr, xRi, f, 1f, 0)
        val rl = rearLevel.toFloat()
        if (rl > 0.001f) {
            val dly = (0.007 * fs).roundToInt()
            addSource(t, xLr, xLi, -rearAngle, rl, dly)
            addSource(t, xRr, xRi, rearAngle, rl, dly)
        }
    }

    private fun localize(t: Table) {
        val a = 0.55f // 프레임 간 평활
        val spr = spread
        val rl = rearLevel.toFloat()
        val ambDelay = (0.011 * fs).roundToInt()

        for (k in 0 until bins) {
            val lr = xLr[k]; val li = xLi[k]; val rr = xRr[k]; val ri = xRi[k]
            val ll = lr * lr + li * li
            val rrE = rr * rr + ri * ri
            pLL[k] = a * pLL[k] + (1 - a) * ll
            pRR[k] = a * pRR[k] + (1 - a) * rrE
            // L·conj(R)
            pLRr[k] = a * pLRr[k] + (1 - a) * (lr * rr + li * ri)
            pLRi[k] = a * pLRi[k] + (1 - a) * (li * rr - lr * ri)
            val tot = pLL[k] + pRR[k] + 1e-12f
            val coh = (sqrt(pLRr[k] * pLRr[k] + pLRi[k] * pLRi[k]) / sqrt(pLL[k] * pRR[k] + 1e-20f)).coerceIn(0f, 1f)
            // 한쪽에만 있는 소리는 상관이 낮아도 "방향이 뚜렷한 소리" → 직접음으로
            val side = abs(pRR[k] - pLL[k]) / tot
            val direct = max(coh, side)

            // 직접음: 에너지를 보존하는 합 (위상 정렬된 L+R)
            val sr = lr + rr; val si = li + ri
            val sumE = sr * sr + si * si
            val norm = if (sumE > 1e-20f) sqrt((ll + rrE) / sumE).coerceAtMost(2f) else 0f
            val dr = sr * norm * direct
            val di = si * norm * direct

            val pan = (pRR[k] - pLL[k]) / tot // -1 왼쪽 … +1 오른쪽
            val deg = if (k < lowBin) 0.0 else spr * pan
            val d = dirIndex(t, deg)
            val hL = t.re[d][0]; val hLi = t.im[d][0]; val hR = t.re[d][1]; val hRi = t.im[d][1]
            yLr[k] += dr * hL[k] - di * hLi[k]; yLi[k] += dr * hLi[k] + di * hL[k]
            yRr[k] += dr * hR[k] - di * hRi[k]; yRi[k] += dr * hRi[k] + di * hR[k]

            // 주변음 = 나머지
            val amb = 1f - direct
            aLr[k] = lr * amb; aLi[k] = li * amb
            aRr[k] = rr * amb; aRi[k] = ri * amb
        }
        // 주변음: 옆(±100°)과 뒤(±rear)에 나눠서 감싸는 느낌 (양은 rearLevel)
        val g = 0.55f + 0.9f * rl
        addSource(t, aLr, aLi, -100.0, g * 0.6f, 0)
        addSource(t, aRr, aRi, 100.0, g * 0.6f, 0)
        addSource(t, aLr, aLi, -rearAngle, g * 0.6f, ambDelay)
        addSource(t, aRr, aRi, rearAngle, g * 0.6f, ambDelay)
    }

    companion object {
        const val N = 2048
        const val WIN = 1024
        const val HOP = WIN / 2
        const val LATENCY = WIN
    }
}
