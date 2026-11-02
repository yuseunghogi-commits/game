package com.spatialsound.app

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.exp
import kotlin.random.Random

/**
 * 귀 맞춤 테스트음: 짧은 소리가 "앞 → 뒤 → 앞 → 뒤 → 왼쪽 → 오른쪽" 순서로 나온다.
 * 단계(머리/귀 크기)마다 실측 HRTF 를 다르게 늘여서 들려주고,
 * 앞/뒤가 가장 확실히 구분되는 단계를 사용자가 고른다.
 */
object EarFitTest {
    private const val FS = 48000
    private var track: AudioTrack? = null

    /** 순서대로 나오는 방향 (화면 안내용) */
    val SEQUENCE = listOf(0, 180, 0, 180, -90, 90)
    val SEQUENCE_TEXT = "앞 → 뒤 → 앞 → 뒤 → 왼쪽 → 오른쪽"

    fun play(base: HrirSet, earIdx: Int) {
        stop()
        val set = base.adapted(FS, HrirSet.EAR_FACTORS[earIdx.coerceIn(0, HrirSet.EAR_FACTORS.lastIndex)])
        val pcm = render(set)
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(FS).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .build()
        t.write(pcm, 0, pcm.size)
        t.play()
        track = t
    }

    fun stop() {
        track?.let { runCatching { it.stop(); it.release() } }
        track = null
    }

    private fun render(set: HrirSet): ShortArray {
        val seg = (FS * 0.65).toInt()       // 한 방향당 0.65초
        val burst = (FS * 0.35).toInt()
        val n = seg * SEQUENCE.size + set.taps
        val l = FloatArray(n); val r = FloatArray(n)
        val rnd = Random(11)
        for ((s, deg) in SEQUENCE.withIndex()) {
            val d = set.data[((deg + 360) % 360) / set.stepDeg]
            // 분홍 비슷한 잡음 버스트 (고음이 있어야 앞/뒤 단서가 들림), 0.07초 간격 3번
            val src = FloatArray(burst)
            var lp = 0f
            for (i in 0 until burst) {
                val k = i % (burst / 3)
                val env = if (k < burst / 4) exp(-k / (FS * 0.03f)) else 0f
                val w = rnd.nextFloat() * 2f - 1f
                lp = 0.6f * lp + 0.4f * w
                src[i] = (0.6f * w + 0.4f * lp) * env * 0.5f
            }
            val off = s * seg
            for (i in 0 until burst) {
                val v = src[i]
                if (v == 0f) continue
                for (k in 0 until set.taps) {
                    l[off + i + k] += v * d[0][k]
                    r[off + i + k] += v * d[1][k]
                }
            }
        }
        var peak = 1e-6f
        for (i in 0 until n) peak = maxOf(peak, kotlin.math.abs(l[i]), kotlin.math.abs(r[i]))
        val g = 0.8f / peak * 32767f
        return ShortArray(n * 2) { if (it % 2 == 0) (l[it / 2] * g).toInt().toShort() else (r[it / 2] * g).toInt().toShort() }
    }
}
