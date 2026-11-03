package com.spatialsound.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 실측 HRTF 렌더러 (주파수 영역, STFT 50% 겹침, 제로패딩 → 고정 필터는 선형 컨볼루션과 동일).
 *
 *  ■ SPEAKERS (공간 모드 · 실측) — 7개 가상 스피커
 *      앞 왼쪽/오른쪽(±front) + 가운데(0°) + 옆(±95°) + 뒤(±rear)
 *      주파수 성분마다 ① 직접음/배경음 분리 ② 가운데 성분 추출을 해서
 *      보컬·대사 같은 가운데 소리는 가운데 스피커로, 박수·관중·울림 같은 배경음은 옆/뒤 스피커로 보낸다.
 *      (예전처럼 앞 소리의 복사본을 뒤로 보내지 않아서 소리가 뒤로 끌려가거나 탁해지지 않음)
 *
 *  ■ LOCALIZE (정위 모드) — 성분마다 스테레오 위치에 맞는 정확한 방향(±spread°)에 하나씩 배치,
 *      배경음은 옆/뒤로 분리.
 *
 *  ■ 방 버스 — 벽 반사음과 잔향을 45° 간격 8방향으로 받아 실측 HRTF 로 들려준다 (BinauralProcessor 가 채움).
 *
 *  ■ 위·아래 — 배경음 일부를 천장 스피커 4개(앞 2·뒤 2)와 바닥 스피커 2개로.
 *
 *  ■ 3D 강조 — 같은 좌우 각도의 앞/뒤 짝 방향과 비교한 주파수 모양 차이(귓바퀴 단서)를 키워
 *      뒤쪽은 더 뒤처럼, 위·아래는 더 위·아래처럼 (앞쪽 음색은 조금만 바뀌게 비대칭으로).
 *
 * 모든 방향은 headYaw 만큼 반대로 돌려서 렌더링 (헤드 트래킹).
 * 지연(latency) = [WIN] 샘플 (48kHz 에서 21ms).
 */
class HrtfRenderer(private val fs: Int, base: HrirSet, private val elev: ElevationSet? = null) {

    enum class Mode { SPEAKERS, LOCALIZE }

    @Volatile var mode = Mode.SPEAKERS
    @Volatile var frontAngle = 45.0
    @Volatile var rearAngle = 135.0
    /** 배경음 중 옆/뒤로 보낼 비율 (0 = 전부 앞, 1 = 전부 옆/뒤) */
    @Volatile var rearLevel = 0.45
    /** 가운데 스피커로 보낼 가운데 성분 비율 (0 = 가운데 스피커 없음) */
    @Volatile var centerLevel = 0.7
    /** 정위 모드: 스테레오 끝(완전 왼쪽/오른쪽)이 몇 도에 놓일지 */
    @Volatile var spread = 90.0
    @Volatile var headYaw = 0.0
    /** 헤드 트래킹 위아래 (도, 위 +) */
    @Volatile var headPitch = 0.0
    /** 앞·가운데 스피커 높이 (도, 위 +) */
    @Volatile var frontElev = 0.0
    /** 배경음 중 천장 스피커로 보낼 비율 (0..1) */
    @Volatile var heightLevel = 0.0
    /** 천장 앞 스피커 위치: 좌우 각도(±, 0=정면…90=머리 옆…180=뒤)와 높이(도) */
    @Volatile var topAz = HEIGHT_AZ
    @Volatile var topEl = HEIGHT_EL
    /** 천장 뒤 스피커 위치 */
    @Volatile var topRearAz = TOP_REAR_AZ
    @Volatile var topRearEl = TOP_REAR_EL
    /** 배경음 중 바닥 스피커로 보낼 비율 (0..1) */
    @Volatile var bottomLevel = 0.0
    /** 바닥 스피커 위치: 좌우 각도(±)와 높이(도, 아래 −) */
    @Volatile var bottomAz = BOTTOM_AZ
    @Volatile var bottomEl = BOTTOM_EL

    // 프레임마다 고정해서 쓰는 값 (프레임 도중 바뀌어도 한 프레임 안에서는 일관되게)
    private var yawF = 0.0
    private var pitchF = 0.0
    private var elevF = 0.0

    /** 검증용: 마지막 프레임에서 앞 L/R · 가운데 · 옆/뒤(배경음)로 간 에너지 */
    @JvmField val routedEnergy = DoubleArray(3)

    private val fft = Fft(N)
    private val bins = N / 2 + 1

    // HRTF 스펙트럼 표: [dir][ear] → re/im (bins). enh = 3D 강조 (α − 1)
    private class Table(val dirs: Int, val step: Int, val re: Array<Array<FloatArray>>, val im: Array<Array<FloatArray>>, val enh: Float = 0f) {
        /**
         * 정면(0°) HRTF 의 위상 (귀별 cos/sin, 0~LOW_F2) — 직통 저음에 이 위상만 입혀서 HRTF 를 거친 소리와 이어 붙임.
         * (측정 HRTF 는 저음에서 위상이 앞서 있어서(94Hz +102°, 164Hz +41°) 단순 지연으로 맞추면 160Hz 에서 상쇄됨)
         */
        var lowC: Array<FloatArray> = arrayOf(FloatArray(0), FloatArray(0))
        var lowS: Array<FloatArray> = arrayOf(FloatArray(0), FloatArray(0))
    }
    /** 귀 크기별 원본 표 + 방향마다 "앞/뒤 짝 방향과의 크기 차이(dB, 1/2 옥타브 평활)" — 3D 강조를 FFT 없이 다시 계산하려고 보관 */
    private class Base(val t: Table, val diff: Array<Array<FloatArray>>)

