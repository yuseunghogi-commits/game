package com.spatialsound.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * 강력 3D 모드의 직접 계산 엔진 (폰 내장 이펙트를 쓰지 않음).
 *
 * 스테레오 음원을 "가상의 방 안에 놓인 스피커"로 바꾸고, 그 소리가 내 머리에 도달하는 과정을 계산한다.
 *
 *  ■ 머리 모델 (Brown & Duda 구조형 HRTF, 1998)
 *    - 양 귀 시간차(ITD): 머리 반지름 8.75cm 구 모델
 *    - 머리 그림자: 소리가 온 쪽 귀는 고음 +6dB, 반대쪽 귀는 고음 -20dB 까지 → 좌우가 또렷해짐
 *    - 귓바퀴 반사(pinna echo): 앞/뒤 구분 단서
 *  ■ 가상 스피커: 앞 L/R (±30°~±70°, '좌우 넓이'), 뒤 서라운드 ±110°
 *  ■ 가상의 방: 스피커마다 벽·바닥·천장 반사음 10개를 각자 도착 방향으로 HRTF 처리 (이미지 소스 근사)
 *  ■ 잔향: 8채널 FDN (Feedback Delay Network) — RT60 으로 방/홀 크기 조절
 *  ■ 저음 보강 + 리미터
 *
 * [process] 는 오디오 스레드 하나에서만 호출된다. [setParams] 는 아무 스레드에서나 호출 가능.
 */
class BinauralProcessor(private val fs: Int) {

    // --- 파라미터 ------------------------------------------------------------
    @Volatile private var pending: SpatialSettings? = null
    @Volatile var bypass = false

    private var amount = 0.8f   // 3D 강도 (드라이/웻)
    private var early = 0.45f   // 방 울림(반사음) 양
    private var bass = 0.25f
    private var width = 0.55f   // 좌우 넓이
    private var roomIdx = 2

    fun setParams(s: SpatialSettings) {
        pending = s
    }

    // --- 입력 지연선 ---------------------------------------------------------
    private val size = 1 shl 15 // 48kHz 기준 680ms
    private val mask = size - 1
    private val bufL = FloatArray(size)
    private val bufR = FloatArray(size)
    private val bufS = FloatArray(size)
    private var w = 0

    private fun samples(sec: Double) = (sec * fs).roundToInt()

    // --- 머리 모델 -----------------------------------------------------------
    private val headA = 0.0875      // 머리 반지름 (m)
    private val sound = 343.0       // 음속 (m/s)

    /** 한쪽 귀 처리 상태 */
    private class Ear {
        var itd = 0
        var b0 = 1f; var b1 = 0f; var a1 = 0f
        var x1 = 0f; var y1 = 0f
        var lp = 0f
        var pinnaDelay = IntArray(0)
        var pinnaGain = FloatArray(0)
    }

    /** 가상 음원 하나 (스피커 또는 벽 반사음) */
    private class Src(
        val input: Int,      // 0=L 1=R 2=S
        val baseDelay: Int,  // 샘플
        val gainL: Float,
        val gainR: Float,
        val lpCoef: Float,   // 벽 흡수/뒤쪽 어두움 (1 = 필터 없음)
        val left: Ear,
        val right: Ear,
    )

    private var sources: Array<Src> = emptyArray()

    /** 귀 기준 입사각 θ(0 = 귀 정면, π = 반대편)에 대한 귀 처리 계산 */
    private fun makeEar(thetaRaw: Double, pinna: Boolean, azimuthRad: Double): Ear {
        val theta = thetaRaw.coerceIn(0.0, PI)
        val e = Ear()
        // ITD: 귀 쪽에서 오면 0, 반대편이면 최대 (≈0.66ms)
        val t = if (theta < PI / 2) (headA / sound) * (1 - cos(theta))
        else (headA / sound) * (theta - PI / 2 + 1)
        e.itd = samples(t)

        // 머리 그림자 1극 1영점 필터 (쌍선형 변환)
        val alphaMin = 0.1
        val thetaMin = 150.0 / 180.0 * PI
        val alpha = (1 + alphaMin / 2) + (1 - alphaMin / 2) * cos(theta / thetaMin * PI)
        val beta = 2 * sound / headA
        val k = 2.0 * fs
        e.b0 = ((alpha * k + beta) / (k + beta)).toFloat()
        e.b1 = ((beta - alpha * k) / (k + beta)).toFloat()
        e.a1 = ((beta - k) / (k + beta)).toFloat()

        if (pinna) {
            // Brown & Duda 귓바퀴 반사 (44.1kHz 샘플 단위 → 현재 fs 로 환산), 고도 0°
            val rho = floatArrayOf(0.5f, -1f, 0.5f, -0.25f, 0.25f)
            val aK = doubleArrayOf(1.0, 5.0, 5.0, 5.0, 5.0)
            val bK = doubleArrayOf(2.0, 4.0, 7.0, 11.0, 13.0)
            val dK = doubleArrayOf(1.0, 0.5, 0.5, 0.5, 0.5)
            val az = abs(azimuthRad).coerceAtMost(PI)
            e.pinnaDelay = IntArray(5) {
                val tau = aK[it] * cos(az / 2) * sin(dK[it] * PI / 2) + bK[it]
                (tau * fs / 44100.0).roundToInt().coerceAtLeast(1)
            }
            e.pinnaGain = FloatArray(5) { rho[it] * PINNA_AMOUNT }
        }
        return e
    }

