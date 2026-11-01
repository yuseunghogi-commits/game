package com.spatialsound.app

import android.media.audiofx.AudioEffect
import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.media.audiofx.PresetReverb
import android.media.audiofx.Virtualizer
import android.util.Log
import kotlin.math.ln

/**
 * 하나의 오디오 세션에 붙는 3D 음향 체인.
 *
 *  - Virtualizer : 헤드폰용 바이노럴 가상 서라운드 (3D 음향의 핵심)
 *  - BassBoost   : 저음 보강
 *  - Equalizer   : "공간 EQ" — 저역/초고역을 살려서 넓고 깊게 들리게 하는 V자 커브
 *  - PresetReverb: 방/홀 잔향 (세션 0에서는 보조 이펙트라 적용되지 않으므로 앱별 세션에서만 사용)
 *
 * 세션 0 = 기기 전체 출력 믹스. 안드로이드에서 공식적으로는 deprecated 이지만
 * 대부분의 기기에서 여전히 동작하며, 유튜브처럼 세션 ID를 알려주지 않는 앱에도 적용된다.
 */
class SpatialEngine(val sessionId: Int) {

    private var virtualizer: Virtualizer? = null
    private var bassBoost: BassBoost? = null
    private var equalizer: Equalizer? = null
    private var reverb: PresetReverb? = null

    /** 하나 이상 이펙트를 만들었으면 true */
    var isOpen = false
        private set

    /** 가상화(3D)를 실제로 걸 수 있었는지 */
    var virtualizerOk = false
        private set

    fun open(): Boolean {
        virtualizer = create("Virtualizer") { Virtualizer(PRIORITY, sessionId) }
        bassBoost = create("BassBoost") { BassBoost(PRIORITY, sessionId) }
        equalizer = create("Equalizer") { Equalizer(PRIORITY, sessionId) }
        if (sessionId != 0) {
            reverb = create("PresetReverb") { PresetReverb(PRIORITY, sessionId) }
        }
        virtualizerOk = virtualizer != null
        isOpen = virtualizer != null || bassBoost != null || equalizer != null || reverb != null
        return isOpen
    }

    /**
     * @param reverbOnly true 이면 잔향만 적용 (전체 출력에 이미 3D 처리가 걸려 있을 때
     *                   앱별 세션에 이중으로 가상화가 걸리지 않게 하기 위함)
     */
    fun apply(s: SpatialSettings, active: Boolean, headphones: Boolean, reverbOnly: Boolean = false) {
        val main = active && !reverbOnly
        virtualizer?.let { v ->
            safe("Virtualizer.apply") {
                if (v.strengthSupported) v.setStrength(s.virtualizerStrength.coerceIn(0, 1000).toShort())
                // 헤드폰이면 바이노럴(HRTF) 모드를 강제해서 진짜 3D 처리를 받는다.
                val mode = if (headphones) Virtualizer.VIRTUALIZATION_MODE_BINAURAL
                else Virtualizer.VIRTUALIZATION_MODE_AUTO
                runCatching { v.forceVirtualizationMode(mode) }
                v.setEnabled(main && s.virtualizerStrength > 0)
            }
        }
        bassBoost?.let { b ->
            safe("BassBoost.apply") {
                if (b.strengthSupported) b.setStrength(s.bassStrength.coerceIn(0, 1000).toShort())
                b.setEnabled(main && s.bassStrength > 0)
            }
        }
        equalizer?.let { eq ->
            safe("Equalizer.apply") {
                applySpaceEq(eq, s.spaceEq)
                eq.setEnabled(main && s.spaceEq > 0)
            }
        }
        reverb?.let { r ->
            safe("PresetReverb.apply") {
                r.preset = s.reverbPreset.toShort()
                r.setEnabled(active && s.reverbPreset != PresetReverb.PRESET_NONE.toInt())
            }
        }
    }

    /** 다른 앱이 이펙트 제어권을 가져갔는지 */
    fun hasControl(): Boolean = (virtualizer ?: equalizer ?: bassBoost)?.let {
        runCatching { it.hasControl() }.getOrDefault(false)
    } ?: false

    fun release() {
        listOf<AudioEffect?>(virtualizer, bassBoost, equalizer, reverb).forEach { e ->
            runCatching { e?.setEnabled(false); e?.release() }
        }
        virtualizer = null; bassBoost = null; equalizer = null; reverb = null
        isOpen = false
    }

    private fun applySpaceEq(eq: Equalizer, amount: Int) {
        val range = eq.bandLevelRange // [min, max] millibel
        val min = range[0].toInt()
        val max = range[1].toInt()
        val k = amount.coerceIn(0, 100) / 100f
        for (band in 0 until eq.numberOfBands) {
            val hz = eq.getCenterFreq(band.toShort()) / 1000f // mHz → Hz
            val gain = (spaceCurve(hz) * k).toInt().coerceIn(min, max)
            eq.setBandLevel(band.toShort(), gain.toShort())
        }
    }

    /**
     * 입체감 커브 (millibel). 로그 주파수 축에서 선형 보간.
     * 저역(공간의 바닥감) + 중고역 존재감(정위) + 초고역(공기감)을 올리고 중저역 탁함을 줄인다.
     */
    private fun spaceCurve(hz: Float): Float {
        val pts = CURVE
        if (hz <= pts.first().first) return pts.first().second
        if (hz >= pts.last().first) return pts.last().second
        for (i in 0 until pts.size - 1) {
            val (f0, g0) = pts[i]
            val (f1, g1) = pts[i + 1]
            if (hz in f0..f1) {
                val t = ((ln(hz) - ln(f0)) / (ln(f1) - ln(f0)))
                return g0 + (g1 - g0) * t
            }
        }
        return 0f
    }

    private inline fun <T> create(name: String, block: () -> T): T? = try {
        block()
    } catch (t: Throwable) {
        Log.w(TAG, "$name 생성 실패 (session=$sessionId): ${t.message}")
        null
    }

    private inline fun safe(name: String, block: () -> Unit) {
        try { block() } catch (t: Throwable) {
            Log.w(TAG, "$name 실패 (session=$sessionId): ${t.message}")
        }
    }

    companion object {
        private const val TAG = "SpatialEngine"
        /** 다른 이퀄라이저 앱보다 우선권을 갖기 위한 높은 우선순위 */
        private const val PRIORITY = 1000

        private val CURVE = listOf(
            60f to 450f,
            150f to 250f,
            400f to -150f,
            1000f to -50f,
            3000f to 250f,
            6000f to 300f,
            12000f to 500f,
        )
    }
}