    private val baseSet = base
    /** 3D 강조 적용 범위: 700Hz 아래는 그대로, 1.4kHz 까지 서서히 (앞뒤 단서는 고음 쪽 귓바퀴 특성) */
    private val enhRamp = FloatArray(bins) { k -> ((k * fs.toDouble() / N - 700.0) / 700.0).coerceIn(0.0, 1.0).toFloat() }
    @Volatile private var earIdx = 2
    @Volatile private var enhanceAmt = 0.0
    private var baseTab: Base = buildBase(base.adapted(fs, 1.0))
    private var baseEar = 2
    @Volatile private var table: Table = baseTab.t

    /** 귀 맞춤 단계 변경 (백그라운드에서 다시 계산 후 교체) */
    fun setEarSize(idx: Int) {
        val i = idx.coerceIn(0, HrirSet.EAR_FACTORS.lastIndex)
        if (i == earIdx) return
        earIdx = i
        requestRebuild()
    }

    /** 3D 강조 0..1 (α = 1 + amount): 0 이면 실측 그대로 */
    fun setEnhance(amount: Double) {
        val a = amount.coerceIn(0.0, 1.0)
        if (a == enhanceAmt) return
        enhanceAmt = a
        requestRebuild()
    }

    // 표 다시 만들기: 한 스레드에서 차례로, 밀린 요청은 마지막 것만 계산
    private val rebuildSeq = java.util.concurrent.atomic.AtomicInteger()
    private val rebuilder = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "hrtf-table").apply { isDaemon = true } }

    private fun requestRebuild() {
        val my = rebuildSeq.incrementAndGet()
        rebuilder.execute {
            if (my != rebuildSeq.get()) return@execute
            val e = earIdx; val a = enhanceAmt
            var b = baseTab
            if (baseEar != e) { b = buildBase(baseSet.adapted(fs, HrirSet.EAR_FACTORS[e])); baseTab = b; baseEar = e }
            val t = enhanced(b, a)
            if (my == rebuildSeq.get()) table = t
        }
    }

    private fun buildBase(set: HrirSet): Base {
        val t = buildTable(set)
        val sm = Array(t.dirs) { d -> Array(2) { e -> smoothDb(t.re[d][e], t.im[d][e]) } }
        val diff = Array(t.dirs) { d ->
            // 앞뒤 짝: θ ↔ 180° − θ (좌우 시간차·음량차가 같고 귓바퀴 단서만 다름)
            val p = (((180 - d * t.step) % 360 + 360) % 360 / t.step) % t.dirs
            Array(2) { e -> FloatArray(bins) { k -> sm[d][e][k] - sm[p][e][k] } }
        }
        return Base(t, diff)
    }

    /** 크기(dB)를 1/2 옥타브 폭으로 평활 */
    private fun smoothDb(re: FloatArray, im: FloatArray): FloatArray {
        val c = DoubleArray(bins + 1)
        for (k in 0 until bins) c[k + 1] = c[k] + 10.0 * log10(re[k].toDouble() * re[k] + im[k].toDouble() * im[k] + 1e-20)
        val r = 2.0.pow(0.25)
        return FloatArray(bins) { k ->
            val lo = max(0, floor(k / r).toInt()); val hi = min(bins - 1, max(k, (k * r).toInt()))
            ((c[hi + 1] - c[lo]) / (hi - lo + 1)).toFloat()
        }
    }

    /**
     * 3D 강조: 방향마다 앞/뒤 짝과의 크기 차이 D 를 (α−1)배 더 벌린다 (0위상 게인 → 시간차는 그대로).
     * 뒤쪽 방향이 차이의 3/4, 앞쪽이 1/4 을 맡아 → 앞(보컬) 음색은 조금만 바뀌고 뒤는 더 뒤처럼.
     */
    private fun enhanced(b: Base, amount: Double): Table {
        val t = b.t
        if (amount <= 0.0) return t
        val a = amount.toFloat()
        val re = Array(t.dirs) { Array(2) { FloatArray(bins) } }
        val im = Array(t.dirs) { Array(2) { FloatArray(bins) } }
        for (d in 0 until t.dirs) {
            val back = cos(Math.toRadians(d * t.step.toDouble())) < -1e-9
            val c = a * (if (back) ENH_BACK else ENH_FRONT)
            for (e in 0..1) {
                val df = b.diff[d][e]; val sr = t.re[d][e]; val si = t.im[d][e]; val dr = re[d][e]; val di = im[d][e]
                for (k in 0 until bins) {
                    val g = (c * df[k]).coerceIn(-ENH_MAX_DB, ENH_MAX_DB) * enhRamp[k]
                    val m = exp(g * LN10_20)
                    dr[k] = sr[k] * m; di[k] = si[k] * m
                }
            }
        }
        return Table(t.dirs, t.step, re, im, a).also { it.lowC = t.lowC; it.lowS = t.lowS }
    }

    private fun buildTable(set: HrirSet): Table {
        val f = Fft(N)
        val re = Array(set.dirs) { Array(2) { FloatArray(bins) } }
        val im = Array(set.dirs) { Array(2) { FloatArray(bins) } }
        val bufR = FloatArray(N)
        val bufI = FloatArray(N)
        val taps = min(set.taps, N - WIN - MAX_DELAY)
        for (d in 0 until set.dirs) for (e in 0..1) {
            bufR.fill(0f); bufI.fill(0f)
            System.arraycopy(set.data[d][e], 0, bufR, 0, taps)
            f.transform(bufR, bufI)
            System.arraycopy(bufR, 0, re[d][e], 0, bins)
            System.arraycopy(bufI, 0, im[d][e], 0, bins)
        }
        return Table(set.dirs, set.stepDeg, re, im).also { tb ->
            val nLow = ((LOW_F2 * N / fs).toInt() + 1).coerceAtMost(bins)
            tb.lowC = Array(2) { e -> FloatArray(nLow) { k -> val a = re[0][e][k]; val m = sqrt(a * a + im[0][e][k] * im[0][e][k]); if (m > 1e-12f) a / m else 1f } }
            tb.lowS = Array(2) { e -> FloatArray(nLow) { k -> val m = sqrt(re[0][e][k] * re[0][e][k] + im[0][e][k] * im[0][e][k]); if (m > 1e-12f) im[0][e][k] / m else 0f } }
        }
    }

    // --- STFT 버퍼 ----------------------------------------------------------
    private val window = FloatArray(WIN) { (0.5 - 0.5 * cos(2 * PI * it / WIN)).toFloat() } // 주기 Hann (50% 겹침 합 = 1)
    private val inL = FloatArray(WIN)
    private val inR = FloatArray(WIN)
    private val busIn = Array(NB) { FloatArray(WIN) }
    private var inPos = WIN - HOP // 앞쪽은 0 으로 채운 상태에서 시작 → 첫 프레임까지 HOP 샘플
    private val olaL = FloatArray(N)
    private val olaR = FloatArray(N)
    private val outL = FloatArray(HOP)
    private val outR = FloatArray(HOP)
    private var outPos = 0

    // FFT 작업 공간 (실수 신호 두 개를 복소 FFT 하나로 묶어서 계산)
    private val zr = FloatArray(N); private val zi = FloatArray(N)
    private val xLr = FloatArray(bins); private val xLi = FloatArray(bins)
    private val xRr = FloatArray(bins); private val xRi = FloatArray(bins)
    private val bR = Array(NB) { FloatArray(bins) }; private val bI = Array(NB) { FloatArray(bins) }
    private val yLr = FloatArray(bins); private val yLi = FloatArray(bins)
    private val yRr = FloatArray(bins); private val yRi = FloatArray(bins)

    // 가상 스피커 신호 (주파수 영역)
    private val fLr = FloatArray(bins); private val fLi = FloatArray(bins)
    private val fRr = FloatArray(bins); private val fRi = FloatArray(bins)
    private val cRr = FloatArray(bins); private val cIi = FloatArray(bins)
    private val aLr = FloatArray(bins); private val aLi = FloatArray(bins)
    private val aRr = FloatArray(bins); private val aRi = FloatArray(bins)

    // 분석 통계 (시간 평활) + 주파수 평활본
    private val pLL = FloatArray(bins); private val pRR = FloatArray(bins)
    private val pLRr = FloatArray(bins); private val pLRi = FloatArray(bins)
    private val sLL = FloatArray(bins); private val sRR = FloatArray(bins)
    private val sLRr = FloatArray(bins); private val sLRi = FloatArray(bins)
    private val cum = DoubleArray(bins + 1)

    private val lowBin = (130.0 * N / fs).roundToInt() // 이 아래 저음은 방향 처리 없이 그대로 (펀치감 유지)

    /**
     * 저음 직통: 100Hz 아래는 전부, 200Hz 까지 서서히 — 가상 스피커를 거치지 않고 L → 왼쪽 귀, R → 오른쪽 귀.
     * 가상 스피커로 보내면 좌우가 같은(모노) 저음은 두 스피커 소리가 귀에서 겹쳐 커지고, 좌우가 다른(넓은) 저음은
     * 그렇지 않아서 넓은 저음이 3~4dB 작게 났음 (+ 지연이 다른 배경음 복사본끼리 저음에서 상쇄). 이 대역은 방향을 거의 못 느낌.
     */
    private val lowW = FloatArray(bins) { k ->
        val f = k * fs.toDouble() / N
        when { f <= LOW_F1 -> 1f; f >= LOW_F2 -> 0f; else -> (0.5 + 0.5 * cos(PI * (f - LOW_F1) / (LOW_F2 - LOW_F1))).toFloat() }
    }
    private val lowTop = (LOW_F2 * N / fs).toInt().coerceAtMost(bins - 1)
    private val dLr = FloatArray(bins); private val dLi = FloatArray(bins)
    private val dRr = FloatArray(bins); private val dRi = FloatArray(bins)
    /** 직통 저음 배율 = 1 / roomNorm (BinauralProcessor 가 설정 → 귀에서 원음과 같은 크기) */
    @Volatile var lowGain = 1.0

    /**
     * 저음 보강 (0 = 없음): |1 + g / (1 + j f/130Hz)| 모양을 0위상 게인으로 두 귀 출력 전체에 —
     * 예전처럼 원음 저역통과를 시간 영역에서 더하면 HRTF 를 거친 저음과 위상이 어긋나 50Hz 근처가 오히려 깎였음.
     */
    @Volatile var bassBoost = 0.0
    private var bassCurveFor = -1.0
    private val bassCurve = FloatArray(bins) { 1f }
    private val bassTop = (1000.0 * N / fs).toInt().coerceAtMost(bins - 1)

    /** 나눠 둔 직통 저음에 정면 HRTF 위상을 입혀 두 귀에 */
    private fun addLowDirect(t: Table) {
        val g = lowGain.toFloat()
        val cL = t.lowC[0]; val sL = t.lowS[0]; val cR = t.lowC[1]; val sR = t.lowS[1]
        for (k in 0..min(lowTop, cL.size - 1)) {
            val lr = dLr[k] * g; val li = dLi[k] * g; val rr = dRr[k] * g; val ri = dRi[k] * g
            yLr[k] += lr * cL[k] - li * sL[k]; yLi[k] += lr * sL[k] + li * cL[k]
            yRr[k] += rr * cR[k] - ri * sR[k]; yRi[k] += rr * sR[k] + ri * cR[k]
        }
    }

    /** 저음 보강 곡선을 두 귀 출력에 곱함 */
    private fun applyBass() {
        val g = bassBoost
        if (g <= 0.0) return
        if (g != bassCurveFor) {
            for (k in 0..bassTop) {
                val x = k * fs.toDouble() / N / 130.0
                bassCurve[k] = (sqrt((1 + g) * (1 + g) + x * x) / sqrt(1 + x * x)).toFloat()
            }
            bassCurveFor = g
        }
        for (k in 0..bassTop) {
            val b = bassCurve[k]
            yLr[k] *= b; yLi[k] *= b; yRr[k] *= b; yRi[k] *= b
        }
    }

    // 지연(위상 회전) 표 캐시: 지연 샘플 → cos/sin
    private val phaseCache = HashMap<Int, Array<FloatArray>>()
    private fun phase(delay: Int): Array<FloatArray> = phaseCache.getOrPut(delay) {
        val c = FloatArray(bins); val s = FloatArray(bins)
        for (k in 0 until bins) {
            val ph = -2.0 * PI * k * delay / N
            c[k] = cos(ph).toFloat(); s[k] = sin(ph).toFloat()
        }
        arrayOf(c, s)
    }
    private val dSide = (0.004 * fs).roundToInt().coerceAtMost(MAX_DELAY)
    private val dRear = (0.009 * fs).roundToInt().coerceAtMost(MAX_DELAY)
    private val dTop = (0.006 * fs).roundToInt().coerceAtMost(MAX_DELAY)
    private val dTopRear = (0.0105 * fs).roundToInt().coerceAtMost(MAX_DELAY)
    private val dBottom = (0.0025 * fs).roundToInt().coerceAtMost(MAX_DELAY)

    /**
     * 샘플 하나 입력 → [LATENCY] 샘플 전의 처리 결과를 out[0], out[1] 에.
     * bus: 방 버스 8개 (null 이면 없음)
     */
    fun process(l: Float, r: Float, bus: FloatArray?, out: FloatArray) {
        out[0] = outL[outPos]
        out[1] = outR[outPos]
        outPos++
        inL[inPos] = l
        inR[inPos] = r
        if (bus != null) for (b in 0 until NB) busIn[b][inPos] = bus[b]
        else for (b in 0 until NB) busIn[b][inPos] = 0f
        inPos++
        if (inPos == WIN) {
            frame()
            System.arraycopy(inL, HOP, inL, 0, WIN - HOP)
            System.arraycopy(inR, HOP, inR, 0, WIN - HOP)
            for (b in 0 until NB) System.arraycopy(busIn[b], HOP, busIn[b], 0, WIN - HOP)
            inPos = WIN - HOP
            outPos = 0
        }
    }

    private fun dirIndex(t: Table, deg: Double): Int {
        var a = (deg - yawF) % 360.0
        if (a < 0) a += 360.0
        return ((a / t.step).roundToInt()) % t.dirs
    }

    /** 두 실수 신호 a, b 를 창을 씌워 복소 FFT 하나로 변환 → 각자의 스펙트럼 */
    private fun fft2(a: FloatArray, b: FloatArray, ar: FloatArray, ai: FloatArray, br: FloatArray, bi: FloatArray) {
        for (i in 0 until N) {
            if (i < WIN) { zr[i] = a[i] * window[i]; zi[i] = b[i] * window[i] } else { zr[i] = 0f; zi[i] = 0f }
        }
        fft.transform(zr, zi)
        for (k in 0 until bins) {
            val m = (N - k) % N
            ar[k] = 0.5f * (zr[k] + zr[m]); ai[k] = 0.5f * (zi[k] - zi[m])
            br[k] = 0.5f * (zi[k] + zi[m]); bi[k] = 0.5f * (zr[m] - zr[k])
        }
    }

    private fun frame() {
        val t = table
        yawF = headYaw; pitchF = headPitch; elevF = frontElev
        fft2(inL, inR, xLr, xLi, xRr, xRi)
        var hasBus = false
        outer@ for (b in 0 until NB) for (v in busIn[b]) if (v != 0f) { hasBus = true; break@outer }
        if (hasBus) for (p in 0 until NB / 2) fft2(busIn[2 * p], busIn[2 * p + 1], bR[2 * p], bI[2 * p], bR[2 * p + 1], bI[2 * p + 1])

        yLr.fill(0f); yLi.fill(0f); yRr.fill(0f); yRi.fill(0f)
        analyse()
        if (mode == Mode.SPEAKERS) speakers(t) else localize(t)
        if (hasBus) for (b in 0 until NB) {
            // 방(반사음·잔향)은 저음 직통 구간에서 빼서 — 낮은 저음에서 반사음끼리 상쇄되던 것(50Hz -7dB) 방지
            val br = bR[b]; val bi = bI[b]
            for (k in 0..lowTop) { val wh = 1f - lowW[k]; br[k] *= wh; bi[k] *= wh }
            addSource(t, br, bi, BUS_ANGLES[b], 0.0, 1f, 0)
        }
        applyBass()

        // 두 귀 출력을 복소 역FFT 하나로: w = YL + j·YR  (실수부 = 왼쪽, 허수부 = 오른쪽)
        yLi[0] = 0f; yRi[0] = 0f; yLi[N / 2] = 0f; yRi[N / 2] = 0f
        for (k in 0..N / 2) {
            zr[k] = yLr[k] - yRi[k]; zi[k] = yLi[k] + yRr[k]
        }
        for (k in N / 2 + 1 until N) {
            val m = N - k
            zr[k] = yLr[m] + yRi[m]; zi[k] = yRr[m] - yLi[m]
        }
        fft.transform(zr, zi, inverse = true)

        for (i in 0 until N) { olaL[i] += zr[i]; olaR[i] += zi[i] }
        System.arraycopy(olaL, 0, outL, 0, HOP)
        System.arraycopy(olaR, 0, outR, 0, HOP)
        System.arraycopy(olaL, HOP, olaL, 0, N - HOP); java.util.Arrays.fill(olaL, N - HOP, N, 0f)
        System.arraycopy(olaR, HOP, olaR, 0, N - HOP); java.util.Arrays.fill(olaR, N - HOP, N, 0f)
    }

    /**
     * 좌우 통계: 시간 평활(약 25ms) 후 주파수 방향으로도 평활(고음일수록 넓게).
     * 짧은 평균만 쓰면 서로 관계없는 좌우 신호도 "비슷하다"고 잘못 판단하기 쉬워서 (상관 과대추정) 두 방향으로 평균.
     */
    private fun analyse() {
        val a = 0.55f
        for (k in 0 until bins) {
            val lr = xLr[k]; val li = xLi[k]; val rr = xRr[k]; val ri = xRi[k]
            pLL[k] = a * pLL[k] + (1 - a) * (lr * lr + li * li)
            pRR[k] = a * pRR[k] + (1 - a) * (rr * rr + ri * ri)
            pLRr[k] = a * pLRr[k] + (1 - a) * (lr * rr + li * ri)
            pLRi[k] = a * pLRi[k] + (1 - a) * (li * rr - lr * ri)
        }
        smooth(pLL, sLL); smooth(pRR, sRR); smooth(pLRr, sLRr); smooth(pLRi, sLRi)
    }

    private fun smooth(src: FloatArray, dst: FloatArray) {
        cum[0] = 0.0
        for (k in 0 until bins) cum[k + 1] = cum[k] + src[k]
        for (k in 0 until bins) {
            val h = 1 + k / 32 // 저음 ±1칸, 고음으로 갈수록 넓게 (5kHz ≈ ±7칸)
            val lo = max(0, k - h); val hi = min(bins - 1, k + h)
            dst[k] = ((cum[hi + 1] - cum[lo]) / (hi - lo + 1)).toFloat()
        }
    }

    // ── 높이가 있거나 고개를 위아래로 움직였을 때: 수평 실측 HRTF × 높이 단서 (캐시) ──
    private class Spec(val lr: FloatArray, val li: FloatArray, val rr: FloatArray, val ri: FloatArray)
    private val specCache = object : LinkedHashMap<Int, Spec>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, Spec>?) = size > 600
    }
    private var specTable: Table? = null
    private val gainTmp = FloatArray(bins)
    private val rowSpec = arrayOfNulls<Spec>(180)

    /** 세계 방향 (방위 azW, 높이 elW) 의 두 귀 스펙트럼 — 머리 좌우·위아래 회전을 반영 */
    private fun specFor(t: Table, azW: Double, elW: Double): Spec {
        if (specTable !== t) { specCache.clear(); specTable = t }
        val a = Math.toRadians(azW); val e = Math.toRadians(elW)
        val x = cos(e) * sin(a); val y = cos(e) * cos(a); val z = sin(e)
        val ps = Math.toRadians(yawF); val th = Math.toRadians(pitchF)
        // 머리가 오른쪽으로 ψ 돌고 위로 θ 들면 → 소리는 머리 기준 왼쪽·아래로
        val x1 = x * cos(ps) - y * sin(ps); val y1 = x * sin(ps) + y * cos(ps)
        val y2 = y1 * cos(th) + z * sin(th); val z2 = -y1 * sin(th) + z * cos(th)
        val azH = Math.toDegrees(kotlin.math.atan2(x1, y2))
        val elH = Math.toDegrees(kotlin.math.asin(z2.coerceIn(-1.0, 1.0)))
        val ai = (((azH % 360.0) + 360.0) % 360.0 / 2.0).roundToInt() % 180
        val ei = (elH / 2.5).roundToInt().coerceIn(-36, 36)
        val key = ai * 100 + ei + 50
        specCache[key]?.let { return it }
        val azQ = (ai * 2.0).let { if (it > 180.0) it - 360.0 else it }
        val elQ = ei * 2.5
        val er = Math.toRadians(elQ); val arr = Math.toRadians(azQ)
        val azEq = ElevationSet.lateralAzimuth(cos(er) * sin(arr), cos(er) * cos(arr))
        val d = ((((azEq % 360.0) + 360.0) % 360.0 / t.step).roundToInt()) % t.dirs
        val sp = Spec(t.re[d][0].copyOf(), t.im[d][0].copyOf(), t.re[d][1].copyOf(), t.im[d][1].copyOf())
        val ev = elev
        if (ev != null && ei != 0) {
            // 3D 강조: 위·아래 단서도 α 배
            val sc = 1f + t.enh
            ev.cueGain(azQ, elQ, azEq, 0, fs, N, gainTmp, sc)
            for (k in 0 until bins) { sp.lr[k] *= gainTmp[k]; sp.li[k] *= gainTmp[k] }
            ev.cueGain(azQ, elQ, azEq, 1, fs, N, gainTmp, sc)
            for (k in 0 until bins) { sp.rr[k] *= gainTmp[k]; sp.ri[k] *= gainTmp[k] }
        }
        specCache[key] = sp
        return sp
    }

    /** y += x · H(방위 deg, 높이 el) · g · e^{-jωd} */
    private fun addSource(t: Table, xr: FloatArray, xi: FloatArray, deg: Double, el: Double, g: Float, delay: Int) {
        val hLr: FloatArray; val hLi: FloatArray; val hRr: FloatArray; val hRi: FloatArray
        if (el == 0.0 && pitchF == 0.0) {
            val d = dirIndex(t, deg)
            hLr = t.re[d][0]; hLi = t.im[d][0]; hRr = t.re[d][1]; hRi = t.im[d][1]
        } else {
            val sp = specFor(t, deg, el)
            hLr = sp.lr; hLi = sp.li; hRr = sp.rr; hRi = sp.ri
        }
        if (delay == 0) {
            for (k in 0 until bins) {
                val ar = xr[k] * g; val ai = xi[k] * g
                yLr[k] += ar * hLr[k] - ai * hLi[k]; yLi[k] += ar * hLi[k] + ai * hLr[k]
                yRr[k] += ar * hRr[k] - ai * hRi[k]; yRi[k] += ar * hRi[k] + ai * hRr[k]
            }
        } else {
            val (c, s) = phase(delay)
            for (k in 0 until bins) {
                val xr0 = xr[k] * g; val xi0 = xi[k] * g
                val ar = xr0 * c[k] - xi0 * s[k]
                val ai = xr0 * s[k] + xi0 * c[k]
                yLr[k] += ar * hLr[k] - ai * hLi[k]; yLi[k] += ar * hLi[k] + ai * hLr[k]
                yRr[k] += ar * hRr[k] - ai * hRi[k]; yRi[k] += ar * hRi[k] + ai * hRr[k]
            }
        }
    }

    /** 직접음 비율 (0 = 배경음, 1 = 방향이 뚜렷한 소리) */
    private fun directness(k: Int): Float {
        val tot = sLL[k] + sRR[k] + 1e-20f
        val cross = sqrt(sLRr[k] * sLRr[k] + sLRi[k] * sLRi[k])
        val coh = (cross / sqrt(sLL[k] * sRR[k] + 1e-30f)).coerceIn(0f, 1f)
        // 한쪽에만 있는 소리는 상관이 낮아도 방향이 뚜렷 → 직접음
        val side = abs(sRR[k] - sLL[k]) / tot
        // 짧은 평균에서 생기는 추정 편향 보정: 서로 무관한 좌우 신호도 상관 ~0.3, 좌우 차이 ~0.3 정도는 우연히 나옴
        val c = ((coh - 0.3f) / 0.7f).coerceIn(0f, 1f)
        val sd = ((side - 0.4f) / 0.6f).coerceIn(0f, 1f)
        return max(c, sd)
    }

    private fun speakers(t: Table) {
        val cl = centerLevel.toFloat()
        val r = rearLevel.toFloat().coerceIn(0f, 1f)
        val h = heightLevel.toFloat().coerceIn(0f, 1f)
        val bt = bottomLevel.toFloat().coerceIn(0f, 1f)
        // 배경음 에너지 나누기: 앞 (1-r)(1-h)(1-b), 옆·뒤 r(1-h)(1-b), 천장 h(1-b), 바닥 b
        val frontAmb = sqrt((1f - r) * (1f - h) * (1f - bt))
        val surAmb = sqrt(r * (1f - h) * (1f - bt))
        val topAmb = sqrt(h * (1f - bt))
        val botAmb = sqrt(bt)
        for (k in 0 until bins) {
            // 저음 직통 몫(wl)은 따로 두고 나머지(wh)만 가상 스피커로
            val wl = lowW[k]; val wh = 1f - wl
            dLr[k] = xLr[k] * wl; dLi[k] = xLi[k] * wl; dRr[k] = xRr[k] * wl; dRi[k] = xRi[k] * wl
            val lr = xLr[k] * wh; val li = xLi[k] * wh; val rr = xRr[k] * wh; val ri = xRi[k] * wh
            if (k < lowBin) {
                fLr[k] = lr; fLi[k] = li; fRr[k] = rr; fRi[k] = ri
                cRr[k] = 0f; cIi[k] = 0f; aLr[k] = 0f; aLi[k] = 0f; aRr[k] = 0f; aRi[k] = 0f
                continue
            }
            val dir = directness(k)
            val md = sqrt(dir); val ma = sqrt(1f - dir)
            val ldr = lr * md; val ldi = li * md; val rdr = rr * md; val rdi = ri * md
            // 가운데 성분: 좌우가 "같을수록"(유사도 ψ → 1) 가운데로
            val tot = sLL[k] + sRR[k] + 1e-20f
            val psi = (2f * sqrt(sLRr[k] * sLRr[k] + sLRi[k] * sLRi[k]) / tot).coerceIn(0f, 1f)
            // 가운데로 보낼 몫: 좌우가 완전히 같은 소리(ψ=1)는 가운데 스피커로만 보내고(앞 L/R 에 같은 소리가 남으면
            // 세 스피커 소리가 귀에서 간섭해 1~2kHz 가 최대 -7dB 파이고 250Hz 가 부풂 = 탁한 소리), cl 은 "얼마나 덜 같은
            // 소리까지 가운데로 모을지"를 정함 (ψ > 1 − cl 부터).
            val wc = if (cl <= 0.001f) 0f else { val u = ((psi - (1f - cl)) / cl).coerceIn(0f, 1f); u * u }
            val cr = wc * 0.5f * (ldr + rdr); val ci = wc * 0.5f * (ldi + rdi)
            var flr = ldr - cr; var fli = ldi - ci; var frr = rdr - cr; var fri = rdi - ci
            // 에너지 보존 (가운데를 빼면서 줄어든 만큼 되돌림)
            val eIn = ldr * ldr + ldi * ldi + rdr * rdr + rdi * rdi
            val eOut = flr * flr + fli * fli + frr * frr + fri * fri + 2f * (cr * cr + ci * ci)
            val gN = if (eOut > 1e-24f) sqrt(eIn / eOut).coerceIn(1f, 2f) else 1f
            flr *= gN; fli *= gN; frr *= gN; fri *= gN
            cRr[k] = cr * gN * SQRT2; cIi[k] = ci * gN * SQRT2
            // 배경음: 일부는 앞 스피커, 나머지는 옆·뒤·천장으로 (aL/aR 는 나누기 전 배경음)
            val alr = lr * ma; val ali = li * ma; val arr = rr * ma; val ari = ri * ma
            fLr[k] = flr + alr * frontAmb; fLi[k] = fli + ali * frontAmb
            fRr[k] = frr + arr * frontAmb; fRi[k] = fri + ari * frontAmb
            aLr[k] = alr; aLi[k] = ali; aRr[k] = arr; aRi[k] = ari
        }
        var eF = 0.0; var eC = 0.0; var eA = 0.0
        for (k in lowBin until bins) {
            eF += (fLr[k] * fLr[k] + fLi[k] * fLi[k] + fRr[k] * fRr[k] + fRi[k] * fRi[k]).toDouble()
            eC += (cRr[k] * cRr[k] + cIi[k] * cIi[k]).toDouble()
            eA += (aLr[k] * aLr[k] + aLi[k] * aLi[k] + aRr[k] * aRr[k] + aRi[k] * aRi[k]).toDouble() * (surAmb * surAmb + topAmb * topAmb + botAmb * botAmb)
        }
        routedEnergy[0] = eF; routedEnergy[1] = eC; routedEnergy[2] = eA
        val f = frontAngle
        addSource(t, fLr, fLi, -f, elevF, 1f, 0)
        addSource(t, fRr, fRi, f, elevF, 1f, 0)
        if (cl > 0.001f) addSource(t, cRr, cIi, 0.0, elevF, 1f, 0)
        addAmbience(t, surAmb, topAmb, botAmb)
        addLowDirect(t)
    }

    /** 배경음 → 옆(±95°)·뒤(±rear)·천장 앞/뒤·바닥 — 서로 다른 지연으로 디코릴레이션 */
    private fun addAmbience(t: Table, surAmb: Float, topAmb: Float, botAmb: Float) {
        if (surAmb > 0.0005f) {
            addSource(t, aLr, aLi, -SIDE_ANGLE, 0.0, SIDE_SHARE * surAmb, dSide)
            addSource(t, aRr, aRi, SIDE_ANGLE, 0.0, SIDE_SHARE * surAmb, dSide)
            addSource(t, aLr, aLi, -rearAngle, 0.0, REAR_SHARE * surAmb, dRear)
            addSource(t, aRr, aRi, rearAngle, 0.0, REAR_SHARE * surAmb, dRear)
        }
        if (topAmb > 0.0005f) {
            // 천장 앞·뒤에 에너지 반씩
            val g = topAmb * HALF
            val az = topAz; val el = topEl; val raz = topRearAz; val rel = topRearEl
            addSource(t, aLr, aLi, -az, el, g, dTop)
            addSource(t, aRr, aRi, az, el, g, dTop)
            addSource(t, aLr, aLi, -raz, rel, g, dTopRear)
            addSource(t, aRr, aRi, raz, rel, g, dTopRear)
        }
        if (botAmb > 0.0005f) {
            val az = bottomAz; val el = bottomEl
            addSource(t, aLr, aLi, -az, el, botAmb, dBottom)
            addSource(t, aRr, aRi, az, el, botAmb, dBottom)
        }
    }

    private fun localize(t: Table) {
        val spr = spread
        val r = rearLevel.toFloat().coerceIn(0f, 1f)
        val h = heightLevel.toFloat().coerceIn(0f, 1f)
        val bt = bottomLevel.toFloat().coerceIn(0f, 1f)
        val frontAmb = sqrt((1f - r) * (1f - h) * (1f - bt))
        val surAmb = sqrt(r * (1f - h) * (1f - bt))
        val topAmb = sqrt(h * (1f - bt))
        val botAmb = sqrt(bt)
        val fast = elevF == 0.0 && pitchF == 0.0
        if (!fast) java.util.Arrays.fill(rowSpec, null)
        for (k in 0 until bins) {
            val wl = lowW[k]; val wh = 1f - wl
            dLr[k] = xLr[k] * wl; dLi[k] = xLi[k] * wl; dRr[k] = xRr[k] * wl; dRi[k] = xRi[k] * wl
            val lr = xLr[k] * wh; val li = xLi[k] * wh; val rr = xRr[k] * wh; val ri = xRi[k] * wh
            val ll = lr * lr + li * li
            val rrE = rr * rr + ri * ri
            val dir = if (k < lowBin) 1f else directness(k)
            val md = sqrt(dir); val ma = sqrt(1f - dir)

            // 직접음: 에너지를 보존하는 합 (위상 정렬된 L+R) → 성분 하나를 정확한 방향에
            val sr = lr + rr; val si = li + ri
            val sumE = sr * sr + si * si
            val norm = if (sumE > 1e-24f) sqrt((ll + rrE) / sumE).coerceAtMost(2f) else 0f
            val dr = sr * norm * md
            val di = si * norm * md
            val tot = sLL[k] + sRR[k] + 1e-20f
            val pan = (sRR[k] - sLL[k]) / tot // -1 왼쪽 … +1 오른쪽
            val deg = if (k < lowBin) 0.0 else spr * pan
            val hL: FloatArray; val hLi: FloatArray; val hR: FloatArray; val hRi: FloatArray
            if (fast) {
                val d = dirIndex(t, deg)
                hL = t.re[d][0]; hLi = t.im[d][0]; hR = t.re[d][1]; hRi = t.im[d][1]
            } else {
                // 같은 프레임 안에서는 방위(2°)별로 한 번만 계산
                val idx = ((((deg % 360.0) + 360.0) % 360.0) / 2.0).roundToInt() % 180
                val sp = rowSpec[idx] ?: specFor(t, idx * 2.0, elevF).also { rowSpec[idx] = it }
                hL = sp.lr; hLi = sp.li; hR = sp.rr; hRi = sp.ri
            }
            yLr[k] += dr * hL[k] - di * hLi[k]; yLi[k] += dr * hLi[k] + di * hL[k]
            yRr[k] += dr * hR[k] - di * hRi[k]; yRi[k] += dr * hRi[k] + di * hR[k]

            // 배경음
            fLr[k] = lr * ma * frontAmb; fLi[k] = li * ma * frontAmb
            fRr[k] = rr * ma * frontAmb; fRi[k] = ri * ma * frontAmb
            aLr[k] = lr * ma; aLi[k] = li * ma
            aRr[k] = rr * ma; aRi[k] = ri * ma
        }
        addSource(t, fLr, fLi, -frontAngle, elevF, 1f, 0)
        addSource(t, fRr, fRi, frontAngle, elevF, 1f, 0)
        addAmbience(t, surAmb, topAmb, botAmb)
        addLowDirect(t)
    }

    companion object {
        const val N = 2048
        /** 저음 직통 구간: LOW_F1 아래 전부, LOW_F2 까지 서서히 */
        const val LOW_F1 = 100.0
        const val LOW_F2 = 200.0
        const val WIN = 1024
        const val HOP = WIN / 2
        const val LATENCY = WIN
        /** 위상 회전으로 넣는 최대 지연 (샘플) — 제로패딩 여유 */
        const val MAX_DELAY = 512
        /** 방 버스 개수와 방향 (i × 45°) — RoomModel 과 같음 */
        const val NB = RoomModel.BUSES
        val BUS_ANGLES = DoubleArray(NB) { it * 360.0 / NB }
        const val SIDE_ANGLE = 95.0
        /** 천장 앞 스피커 기본 위치: 좌우 ±45°, 위 45° (7.1.4 배치) */
        const val HEIGHT_AZ = 45.0
        const val HEIGHT_EL = 45.0
        /** 천장 뒤 스피커 기본 위치: 좌우 ±135°, 위 45° */
        const val TOP_REAR_AZ = 135.0
        const val TOP_REAR_EL = 45.0
        /** 바닥 스피커 기본 위치: 좌우 ±45°, 아래 30° */
        const val BOTTOM_AZ = 45.0
        const val BOTTOM_EL = -30.0
        /** 3D 강조: 앞/뒤 짝과의 차이를 뒤쪽이 3/4, 앞쪽이 1/4 맡음. 최대 ±10dB */
        private const val ENH_BACK = 0.75f
        private const val ENH_FRONT = 0.25f
        private const val ENH_MAX_DB = 10f
        private const val LN10_20 = 0.11512925f
        private val HALF = sqrt(0.5f)
        private val SIDE_SHARE = sqrt(0.6f)
        private val REAR_SHARE = sqrt(0.4f)
        private val SQRT2 = sqrt(2f)
    }
}
