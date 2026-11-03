package com.spatialsound.app

import java.io.DataInputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * 높이(위아래) 단서 — MIT KEMAR HRTF (W. Gardner, K. Martin, MIT Media Lab, 1994),
 * 확산음장 등화 compact 세트 48kHz, 높이 -40°~+90° (368 방향). mit-hrtf-lib(MIT License) 배열에서 추출.
 *
 * 수평면은 해상도가 높은 기존 실측 데이터(2° 간격)를 그대로 쓰고, 이 데이터에서는
 * "같은 좌우 각도의 수평 방향과 비교해 소리가 위/아래에서 올 때 달라지는 주파수 모양"만 가져온다.
 * → 두 측정 데이터를 섞어도 음색이 튀지 않고, 위아래 단서만 더해진다.
 */
class ElevationSet private constructor(
    private val layers: IntArray,              // 높이 (오름차순)
    private val az: Array<IntArray>,           // 층별 방위각 0..180 (오른쪽 +)
    private val hrir: Array<Array<Array<FloatArray>>>, // [층][방위][귀]
) {
    /** 층별·방위별·귀별 주파수 크기(dB, 1/6 옥타브 평활) — 48kHz, 2048점 FFT 기준 */
    private var magDb: Array<Array<Array<FloatArray>>>? = null
    private val mitBins = MIT_N / 2 + 1

    /** 크기 스펙트럼 계산 (한 번, 백그라운드에서) */
    fun prepare() {
        if (magDb != null) return
        val f = Fft(MIT_N)
        val re = FloatArray(MIT_N); val im = FloatArray(MIT_N)
        val raw = FloatArray(mitBins)
        magDb = Array(layers.size) { li ->
            Array(az[li].size) { ai ->
                Array(2) { e ->
                    re.fill(0f); im.fill(0f)
                    val h = hrir[li][ai][e]
                    System.arraycopy(h, 0, re, 0, h.size)
                    f.transform(re, im)
                    for (k in 0 until mitBins) raw[k] = (10 * log10(re[k] * re[k] + im[k] * im[k] + 1e-12f)).toFloat()
                    smooth(raw)
                }
            }
        }
    }

    /** 1/3 옥타브 평활 (뾰족한 골짜기 때문에 생기는 잡음·쏘는 소리 방지) */
    private fun smooth(db: FloatArray): FloatArray {
        val out = FloatArray(db.size)
        val cum = DoubleArray(db.size + 1)
        for (k in db.indices) cum[k + 1] = cum[k] + db[k]
        val r = 2.0.pow(1.0 / 6)
        for (k in db.indices) {
            val lo = max(0, floor(k / r).toInt()); val hi = min(db.size - 1, (k * r).toInt().coerceAtLeast(k))
            out[k] = ((cum[hi + 1] - cum[lo]) / (hi - lo + 1)).toFloat()
        }
        return out
    }

    /** (방위, 높이, 귀) 를 둘러싼 최대 4개 측정점과 가중치 (방위·높이 선형 보간) — 주파수와 무관해서 한 번만 계산 */
    private class Weights(val li: IntArray, val ai: IntArray, val ear: IntArray, val w: FloatArray)

    private fun weights(azDeg: Double, elDeg: Double, ear: Int): Weights {
        var a = azDeg; var e2 = ear
        if (a < 0) { a = -a; e2 = 1 - ear } // 왼쪽은 좌우 대칭
        if (a > 180) a = 180.0
        val el = elDeg.coerceIn(layers.first().toDouble(), layers.last().toDouble())
        var li = 0
        while (li < layers.size - 2 && layers[li + 1] <= el) li++
        val l1 = min(li + 1, layers.size - 1)
        val t = if (layers[l1] == layers[li]) 0.0 else ((el - layers[li]) / (layers[l1] - layers[li])).coerceIn(0.0, 1.0)
        val lis = IntArray(4); val ais = IntArray(4); val ws = FloatArray(4)
        var n = 0
        for ((layer, lw) in listOf(li to 1 - t, l1 to t)) {
            val azs = az[layer]
            if (azs.size == 1) { lis[n] = layer; ais[n] = 0; ws[n] = lw.toFloat(); n++; continue }
            var j = 0
            while (j < azs.size - 2 && azs[j + 1] <= a) j++
            val u = ((a - azs[j]) / (azs[j + 1] - azs[j])).coerceIn(0.0, 1.0)
            lis[n] = layer; ais[n] = j; ws[n] = (lw * (1 - u)).toFloat(); n++
            lis[n] = layer; ais[n] = j + 1; ws[n] = (lw * u).toFloat(); n++
        }
        return Weights(lis.copyOf(n), ais.copyOf(n), IntArray(n) { e2 }, ws.copyOf(n))
    }

    private fun dbAt(m: Array<Array<Array<FloatArray>>>, w: Weights, b: Int): Float {
        var s = 0f
        for (i in w.w.indices) s += w.w[i] * m[w.li[i]][w.ai[i]][w.ear[i]][b]
        return s
    }

    // 엔진 STFT 칸 → MIT 칸 대응표 (fs, n 마다 한 번)
    private var mapKey = 0L
    private var mapB0 = IntArray(0)
    private var mapFr = FloatArray(0)

    /**
     * 높이 단서 게인(배율, 0위상): 소리가 (azS, elS)에서 올 때 MIT 크기 ÷ 같은 좌우 각도 수평 방향(azEq) MIT 크기.
     * fs·n 은 엔진의 STFT 크기. 400Hz 아래는 단서 없음(compact 세트가 저음에서 부정확), ±8dB 로 제한.
     */
    @Synchronized
    fun cueGain(azS: Double, elS: Double, azEq: Double, ear: Int, fs: Int, n: Int, out: FloatArray) {
        val m = magDb ?: run { out.fill(1f); return }
        val bins = n / 2 + 1
        val key = fs.toLong() * 100000 + n
        if (key != mapKey) {
            val mitHz = 48000.0 / MIT_N
            mapB0 = IntArray(bins) { k -> min(mitBins - 2, ((k * fs.toDouble() / n) / mitHz).toInt()) }
            mapFr = FloatArray(bins) { k -> (((k * fs.toDouble() / n) / mitHz) - mapB0[k]).toFloat().coerceIn(0f, 1f) }
            mapKey = key
        }
        val wu = weights(azS, elS, ear)
        val wf = weights(azEq, 0.0, ear)
        val lo = 400.0 * n / fs; val ramp = 800.0 * n / fs
        for (k in 0 until bins) {
            if (k < lo) { out[k] = 1f; continue }
            val b0 = mapB0[k]; val fr = mapFr[k]
            val up = dbAt(m, wu, b0) * (1 - fr) + dbAt(m, wu, b0 + 1) * fr
            val flat = dbAt(m, wf, b0) * (1 - fr) + dbAt(m, wf, b0 + 1) * fr
            // 두 측정(귀 크기 다름)의 골짜기 위치 차이로 특정 주파수가 튀지 않게 ±8dB 로 제한
            var g = (up - flat).coerceIn(-MAX_DB, MAX_DB)
            if (k < ramp) g *= ((k - lo) / (ramp - lo)).toFloat() // 400~800Hz 서서히
            out[k] = exp(g * LN10_20)
        }
    }

    companion object {
        const val MIT_N = 2048

        /** hrir_mit_elev.bin (tools/export_mit_elev.py 형식) */
        fun load(input: InputStream): ElevationSet {
            val din = DataInputStream(input.buffered())
            val magic = ByteArray(4).also { din.readFully(it) }
            require(String(magic) == "HREL") { "높이 HRIR 파일 형식이 아닙니다" }
            val head = ByteArray(16).also { din.readFully(it) }
            val bb = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
            bb.int // version
            bb.int // fs (48000)
            val taps = bb.int
            val count = bb.int
            val raw = ByteArray(count * (4 + taps * 4)).also { din.readFully(it) }
            val b = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN)
            val map = sortedMapOf<Int, MutableList<Pair<Int, Array<FloatArray>>>>()
            repeat(count) {
                val el = b.short.toInt(); val a = b.short.toInt()
                val l = FloatArray(taps) { b.short / 32768f }
                val r = FloatArray(taps) { b.short / 32768f }
                map.getOrPut(el) { mutableListOf() } += a to arrayOf(l, r)
            }
            val layers = map.keys.toIntArray()
            val az = Array(layers.size) { i -> map[layers[i]]!!.sortedBy { it.first }.map { it.first }.toIntArray() }
            val hr = Array(layers.size) { i -> map[layers[i]]!!.sortedBy { it.first }.map { it.second }.toTypedArray() }
            return ElevationSet(layers, az, hr)
        }

        /** 같은 좌우 각도(가로 방향 성분)를 가진 수평 방위각: 위로 올라간 소리는 양 귀 차이가 줄어드는 것을 반영 */
        fun lateralAzimuth(x: Double, y: Double): Double {
            val lat = Math.toDegrees(kotlin.math.asin(x.coerceIn(-1.0, 1.0)))
            return if (y >= 0) lat else (if (lat >= 0) 180.0 - lat else -180.0 - lat)
        }

        private const val LN10_20 = 0.11512925f // ln(10)/20 : dB → 배율
        private const val MAX_DB = 8f
    }
}
