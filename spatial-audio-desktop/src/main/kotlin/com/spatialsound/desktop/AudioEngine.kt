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
                // 넉넉한 장치 버퍼: 입력은 스레드가 잠깐 멈춰도 넘치지 않게, 출력은 Elastic 목표(최대 8블록) + 여유
                inLine.open(fmt, frames * 4 * (Elastic.MAX_BLOCKS + 4))
                outLine.open(fmt, frames * 4 * (Elastic.MAX_BLOCKS + 6))
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

    /** 시험용: 주어진 줄(가짜 장치)로 처리 루프를 이 스레드에서 돌림 — 다른 스레드에서 [stop] 으로 끝냄 */
    internal fun runForTest(inLine: TargetDataLine, outLine: SourceDataLine, rate: Int) {
        sampleRate = rate
        val p = BinauralProcessor(rate).also { it.setParams(current); it.bypass = bypass }
        dsp = p
        running = true
        loop(inLine, outLine, p, 512)
    }

    /** 상태 표시용: 출력 쪽 지연(ms, 엔진 처리 지연 제외) · 끊김(출력이 빈) 횟수 · 시계 보정(ppm) */
    @Volatile var bufferMs = 0.0
        private set
    @Volatile var dropouts = 0
        private set
    @Volatile var driftPpm = 0.0
        private set

    private fun loop(inLine: TargetDataLine, outLine: SourceDataLine, p: BinauralProcessor, frames: Int) {
        val bytes = ByteArray(frames * 4)
        val f = FloatArray(frames * 2)
        val el = Elastic(frames)
        val outF = FloatArray(el.maxPull * 2)
        val outB = ByteArray(el.maxPull * 4)
        val outCap = outLine.bufferSize / 4
        var started = false
        try {
            // 장치를 돌리기 전에: 실측 HRTF 표를 만들고(첫 블록에서 0.1~0.3초 걸림) 처리 코드를 데워 둠
            // → 시작하자마자 한 번 끊기던 것 방지
            val warm = FloatArray(frames * 2)
            repeat(WARMUP_BLOCKS) { java.util.Arrays.fill(warm, 0f); p.process(warm, frames) }
            inLine.start()
            while (running) {
                val n = inLine.read(bytes, 0, bytes.size)
                if (n <= 0) continue
                val m = n / 4
                for (i in 0 until m * 2) {
                    val v = (bytes[2 * i].toInt() and 0xff) or (bytes[2 * i + 1].toInt() shl 8)
                    f[i] = v / 32768f
                }
                p.process(f, m)
                el.push(f, m)
                // 출력 장치에 남은 양 · 입력에 밀린 양 → Elastic 이 미리 채우기·시계 차이 보정·끊김 뒤 여유 늘리기
                val fill = if (started) (outCap - outLine.available() / 4).coerceAtLeast(0) else 0
                val backlog = inLine.available() / 4
                val k = el.pull(outF, fill, backlog)
                for (i in 0 until k * 2) {
                    val v = (outF[i] * 32767f).toInt().coerceIn(-32768, 32767)
                    outB[2 * i] = v.toByte()
                    outB[2 * i + 1] = (v shr 8).toByte()
                }
                if (k > 0) outLine.write(outB, 0, k * 4)
                if (!started) { outLine.start(); started = true } // 미리 채운 뒤에 재생 시작
                bufferMs = el.latencyMs(sampleRate)
                dropouts = el.underruns
                driftPpm = (el.ratio - 1.0) * 1e6
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
        /** 시작 전에 무음으로 미리 돌려 볼 블록 수 (약 0.4초 분량) */
        private const val WARMUP_BLOCKS = 40
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
