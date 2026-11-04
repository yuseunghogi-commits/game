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
 *  ■ 가상 스피커: 앞 L/R (±각도), 뒤 서라운드 (±각도)
 *  ■ 가상의 방: 스피커마다 벽·바닥·천장 반사음을 각자 도착 방향으로 HRTF 처리
 *  ■ 잔향: 8채널 FDN (Feedback Delay Network) — RT60 으로 방/홀 크기 조절
 *
 * 실측 모드(공간/정위)에서는 직접음을 HrtfRenderer(실측 HRTF, 7 스피커 업믹스)가 맡고,
 * 방은 RoomModel(직육면체 방 거울상 반사 1·2차) + FDN 잔향을 8개 방향 버스로 모아
 * 역시 실측 HRTF 로 렌더링한다 → 방 전체가 실제 귀 특성을 거쳐 들린다.
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
    private var frontAngle = 50.0 // 앞 스피커 각도 (±도)
    private var rearAngle = 120.0 // 뒤 스피커 각도 (±도)
    private var rearLevel = 0.5   // 뒤 스피커 소리 양
    private var engineMode = 0    // 0 = 기본(모델), 1 = 공간(실측 HRTF), 2 = 정위
    private var spreadDeg = 90.0
    private var earSize = 2
    /** 헤드폰 보정 (null = 끔) */
    private var hpEq: HeadphoneEq.Chain? = null
    private var hpEqIdx = 0
    private var centerLevel = 0.7

    // --- 실측 모드의 방: 반사음 탭 + 방향 버스 --------------------------------
    private var roomTaps: RoomModel.Taps? = null
    private val bus = FloatArray(HrtfRenderer.NB)
    private var roomNorm = 1f

    // --- 실측 HRTF 렌더러 (모드 1, 2) ----------------------------------------
    @Volatile private var renderer: HrtfRenderer? = null
    private var rendererLoading = false
    private val rOut = FloatArray(2)
    /** 실측 렌더러를 쓰는 중이면 그 지연만큼 나머지 경로(반사음·잔향·원음)도 늦춰서 맞춘다 */
    private var latency = 0

    private fun ensureRenderer() {
        if (engineMode == 0 || renderer != null || rendererLoading) return
        val base = hrirBase ?: return
        rendererLoading = true
        Thread({
            val ev = elevBase?.also { it.prepare() }
            renderer = HrtfRenderer(fs, base, ev)
            rendererLoading = false
        }, "hrtf-init").apply { isDaemon = true; start() }
    }

    fun setParams(s: SpatialSettings) {
        pending = s
    }

    /**
     * 헤드 트래킹: 머리가 정면에서 돌아간 각도(도, 오른쪽 +).
     * 가상 스피커/반사음을 반대로 돌려서 소리가 공간에 고정돼 들리게 한다. 아무 스레드에서나 설정 가능.
     */
    @Volatile var headYawDeg = 0.0
    /** 헤드 트래킹 위아래 각도 (도, 위 +) — 실측 모드에서만 반영 */
    @Volatile var headPitchDeg = 0.0
    private var frontElev = 0.0
    private var heightLevel = 0.0
    private var topAz = HrtfRenderer.HEIGHT_AZ
    private var topEl = HrtfRenderer.HEIGHT_EL
    private var topRearAz = HrtfRenderer.TOP_REAR_AZ
    private var topRearEl = HrtfRenderer.TOP_REAR_EL
    private var bottomLevel = 0.0
    private var bottomAz = HrtfRenderer.BOTTOM_AZ
    private var bottomEl = HrtfRenderer.BOTTOM_EL
    private var enhance = 0.0
    /** 음색 보정 세기 0..1 (HrtfRenderer.timbre) */
    private var timbre = HrtfRenderer.DEFAULT_TIMBRE
    /** 스침 효과 0..1 (HrtfRenderer.near) */
    private var near = 0.0

    private var appliedYaw = 0.0
    private var oldSources: Array<Src>? = null
    private var fadePos = 0
    private val fadeLen = samples(0.03)

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
        // 머리가 오른쪽으로 돌면 소리는 머리 기준으로 왼쪽으로 이동
        var rel = (azDeg - appliedYaw) % 360.0
        if (rel > 180) rel -= 360.0
        if (rel < -180) rel += 360.0
        val az = rel / 180.0 * PI
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

    /** 음원 배치를 새로 만들고, 이전 배치에서 30ms 동안 부드럽게 넘어간다 (딸깍 소리 방지) */
    private fun rebuildWithFade() {
        val old = sources
        rebuild()
        if (old.isNotEmpty()) {
            oldSources = old
            fadePos = 0
        }
    }

    private fun rebuild() {
        val room = ROOMS[roomIdx.coerceIn(0, ROOMS.lastIndex)]
        val spk = frontAngle          // 앞 스피커 각도 (사용자가 직접 배치)
        contra = 0.30 - 0.25 * width  // 좌우 분리: 반대쪽 귀 누설 0% → -10dB, 100% → -26dB 추가 감쇠
        val list = mutableListOf<Src>()

        val lat = latency / fs.toDouble()
        val useHrtf = latency > 0
        // 직접음: 앞 스피커 (실측 모드에선 HrtfRenderer 가 담당)
        if (!useHrtf) {
            list += place(0, -spk, 0.0, 1.0, 0.0, true)
            list += place(1, spk, 0.0, 1.0, 0.0, true)
        }
        // 뒤 서라운드 (±rearAngle): 왼쪽 소리는 왼쪽 뒤에서만, 오른쪽은 오른쪽 뒤에서만 (좌우가 섞이지 않게)
        // 7ms 지연으로 앞 스피커와 디코릴레이션 → 감싸는 느낌
        val sur = rearLevel
        if (sur > 0.001 && !useHrtf) {
            list += place(0, -rearAngle, 0.007, sur, 7000.0, true)
            list += place(1, rearAngle, 0.007, sur, 7000.0, true)
        }

        // 방 반사음
        //  - 실측 모드: 직육면체 방 거울상 모델 → 방향 버스 → 실측 HRTF (아래 roomTaps)
        //  - 기본 모드: 왼쪽 스피커 기준 반사음 표 (오른쪽은 좌우 대칭), 구 모양 머리 모델
        val modeRoom = if (engineMode == 2) 0.5 else 1.0
        roomTaps = if (useHrtf && early > 0.001f) RoomModel.build(fs, spk, roomIdx, early * 1.1 * modeRoom) else null
        if (early > 0.001f && !useHrtf) {
            val scale = room.size
            // 정위 모드는 방향이 흐려지지 않게 반사음을 절반으로
            val g = early * 1.15 / scale.pow(0.35) * (if (engineMode == 2) 0.5 else 1.0)
            for (r in REFLECTIONS) {
                val az = if (r[0].isNaN()) -spk else r[0]
                val delay = r[1] / 1000.0 * scale + lat
                list += place(0, az, delay, r[2] * g, r[3], false)
                list += place(1, -az, delay, r[2] * g, r[3], false)
            }
        }
        sources = list.toTypedArray()

        // 잔향 설정
        rt60 = room.rt60
        lateGain = (room.late * (0.4 + 0.6 * early) * (if (engineMode == 2) 0.5 else 1.0) * LATE_SCALE).toFloat()
        // 실측 모드는 잔향도 렌더러(지연 LATENCY)를 거치므로 따로 늦출 필요 없음
        preDelay = samples(0.012 * room.size) + (if (useHrtf) 0 else latency)
        revL.configure(room.size, 1.0)
        revR.configure(room.size, 1.037) // 길이를 살짝 달리해 좌우 잔향을 디코릴레이션

        // 대략적인 음량 보정 (나머지는 리미터가 처리)
        var energy = 2.0 + 2 * sur * sur
        if (early > 0.001f) {
            val g = early * 1.15 / room.size.pow(0.35)
            for (r in REFLECTIONS) energy += 2 * (r[2] * g) * (r[2] * g)
        }
        wetNorm = (1.0 / kotlin.math.sqrt(energy / 2.0)).toFloat() * 0.92f

        // 실측 모드 음량 보정: 직접음 1 + 반사음 에너지 + 잔향 에너지(대략)
        val lateE = if (rt60 > 0.0) (lateGain * 0.6).pow(2) * 2.5 * rt60 else 0.0
        // 모드별 기준 음량 보정 (측정값: 공간 모드는 가운데·옆 스피커가 더해져 약 2dB 큼) → 원음과 비슷한 크기
        val trim = if (engineMode == 1) 0.57 else 0.72
        roomNorm = (trim / kotlin.math.sqrt(1.0 + (roomTaps?.energy ?: 0.0) + lateE)).toFloat()
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
    // 잔향으로 보내는 소리에서 저음을 뺌 (2단 1차 고역통과): 킥·베이스의 잔향 꼬리가 리듬과 배경음악을 뭉개지 않게
    private val revHp = lpCoef(REV_HP_HZ)
    private var revH1L = 0f; private var revH2L = 0f; private var revH1R = 0f; private var revH2R = 0f

    /** 잔향 입력: 6kHz 저역통과 + 300Hz 고역통과 (2단) */
    private fun revInput(xl: Float, xr: Float) {
        revLpL += revInLp * (xl - revLpL)
        revLpR += revInLp * (xr - revLpR)
        var l = revLpL; var r = revLpR
        revH1L += revHp * (l - revH1L); l -= revH1L
        revH2L += revHp * (l - revH2L); l -= revH2L
        revH1R += revHp * (r - revH1R); r -= revH1R
        revH2R += revHp * (r - revH2R); r -= revH2R
        revL.run(l)
        revR.run(r)
    }
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
            frontAngle = s.frontAngle.toDouble().coerceIn(0.0, 90.0)
            rearAngle = s.rearAngle.toDouble().coerceIn(90.0, 180.0)
            rearLevel = s.rearLevel / 100.0
            engineMode = s.engineMode
            spreadDeg = s.spread.toDouble()
            centerLevel = s.centerLevel / 100.0
            frontElev = s.frontElev.toDouble().coerceIn(-30.0, 45.0)
            heightLevel = s.heightLevel / 100.0
            topAz = s.topAngle.toDouble().coerceIn(0.0, 90.0)
            topEl = s.topElev.toDouble().coerceIn(25.0, 89.0)
            topRearAz = s.topRearAngle.toDouble().coerceIn(90.0, 180.0)
            topRearEl = s.topRearElev.toDouble().coerceIn(25.0, 89.0)
            bottomLevel = s.bottomLevel / 100.0
            bottomAz = s.bottomAngle.toDouble().coerceIn(0.0, 180.0)
            bottomEl = s.bottomElev.toDouble().coerceIn(-45.0, -5.0)
            enhance = s.enhance / 100.0
            timbre = s.timbre / 100.0
            near = s.near / 100.0
            earSize = s.earSize
            if (s.hpEq != hpEqIdx) {
                hpEqIdx = s.hpEq
                hpEq = HeadphoneEq.profiles.getOrNull(s.hpEq - 1)?.let { HeadphoneEq.Chain(it, fs) }
            }
            renderer?.setEarSize(earSize)
            renderer?.setEnhance(enhance)
            ensureRenderer()
            rebuildWithFade()
        }
        // 헤드 트래킹: 1.5° 이상 움직였고 이전 전환이 끝났으면 새 각도로
        val yaw = headYawDeg
        if (latency == 0 && oldSources == null && abs(yaw - appliedYaw) >= 1.5) {
            appliedYaw = yaw
            rebuildWithFade()
        }
        // 실측 렌더러 준비/해제 반영
        val rnd = if (engineMode != 0) renderer else null
        val wantLatency = if (rnd != null) HrtfRenderer.LATENCY else 0
        if (wantLatency != latency) {
            latency = wantLatency
            rnd?.setEarSize(earSize)
            rnd?.setEnhance(enhance)
            rebuild()
            oldSources = null
        }
        rnd?.let {
            it.mode = if (engineMode == 2) HrtfRenderer.Mode.LOCALIZE else HrtfRenderer.Mode.SPEAKERS
            it.frontAngle = frontAngle
            it.rearAngle = rearAngle
            it.rearLevel = rearLevel
            it.centerLevel = centerLevel
            it.frontElev = frontElev
            it.heightLevel = heightLevel
            it.topAz = topAz
            it.topEl = topEl
            it.topRearAz = topRearAz
            it.topRearEl = topRearEl
            it.bottomLevel = bottomLevel
            it.bottomAz = bottomAz
            it.bottomEl = bottomEl
            it.headPitch = headPitchDeg
            it.spread = spreadDeg
            it.headYaw = headYawDeg
            it.lowGain = 1.0 / roomNorm
            it.bassBoost = 1.5 * bass.toDouble()
            it.timbre = timbre
            it.near = near
        }
        if (bypass) return

        val srcs = sources
        val lat = latency
        val eq = hpEq
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
            if (rnd != null) {
                // ── 실측 모드: 방(반사음 + 잔향)을 방향 버스에 모아서 직접음과 함께 렌더러로 ──
                java.util.Arrays.fill(bus, 0f)
                val tp = roomTaps
                if (tp != null) {
                    for (i in 0 until tp.n) {
                        val src = if (tp.input[i] == 0) bufL else bufR
                        val x = src[(w - tp.delay[i]) and mask]
                        tp.lp[i] += tp.lpc[i] * (x - tp.lp[i])
                        val v = tp.lp[i] * tp.gain[i]
                        bus[tp.busA[i]] += v * tp.wA[i]
                        bus[tp.busB[i]] += v * tp.wB[i]
                    }
                }
                if (hasLate) {
                    val di = (w - preDelay) and mask
                    revInput(bufL[di], bufR[di])
                    // 왼쪽 소리의 잔향은 왼쪽 반공간(왼앞·왼옆·왼뒤 + 정면·정후방)에서, 오른쪽은 오른쪽에서
                    val g = late * 0.6f
                    for (i in 0 until FDN_N) {
                        bus[LATE_BUS_L[i]] += g * LATE_SIGN[i] * revL.damp[i]
                        bus[LATE_BUS_R[i]] += g * LATE_SIGN[i] * revR.damp[i]
                    }
                }
                // 직접음 + 방 — LATENCY 만큼 늦게 나옴. 원음(드라이)·저음 경로도 같은 만큼 늦춘 입력을 씀.
                rnd.process(l, r, bus, rOut)
                val di = (w - lat) and mask
                l = bufL[di]
                r = bufR[di]
                val rn = roomNorm
                outL = dry * l + wet * rn * rOut[0]
                outR = dry * r + wet * rn * rOut[1]
            } else {
                for (src in srcs) {
                    val b = when (src.input) { 0 -> bufL; 1 -> bufR; else -> bufS }
                    outL += src.gainL * ear(src.left, b, src.baseDelay, src.lpCoef)
                    outR += src.gainR * ear(src.right, b, src.baseDelay, src.lpCoef)
                }
                val olds = oldSources
                if (olds != null) {
                    var oL = 0f
                    var oR = 0f
                    for (src in olds) {
                        val b = when (src.input) { 0 -> bufL; 1 -> bufR; else -> bufS }
                        oL += src.gainL * ear(src.left, b, src.baseDelay, src.lpCoef)
                        oR += src.gainR * ear(src.right, b, src.baseDelay, src.lpCoef)
                    }
                    val t = fadePos.toFloat() / fadeLen
                    outL = oL + (outL - oL) * t
                    outR = oR + (outR - oR) * t
                    if (++fadePos >= fadeLen) oldSources = null
                }

                // 잔향: 왼쪽 소리의 잔향은 주로 왼쪽 귀에, 오른쪽은 오른쪽에 (반대쪽은 REV_CROSS 만큼)
                if (hasLate) {
                    val di = (w - preDelay) and mask
                    revInput(bufL[di], bufR[di])
                    outL += late * 0.6f * (revL.outA + REV_CROSS * revR.outB)
                    outR += late * 0.6f * (revR.outA + REV_CROSS * revL.outB)
                }

                outL = dry * l + wet * wetNorm * outL
                outR = dry * r + wet * wetNorm * outR
            }

            // 저음 보강 — 실측 엔진은 렌더러 안에서 같은 위상으로 (HrtfRenderer.applyBass)
            if (rnd == null) {
                lowL += aBass * (l - lowL)
                lowR += aBass * (r - lowR)
                outL += gBass * lowL
                outR += gBass * lowR
            }

            // 헤드폰 보정 (헤드폰 고유 음색 상쇄)
            eq?.let {
                outL = it.process(outL, 0)
                outR = it.process(outR, 1)
            }

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
        /**
         * 잔향으로 보내는 소리의 저음 컷(Hz)과 긴 잔향 배율.
         * 측정: 저음 잔향 꼬리가 킥·베이스를 뭉개서 125Hz 대역 리듬 보존이 0.50 까지 떨어지고,
         * 긴 잔향이 1~2kHz 를 흐리게 만듦 → 300Hz 컷 + 60% 로 배경음악 리듬 보존 0.71 → 0.84 (넓은 느낌 IACC 는 거의 그대로).
         */
        private const val REV_HP_HZ = 300.0
        private const val LATE_SCALE = 0.6

        /** 실측 HRIR 데이터 — 앱 시작 시 한 번 불러서 넣어 둔다 (없으면 실측 모드는 기본 모드로 동작) */
        @Volatile var hrirBase: HrirSet? = null
        /** 높이(위아래) 단서 데이터 — 없으면 높이 기능만 빠지고 나머지는 그대로 동작 */
        @Volatile var elevBase: ElevationSet? = null

        private const val PINNA_AMOUNT = 0.35f
        private const val FDN_N = 8
        private const val REV_CROSS = 0.15f
        private const val FDN_MAX = 1 shl 13
        private val FDN_MS = doubleArrayOf(29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1)
        private val OUT_L = floatArrayOf(1f, -1f, 1f, 1f, -1f, 1f, -1f, -1f)
        private val OUT_R = floatArrayOf(1f, 1f, -1f, 1f, 1f, -1f, -1f, 1f)
        // 실측 모드 잔향 → 방향 버스 (버스 i = i×45°: 0 정면, 2 오른쪽, 4 정후방, 6 왼쪽)
        private val LATE_BUS_L = intArrayOf(7, 6, 5, 7, 6, 5, 0, 4)
        private val LATE_BUS_R = intArrayOf(1, 2, 3, 1, 2, 3, 0, 4)
        private val LATE_SIGN = floatArrayOf(1f, 1f, 1f, -1f, -1f, -1f, 1f, -1f)

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
