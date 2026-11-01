package com.spatialsound.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.roundToInt

/**
 * 강력 3D 모드의 직접 계산 엔진 (폰 내장 이펙트를 쓰지 않음).
 *
 * 스테레오 입력을 "머리 바깥에 놓인 가상 스피커"로 바꿔 양쪽 귀 신호를 계산한다.
 *
 *  1. 앞쪽 가상 스피커(±30°)  : 반대쪽 귀로 넘어가는 소리를 시간차(ITD)·머리 그림자(저역통과)로 재현
 *  2. 뒤/옆 가상 스피커(±110°): 좌우 차이(사이드) 성분을 뒤쪽에서 들리게 배치 → 감싸는 느낌
 *  3. 초기 반사음              : 벽에서 튕겨 오는 소리 → 소리가 머릿속이 아니라 바깥에서 들림
 *  4. 잔향(경량 Freeverb)      : 방/홀 크기
 *  5. 저음 보강 + 리미터       : 음량이 커져도 찢어지지 않게
 *
 * 모든 계산은 오디오 스레드 하나에서만 호출된다. 파라미터는 [setParams]로 언제든 바꿀 수 있다.
 */
class BinauralProcessor(private val fs: Int) {

    // --- 파라미터 (0..1) -----------------------------------------------------
    @Volatile private var amount = 0.8f   // 3D 강도
    @Volatile private var room = 0.4f     // 공간감(반사음)
    @Volatile private var bass = 0.3f     // 저음
    @Volatile private var reverbSize = 0f // 잔향 크기 (0 = 없음)
    @Volatile var bypass = false

    fun setParams(s: SpatialSettings) {
        amount = s.virtualizerStrength / 1000f
        room = s.spaceEq / 100f
        bass = s.bassStrength / 1000f
        reverbSize = s.reverbPreset / (REVERB_NAMES.size - 1).toFloat()
    }

    // --- 지연선 --------------------------------------------------------------
    private val size = 1 shl 14 // 48kHz 기준 약 340ms
    private val mask = size - 1
    private val bufL = FloatArray(size)
    private val bufR = FloatArray(size)
    private val bufS = FloatArray(size) // 사이드(L-R) 성분
    private val bufM = FloatArray(size) // 반사음 입력 (저역통과된 L/R)
    private val bufM2 = FloatArray(size)
    private var w = 0

    private fun ms(x: Double) = (x / 1000.0 * fs).roundToInt()

    // 앞 스피커 ±30°: 반대쪽 귀 지연 ≈ 0.27ms
    private val dFront = ms(0.27)
    // 뒤 스피커 ±110°: 사이드 성분을 12ms 늦게(디코릴레이션), 반대쪽 귀 지연 ≈ 0.62ms
    private val dRear = ms(12.0)
    private val dRearContra = ms(0.62)

    // 초기 반사음 (지연ms, 왼귀 게인, 오른귀 게인, 원천: 0=L 1=R)
    private val taps = arrayOf(
        doubleArrayOf(6.3, 0.55, 0.25, 0.0),
        doubleArrayOf(8.9, 0.22, 0.50, 1.0),
        doubleArrayOf(13.7, 0.40, 0.18, 1.0),
        doubleArrayOf(17.1, 0.16, 0.42, 0.0),
        doubleArrayOf(22.9, 0.30, 0.12, 0.0),
        doubleArrayOf(27.4, 0.10, 0.28, 1.0),
        doubleArrayOf(34.1, 0.18, 0.08, 1.0),
        doubleArrayOf(41.6, 0.07, 0.16, 0.0),
    )
    private val tapDelay = IntArray(taps.size) { ms(taps[it][0]) }
    private val tapGL = FloatArray(taps.size) { taps[it][1].toFloat() }
    private val tapGR = FloatArray(taps.size) { taps[it][2].toFloat() }
    private val tapFromL = BooleanArray(taps.size) { taps[it][3] == 0.0 }

    // --- 1차 필터 상태 -------------------------------------------------------
    private fun coef(hz: Double) = (1.0 - exp(-2.0 * PI * hz / fs)).toFloat()
    private val aShadow = coef(1400.0)   // 앞 스피커 머리 그림자
    private val aRearIpsi = coef(5000.0) // 뒤쪽 소리는 귓바퀴 때문에 고음이 줄어듦
    private val aRearContra = coef(800.0)
    private val aRefl = coef(4500.0)     // 반사음은 벽에 흡수돼 어두워짐
    private val aBass = coef(140.0)
    private val aDc = coef(20.0)

    private var shL = 0f; private var shR = 0f
    private var riL = 0f; private var riR = 0f
    private var rcL = 0f; private var rcR = 0f
    private var rfL = 0f; private var rfR = 0f
    private var lowL = 0f; private var lowR = 0f
    private var dcL = 0f; private var dcR = 0f
    private var limGain = 1f