    private fun lpCoef(hz: Double) =
        if (hz <= 0) 1f else (1.0 - exp(-2.0 * PI * hz / fs)).toFloat().coerceAtMost(1f)

    /** 방위각(도, 0=정면, +=오른쪽)에 음원 하나 배치 */
    private fun place(input: Int, azDeg: Double, delaySec: Double, gain: Double, cutoffHz: Double, pinna: Boolean): Src {
        val az = azDeg / 180.0 * PI
        // 오른쪽 귀는 +90°, 왼쪽 귀는 -90° 방향
        val thR = angleBetween(az, PI / 2)
        val thL = angleBetween(az, -PI / 2)
        return Src(
            input = input,
            baseDelay = samples(delaySec),
            // 반대쪽 귀로 새는 소리를 줄여 좌우를 또렷하게 (정면/정후방 음원은 영향 없음)
            gainL = (gain * if (az > 0) contraMul(az) else 1.0).toFloat(),
            gainR = (gain * if (az < 0) contraMul(az) else 1.0).toFloat(),
            lpCoef = lpCoef(cutoffHz),
            left = makeEar(thL, pinna, az),
            right = makeEar(thR, pinna, az),
        )
    }

    /** 옆에 있는 음원일수록 반대쪽 귀 게인을 더 줄임 */
    private fun contraMul(az: Double) = 1.0 - (1.0 - contra) * abs(sin(az))
    private var contra = 0.3

    private fun angleBetween(a: Double, b: Double): Double {
        var d = abs(a - b) % (2 * PI)
        if (d > PI) d = 2 * PI - d
        return d
    }

    private fun rebuild() {
        val room = ROOMS[roomIdx.coerceIn(0, ROOMS.lastIndex)]
        val spk = 30.0 + 50.0 * width // 앞 스피커 각도 (±30° ~ ±80°)
        contra = 0.30 - 0.25 * width  // 반대쪽 귀 누설: 넓이 0% → -10dB, 100% → -26dB 추가 감쇠
        val list = mutableListOf<Src>()

        // 직접음: 앞 스피커
        list += place(0, -spk, 0.0, 1.0, 0.0, true)
        list += place(1, spk, 0.0, 1.0, 0.0, true)
        // 뒤 서라운드 ±110°: 왼쪽 소리는 왼쪽 뒤에서만, 오른쪽은 오른쪽 뒤에서만 (좌우가 섞이지 않게)
        // 7ms 지연으로 앞 스피커와 디코릴레이션 → 감싸는 느낌
        val sur = 0.30 + 0.30 * width
        list += place(0, -110.0, 0.007, sur, 7000.0, true)
        list += place(1, 110.0, 0.007, sur, 7000.0, true)

        // 방 반사음: 왼쪽 스피커 기준 (오른쪽은 좌우 대칭)
        if (early > 0.001f) {
            val scale = room.size
            val g = early * 1.15 / scale.pow(0.35)
            for (r in REFLECTIONS) {
                val az = if (r[0].isNaN()) -spk else r[0]
                val delay = r[1] / 1000.0 * scale
                list += place(0, az, delay, r[2] * g, r[3], false)
                list += place(1, -az, delay, r[2] * g, r[3], false)
            }
        }
        sources = list.toTypedArray()

        // 잔향 설정
        rt60 = room.rt60
        lateGain = (room.late * (0.4 + 0.6 * early)).toFloat()
        preDelay = samples(0.012 * room.size)
        revL.configure(room.size, 1.0)
        revR.configure(room.size, 1.037) // 길이를 살짝 달리해 좌우 잔향을 디코릴레이션

        // 대략적인 음량 보정 (나머지는 리미터가 처리)
        var energy = 2.0 + 2 * sur * sur
        if (early > 0.001f) {
            val g = early * 1.15 / room.size.pow(0.35)
            for (r in REFLECTIONS) energy += 2 * (r[2] * g) * (r[2] * g)
        }
        wetNorm = (1.0 / kotlin.math.sqrt(energy / 2.0)).toFloat() * 0.92f
    }

