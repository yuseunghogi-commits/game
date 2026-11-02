package com.spatialsound.desktop

import com.spatialsound.app.BinauralProcessor
import com.spatialsound.app.SpatialSettings
import javax.sound.sampled.AudioFormat
import javax.sound.sampled.AudioSystem
import javax.sound.sampled.DataLine
import javax.sound.sampled.Mixer
import javax.sound.sampled.SourceDataLine
import javax.sound.sampled.TargetDataLine

/**
 * 입력 장치(가상 케이블)에서 소리를 받아 3D 처리 후 출력 장치(헤드폰)로 내보낸다.
 *
 *   유튜브/게임 등 → [Windows 출력: CABLE Input] → CABLE Output(입력) → 이 프로그램 → 헤드폰
 */
class AudioEngine(
    private val input: Mixer.Info,
    private val output: Mixer.Info,
    settings: SpatialSettings,
    private val onError: (String) -> Unit,
) {
    @Volatile private var running = false
    private var thread: Thread? = null
    private var dsp: BinauralProcessor? = null
    @Volatile private var current = settings
    @Volatile var bypass = false
        set(v) { field = v; dsp?.bypass = v }

    var sampleRate = 0
        private set

    fun update(s: SpatialSettings) {
        current = s
        dsp?.setParams(s)
    }

    fun start() {
        if (running) return
        var lastErr: Exception? = null
        for (rate in intArrayOf(48000, 44100)) {
            val fmt = AudioFormat(rate.toFloat(), 16, 2, true, false)
            try {
                val inLine = AudioSystem.getMixer(input)
                    .getLine(DataLine.Info(TargetDataLine::class.java, fmt)) as TargetDataLine
                val outLine = AudioSystem.getMixer(output)
                    .getLine(DataLine.Info(SourceDataLine::class.java, fmt)) as SourceDataLine
                val frames = 512
                inLine.open(fmt, frames * 4 * 4)
                outLine.open(fmt, frames * 4 * 6)
                sampleRate = rate
                val p = BinauralProcessor(rate).also { it.setParams(current); it.bypass = bypass }
                dsp = p
                running = true
                thread = Thread({ loop(inLine, outLine, p, frames) }, "3d-audio").apply {
                    priority = Thread.MAX_PRIORITY
                    isDaemon = true
                    start()
                }
                return
            } catch (e: Exception) {
                lastErr = e
            }
        }
        onError("오디오 장치를 열 수 없습니다: ${lastErr?.message}")
    }

    fun stop() {
        running = false
        thread?.join(1000)
        thread = null
        dsp = null
    }

    val isRunning get() = running

    private fun loop(inLine: TargetDataLine, outLine: SourceDataLine, p: BinauralProcessor, frames: Int) {
        val bytes = ByteArray(frames * 4)
        val f = FloatArray(frames * 2)
        try {
            inLine.start()
            outLine.start()
            while (running) {
                val n = inLine.read(bytes, 0, bytes.size)
                if (n <= 0) continue
                val samples = n / 2
                for (i in 0 until samples) {
                    val v = (bytes[2 * i].toInt() and 0xff) or (bytes[2 * i + 1].toInt() shl 8)
                    f[i] = v / 32768f
                }
                p.process(f, samples / 2)
                for (i in 0 until samples) {
                    val v = (f[i] * 32767f).toInt().coerceIn(-32768, 32767)
                    bytes[2 * i] = v.toByte()
                    bytes[2 * i + 1] = (v shr 8).toByte()
                }
                outLine.write(bytes, 0, n)
            }
        } catch (e: Exception) {
            running = false
            onError("오디오 처리 중 오류: ${e.message}")
        } finally {
            runCatching { inLine.stop(); inLine.close() }
            runCatching { outLine.drain(); outLine.stop(); outLine.close() }
        }
    }

    companion object {
        private val probe = AudioFormat(48000f, 16, 2, true, false)

        /** 녹음(입력)이 가능한 장치 */
        fun inputs(): List<Mixer.Info> = AudioSystem.getMixerInfo().filter {
            runCatching { AudioSystem.getMixer(it).isLineSupported(DataLine.Info(TargetDataLine::class.java, probe)) }
                .getOrDefault(false) && !it.name.startsWith("Port ")
        }

        /** 재생(출력)이 가능한 장치 */
        fun outputs(): List<Mixer.Info> = AudioSystem.getMixerInfo().filter {
            runCatching { AudioSystem.getMixer(it).isLineSupported(DataLine.Info(SourceDataLine::class.java, probe)) }
                .getOrDefault(false) && !it.name.startsWith("Port ")
        }
    }
}
