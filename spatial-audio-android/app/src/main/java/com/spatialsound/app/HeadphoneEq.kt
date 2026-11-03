package com.spatialsound.app

import java.io.InputStream
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 헤드폰 보정 EQ.
 *
 * 3D 음향은 "평평한" 헤드폰을 가정하고 계산하는데, 실제 헤드폰은 모델마다 특정 대역을 강조하거나 깎는다.
 * 특히 2~10kHz 의 좁은 봉우리/골짜기는 귀가 방향(앞/뒤·위/아래)을 알아차리는 단서와 겹쳐서 3D 를 흐린다.
 * 측정 데이터로 만든 보정 EQ 를 마지막에 걸어 헤드폰 고유 음색을 상쇄한다.
 *
 * 데이터: AutoEq (Jaakko Pasanen, MIT License) 결과 — assets/headphone_eq.txt (tools/build_hp_eq.py)
 * 측정 출처는 모델마다 다름 (Rtings, oratory1990, HypetheSonics …). Harman 계열 목표 곡선 기준.
 */
object HeadphoneEq {

    data class Filter(val type: String, val fc: Double, val gainDb: Double, val q: Double)
    data class Profile(val name: String, val source: String, val preampDb: Double, val filters: List<Filter>)

    /** 앱 시작 시 한 번 불러 둔다 */
    @Volatile var profiles: List<Profile> = emptyList()

    /** 화면 표시용 이름 목록 (0번 = 끄기) */
    fun names(): List<String> = listOf("끄기 (보정 안 함)") + profiles.map { it.name }

    fun parse(input: InputStream): List<Profile> {
        val out = mutableListOf<Profile>()
        var name: String? = null
        var source = ""
        var pre = 0.0
        val filters = mutableListOf<Filter>()
        fun flush() {
            name?.let { out += Profile(it, source, pre, filters.toList()) }
            filters.clear(); pre = 0.0
        }
        input.bufferedReader(Charsets.UTF_8).forEachLine { raw ->
            val ln = raw.trim()
            when {
                ln.isEmpty() || ln.startsWith("#") -> Unit
                ln.startsWith("[") && ln.endsWith("]") -> {
                    flush()
                    val parts = ln.substring(1, ln.length - 1).split("|")
                    name = parts[0]
                    source = parts.getOrElse(1) { "" }
                }
                ln.startsWith("preamp ") -> pre = ln.removePrefix("preamp ").trim().toDouble()
                else -> {
                    val p = ln.split(Regex("\\s+"))
                    if (p.size == 4 && p[0] in setOf("PK", "LSC", "HSC")) {
                        filters += Filter(p[0], p[1].toDouble(), p[2].toDouble(), p[3].toDouble())
                    }
                }
            }
        }
        flush()
        return out
    }

    private const val MAKEUP_MAX_DB = 3.5

    /** 스테레오 바이쿼드 묶음 (RBJ 쿡북, 배정밀도 상태) */
    class Chain(profile: Profile, fs: Int) {
        private val n = profile.filters.size
        private val b0 = DoubleArray(n); private val b1 = DoubleArray(n); private val b2 = DoubleArray(n)
        private val a1 = DoubleArray(n); private val a2 = DoubleArray(n)
        // 전치 직접형 II 상태 [필터][채널]
        private val z1 = Array(n) { DoubleArray(2) }
        private val z2 = Array(n) { DoubleArray(2) }
        /**
         * AutoEq 프리앰프(부스트로 깨지지 않게 미리 낮춘 볼륨)는 최대 3.5dB 까지 되돌림 — 그대로 두면 3D 를 켰을 때
         * 원음보다 작게 들려서(Bose QC 2023: -3.6dB) 밋밋하게 느껴짐. 실제 최고점 -1dBFS 음원에서도 처리 후 최고점
         * -0.9dBFS 로 여유가 있고, 넘는 순간은 끝단 리미터가 잡음 (측정상 리미터로 잃는 음량 0.0dB).
         */
        private val pre = 10.0.pow((profile.preampDb + min(-profile.preampDb, MAKEUP_MAX_DB)) / 20.0)

        init {
            for ((i, f) in profile.filters.withIndex()) {
                val fc = f.fc.coerceAtMost(fs * 0.45)
                val a = 10.0.pow(f.gainDb / 40.0)
                val w0 = 2 * PI * fc / fs
                val cw = cos(w0)
                val alpha = sin(w0) / (2 * f.q)
                val sa = 2 * sqrt(a) * alpha
                var nb0: Double; var nb1: Double; var nb2: Double
                var na0: Double; var na1: Double; var na2: Double
                when (f.type) {
                    "LSC" -> {
                        nb0 = a * ((a + 1) - (a - 1) * cw + sa)
                        nb1 = 2 * a * ((a - 1) - (a + 1) * cw)
                        nb2 = a * ((a + 1) - (a - 1) * cw - sa)
                        na0 = (a + 1) + (a - 1) * cw + sa
                        na1 = -2 * ((a - 1) + (a + 1) * cw)
                        na2 = (a + 1) + (a - 1) * cw - sa
                    }
                    "HSC" -> {
                        nb0 = a * ((a + 1) + (a - 1) * cw + sa)
                        nb1 = -2 * a * ((a - 1) + (a + 1) * cw)
                        nb2 = a * ((a + 1) + (a - 1) * cw - sa)
                        na0 = (a + 1) - (a - 1) * cw + sa
                        na1 = 2 * ((a - 1) - (a + 1) * cw)
                        na2 = (a + 1) - (a - 1) * cw - sa
                    }
                    else -> { // PK
                        nb0 = 1 + alpha * a
                        nb1 = -2 * cw
                        nb2 = 1 - alpha * a
                        na0 = 1 + alpha / a
                        na1 = -2 * cw
                        na2 = 1 - alpha / a
                    }
                }
                b0[i] = nb0 / na0; b1[i] = nb1 / na0; b2[i] = nb2 / na0
                a1[i] = na1 / na0; a2[i] = na2 / na0
            }
        }

        /** 채널 ch(0=왼쪽, 1=오른쪽) 샘플 하나 처리 */
        fun process(x: Float, ch: Int): Float {
            var v = x * pre
            for (i in 0 until n) {
                val y = b0[i] * v + z1[i][ch]
                z1[i][ch] = b1[i] * v - a1[i] * y + z2[i][ch]
                z2[i][ch] = b2[i] * v - a2[i] * y
                v = y
            }
            return v.toFloat()
        }

        /** 주파수 응답 (dB) — 검증용 */
        fun responseDb(freq: Double, fs: Int): Double {
            val w = 2 * PI * freq / fs
            var mag = 20 * kotlin.math.log10(pre)
            for (i in 0 until n) {
                val c1 = cos(w); val s1 = sin(w); val c2 = cos(2 * w); val s2 = sin(2 * w)
                val nr = b0[i] + b1[i] * c1 + b2[i] * c2; val ni = -(b1[i] * s1 + b2[i] * s2)
                val dr = 1 + a1[i] * c1 + a2[i] * c2; val di = -(a1[i] * s1 + a2[i] * s2)
                mag += 10 * kotlin.math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
            }
            return mag
        }
    }
}