    // --- FDN 잔향 ------------------------------------------------------------
    /** 8채널 FDN 하나. 왼쪽 입력용/오른쪽 입력용 두 개를 써서 잔향도 좌우 방향을 유지한다. */
    private inner class Fdn {
        val lines = Array(FDN_N) { FloatArray(FDN_MAX) }
        val idx = IntArray(FDN_N)
        val len = IntArray(FDN_N) { 1000 }
        val g = FloatArray(FDN_N)
        val damp = FloatArray(FDN_N)
        var outA = 0f // 같은 쪽 귀
        var outB = 0f // 반대쪽 귀 (디코릴레이션된 출력)

        fun configure(size: Double, stretch: Double) {
            for (i in 0 until FDN_N) {
                len[i] = samples(FDN_MS[i] / 1000.0 * size * stretch).coerceIn(16, FDN_MAX - 1)
                g[i] = if (rt60 <= 0.0) 0f else 10.0.pow(-3.0 * len[i] / (fs * rt60)).toFloat()
                if (idx[i] >= len[i]) idx[i] = 0
            }
        }

        fun run(x: Float) {
            var sum = 0f
            for (i in 0 until FDN_N) {
                damp[i] += dampCoef * (lines[i][idx[i]] - damp[i])
                sum += damp[i]
            }
            val h = sum * (2f / FDN_N)
            var a = 0f
            var b = 0f
            for (i in 0 until FDN_N) {
                val inp = if (i and 1 == 0) x else -x
                lines[i][idx[i]] = inp * 0.9f + g[i] * (damp[i] - h)
                if (++idx[i] >= len[i]) idx[i] = 0
                a += damp[i] * OUT_L[i]
                b += damp[i] * OUT_R[i]
            }
            outA = a
            outB = b
        }
    }
    private lateinit var revL: Fdn
    private lateinit var revR: Fdn
    private val dampCoef = lpCoef(9000.0)
    private val revInLp = lpCoef(6000.0)
    private var revLpL = 0f
    private var revLpR = 0f
    private var rt60 = 0.0
    private var lateGain = 0f
    private var preDelay = 0
    private var wetNorm = 1f

    // --- 기타 ----------------------------------------------------------------
    private val aBass = lpCoef(130.0)
    private val aDc = lpCoef(15.0)
    private var lowL = 0f; private var lowR = 0f
    private var dcL = 0f; private var dcR = 0f
    private var limGain = 1f
    private val release = (1.0 - exp(-1.0 / (0.25 * fs))).toFloat()

    init {
        revL = Fdn()
        revR = Fdn()
        rebuild()
    }

    /** 인터리브 스테레오(L,R,L,R…) float 버퍼를 제자리에서 처리 */
    fun process(buf: FloatArray, frames: Int) {
        pending?.let { s ->
            pending = null
            amount = s.virtualizerStrength / 1000f
            early = s.spaceEq / 100f
            bass = s.bassStrength / 1000f
            width = s.width / 100f
            roomIdx = s.reverbPreset
            rebuild()
        }
        if (bypass) return

        val srcs = sources
        val wet = amount
        val dry = 1f - amount
        val gBass = 1.5f * bass
        val late = lateGain
        val hasLate = late > 0f && rt60 > 0.0

        var p = 0
        for (f in 0 until frames) {
            var l = buf[p]
            var r = buf[p + 1]
            dcL += aDc * (l - dcL); l -= dcL
            dcR += aDc * (r - dcR); r -= dcR

            // (Mid/Side 넓히기는 한쪽 소리를 반대쪽 채널로 새게 만들어서 쓰지 않음 —
            //  넓이는 가상 스피커 각도로만 조절)
            bufL[w] = l
            bufR[w] = r
            bufS[w] = (l - r) * 0.5f

            var outL = 0f
            var outR = 0f
            for (src in srcs) {
                val b = when (src.input) { 0 -> bufL; 1 -> bufR; else -> bufS }
                outL += src.gainL * ear(src.left, b, src.baseDelay, src.lpCoef)
                outR += src.gainR * ear(src.right, b, src.baseDelay, src.lpCoef)
            }

            // 잔향: 왼쪽 소리의 잔향은 주로 왼쪽 귀에, 오른쪽은 오른쪽에 (반대쪽은 REV_CROSS 만큼)
            if (hasLate) {
                val di = (w - preDelay) and mask
                revLpL += revInLp * (bufL[di] - revLpL)
                revLpR += revInLp * (bufR[di] - revLpR)
                revL.run(revLpL)
                revR.run(revLpR)
                outL += late * 0.6f * (revL.outA + REV_CROSS * revR.outB)
                outR += late * 0.6f * (revR.outA + REV_CROSS * revL.outB)
            }

            outL = dry * l + wet * wetNorm * outL
            outR = dry * r + wet * wetNorm * outR

            // 저음 보강
            lowL += aBass * (l - lowL)
            lowR += aBass * (r - lowR)
            outL += gBass * lowL
            outR += gBass * lowR

            // 리미터: 즉시 어택, 250ms 릴리즈
            val peak = maxOf(abs(outL), abs(outR))
            if (peak * limGain > 0.97f) limGain = 0.97f / peak
            else limGain += (1f - limGain) * release
            buf[p] = (outL * limGain).coerceIn(-1f, 1f)
            buf[p + 1] = (outR * limGain).coerceIn(-1f, 1f)

            p += 2
            w = (w + 1) and mask
        }
    }

