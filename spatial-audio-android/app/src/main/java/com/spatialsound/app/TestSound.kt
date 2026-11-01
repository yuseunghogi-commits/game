package com.spatialsound.app

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.random.Random

/**
 * 머리 주위를 한 바퀴 반 도는 테스트 사운드를 만든다.
 * 양 귀 시간차(ITD)·음량차(ILD)·머리 그림자(저역통과)를 직접 계산한 바이노럴 신호라서
 * 헤드폰으로 들으면 소리가 앞 → 오른쪽 → 뒤 → 왼쪽으로 이동하는 게 느껴진다.
 */
object TestSound {
    private const val RATE = 44100
    private const val SECONDS = 8
    private var track: AudioTrack? = null

    fun play() {
        stop()
        val pcm = generate()
        val t = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build()
            )
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

    private fun generate(): ShortArray {
        val n = RATE * SECONDS
        val rnd = Random(7)
        // 원음: 초당 5번 울리는 짧은 셰이커(노이즈 버스트) + 약한 톤 → 방향 판별이 쉬움
        val src = FloatArray(n)
        val burstLen = RATE / 10
        for (i in 0 until n) {
            val pos = i % (RATE / 5)
            val env = if (pos < burstLen) exp(-6f * pos / burstLen) else 0f
            val noise = rnd.nextFloat() * 2f - 1f
            val tone = sin(2 * PI * 660 * i / RATE).toFloat() * 0.25f
            src[i] = (noise * 0.8f + tone) * env
        }

        val out = ShortArray(n * 2)
        val maxItd = 0.00066 * RATE // ≈ 29 샘플
        var lpL = 0f
        var lpR = 0f
        for (i in 0 until n) {
            val progress = i.toDouble() / n
            val angle = progress * 3 * PI // 1.5바퀴 (0 = 정면, π/2 = 오른쪽)
            val s = sin(angle)
            val c = cos(angle)
            val itd = (maxItd * s).toInt()
            // 오른쪽에 있으면 왼쪽 귀가 늦게 듣는다
            val l = src.getOrElse(i - maxOf(itd, 0)) { 0f }
            val r = src.getOrElse(i - maxOf(-itd, 0)) { 0f }
            // 머리 그림자: 먼 쪽 귀는 작고 고음이 깎임. 뒤쪽이면 양쪽 다 약간 어둡게.
            val rear = if (c < 0) (-c).toFloat() * 0.35f else 0f
            val shadowL = (maxOf(s, 0.0).toFloat() * 0.8f + rear).coerceAtMost(0.9f)
            val shadowR = (maxOf(-s, 0.0).toFloat() * 0.8f + rear).coerceAtMost(0.9f)
            lpL += (1f - shadowL) * (l - lpL)
            lpR += (1f - shadowR) * (r - lpR)
            val gL = 1f - 0.55f * maxOf(s, 0.0).toFloat()
            val gR = 1f - 0.55f * maxOf(-s, 0.0).toFloat()
            // 시작·끝 페이드
            val fade = minOf(1.0, progress * 20, (1 - progress) * 20).toFloat()
            out[2 * i] = (lpL * gL * fade * 22000).toInt().coerceIn(-32767, 32767).toShort()
            out[2 * i + 1] = (lpR * gR * fade * 22000).toInt().coerceIn(-32767, 32767).toShort()
        }
        return out
    }

}