    // --- 경량 Freeverb ------------------------------------------------------
    private inner class Comb(len: Int) {
        val b = FloatArray(len); var i = 0; var store = 0f
        fun run(x: Float, fb: Float, damp: Float): Float {
            val y = b[i]
            store = y * (1 - damp) + store * damp
            b[i] = x + store * fb
            if (++i >= b.size) i = 0
            return y
        }
    }
    private inner class Allpass(len: Int) {
        val b = FloatArray(len); var i = 0
        fun run(x: Float): Float {
            val bo = b[i]
            val y = -x + bo
            b[i] = x + bo * 0.5f
            if (++i >= b.size) i = 0
            return y
        }
    }
    private fun sc(n: Int) = (n * fs / 44100.0).roundToInt().coerceAtLeast(8)
    private val combL = intArrayOf(1116, 1188, 1277, 1356).map { Comb(sc(it)) }
    private val combR = intArrayOf(1116, 1188, 1277, 1356).map { Comb(sc(it + 23)) }
    private val apL = intArrayOf(556, 441).map { Allpass(sc(it)) }
    private val apR = intArrayOf(556, 441).map { Allpass(sc(it + 23)) }

    /** 인터리브 스테레오(L,R,L,R…) float 버퍼를 제자리에서 처리 */
    fun process(buf: FloatArray, frames: Int) {
        if (bypass) return
        val amt = amount
        val rm = room
        val bs = bass
        val rv = reverbSize

        val gFrontContra = 0.62f * amt
        val gRear = 0.55f * amt
        val gRefl = 0.45f * rm
        val gRev = 0.22f * rv
        val fb = 0.70f + 0.26f * rv
        val damp = 0.35f
        val gBass = 1.6f * bs
        // 크로스피드로 커진 음량을 대략 보정
        val norm = 1f / (1f + gFrontContra * 0.5f + gRear * 0.3f + gRefl * 0.5f + gRev * 0.6f + gBass * 0.25f)

        var p = 0
        for (f in 0 until frames) {
            var l = buf[p]
            var r = buf[p + 1]

            // DC 제거 (직류 성분이 쌓여 리미터를 망치지 않게)
            dcL += aDc * (l - dcL); l -= dcL
            dcR += aDc * (r - dcR); r -= dcR

            bufL[w] = l
            bufR[w] = r
            bufS[w] = (l - r) * 0.5f

            // 1) 앞 가상 스피커: 반대쪽 채널을 늦게 + 어둡게 섞음
            val cl = bufR[(w - dFront) and mask]
            val cr = bufL[(w - dFront) and mask]
            shL += aShadow * (cl - shL)
            shR += aShadow * (cr - shR)
            var outL = l + gFrontContra * shL
            var outR = r + gFrontContra * shR

            // 2) 뒤/옆 가상 스피커: 사이드 성분 (왼쪽 뒤 = +S, 오른쪽 뒤 = -S)
            val sNear = bufS[(w - dRear) and mask]
            val sFar = bufS[(w - dRear - dRearContra) and mask]
            riL += aRearIpsi * (sNear - riL)
            riR += aRearIpsi * (-sNear - riR)
            rcL += aRearContra * (-sFar - rcL) // 오른쪽 뒤 스피커가 왼쪽 귀로
            rcR += aRearContra * (sFar - rcR)
            outL += gRear * (riL + 0.45f * rcL)
            outR += gRear * (riR + 0.45f * rcR)

            // 3) 초기 반사음
            rfL += aRefl * (l - rfL)
            rfR += aRefl * (r - rfR)
            bufM[w] = rfL
            bufM2[w] = rfR
            if (gRefl > 0f) {
                var eL = 0f; var eR = 0f
                for (t in tapDelay.indices) {
                    val src = if (tapFromL[t]) bufM else bufM2
                    val x = src[(w - tapDelay[t]) and mask]
                    eL += x * tapGL[t]
                    eR += x * tapGR[t]
                }
                outL += gRefl * eL
                outR += gRefl * eR
            }

            // 4) 잔향
            if (gRev > 0f) {
                val inp = (rfL + rfR) * 0.015f
                var yl = 0f; var yr = 0f
                for (c in combL) yl += c.run(inp, fb, damp)
                for (c in combR) yr += c.run(inp, fb, damp)
                for (a in apL) yl = a.run(yl)
                for (a in apR) yr = a.run(yr)
                outL += gRev * yl
                outR += gRev * yr
            }

            // 5) 저음 보강 (저역만 뽑아서 더함)
            lowL += aBass * (l - lowL)
            lowR += aBass * (r - lowR)
            outL += gBass * lowL
            outR += gBass * lowR

            outL *= norm
            outR *= norm

            // 리미터: 빠른 어택, 느린 릴리즈
            val peak = maxOf(abs(outL), abs(outR))
            val target = if (peak * limGain > 0.95f) 0.95f / peak else 1f
            limGain = if (target < limGain) target else limGain + (1f - limGain) * 0.0005f
            outL *= limGain
            outR *= limGain

            buf[p] = outL.coerceIn(-1f, 1f)
            buf[p + 1] = outR.coerceIn(-1f, 1f)
            p += 2
            w = (w + 1) and mask
        }
    }
}