    private fun ear(e: Ear, b: FloatArray, base: Int, lpc: Float): Float {
        val n0 = w - base - e.itd
        var x = b[n0 and mask]
        val pd = e.pinnaDelay
        for (k in pd.indices) x += e.pinnaGain[k] * b[(n0 - pd[k]) and mask]
        if (lpc < 1f) {
            e.lp += lpc * (x - e.lp)
            x = e.lp
        }
        val y = e.b0 * x + e.b1 * e.x1 - e.a1 * e.y1
        e.x1 = x
        e.y1 = y
        return y
    }

    private class Room(val size: Double, val rt60: Double, val late: Double)

    companion object {
        private const val PINNA_AMOUNT = 0.35f
        private const val FDN_N = 8
        private const val REV_CROSS = 0.15f
        private const val FDN_MAX = 1 shl 13
        private val FDN_MS = doubleArrayOf(29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1)
        private val OUT_L = floatArrayOf(1f, -1f, 1f, 1f, -1f, 1f, -1f, -1f)
        private val OUT_R = floatArrayOf(1f, 1f, -1f, 1f, 1f, -1f, -1f, 1f)

        /** REVERB_NAMES 와 같은 순서: 없음, 작은 방, 중간 방, 큰 방, 중간 홀, 큰 홀, 플레이트 */
        private val ROOMS = arrayOf(
            Room(0.8, 0.0, 0.0),
            Room(0.7, 0.4, 0.6),
            Room(1.0, 0.7, 0.75),
            Room(1.4, 1.0, 0.85),
            Room(2.0, 1.6, 0.95),
            Room(2.8, 2.4, 1.05),
            Room(1.2, 1.5, 1.0),
        )

        /**
         * 왼쪽 스피커 기준 반사음: [방위각(도, NaN=스피커와 같은 방향), 지연(ms), 게인, 벽 흡수 차단주파수(Hz)]
         * 청취자가 방 가운데 있는 직육면체 방을 근사.
         */
        private val REFLECTIONS = arrayOf(
            doubleArrayOf(Double.NaN, 3.4, 0.30, 5000.0), // 바닥 (너무 크면 음색이 뭉개짐)
            doubleArrayOf(-90.0, 4.0, 0.55, 8000.0),      // 왼쪽 벽
            doubleArrayOf(Double.NaN, 6.5, 0.38, 7000.0), // 천장
            doubleArrayOf(-20.0, 7.8, 0.35, 6000.0),      // 앞 벽
            doubleArrayOf(70.0, 9.5, 0.10, 6000.0),       // 오른쪽 벽 (반대편은 약하게)
            doubleArrayOf(-150.0, 13.0, 0.40, 5000.0),    // 뒷벽 (왼쪽 뒤)
            doubleArrayOf(-60.0, 16.0, 0.30, 4500.0),     // 2차 반사 (같은 쪽 위주)
            doubleArrayOf(-115.0, 22.0, 0.28, 4000.0),
            doubleArrayOf(150.0, 26.0, 0.06, 3500.0),
            doubleArrayOf(-170.0, 31.0, 0.22, 3000.0),
        )
    }
}
