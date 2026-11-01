package com.spatialsound.app

import android.content.Context
import android.media.audiofx.PresetReverb

/** 사용자가 고르는 3D 음향 설정 값. */
data class SpatialSettings(
    val enabled: Boolean = false,
    /** 세션 0(전체 출력)에 효과 적용 → 유튜브처럼 세션을 알려주지 않는 앱에도 적용 */
    val globalMode: Boolean = true,
    /** 헤드폰/이어폰이 연결됐을 때만 효과 켜기 */
    val headphonesOnly: Boolean = true,
    /** 가상 서라운드 강도 0..1000 */
    val virtualizerStrength: Int = 800,
    /** 저음 보강 0..1000 */
    val bassStrength: Int = 300,
    /** 공간 EQ(입체감 커브) 0..100 */
    val spaceEq: Int = 40,
    /** PresetReverb 프리셋 (세션 단위 적용 앱에서만 동작) */
    val reverbPreset: Int = PresetReverb.PRESET_NONE.toInt(),
    val presetIndex: Int = 0,
    /** true = 강력 3D 모드 (내부 오디오 캡처 + 직접 계산) */
    val strongMode: Boolean = false,
) {
    fun save(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("enabled", enabled)
            .putBoolean("globalMode", globalMode)
            .putBoolean("headphonesOnly", headphonesOnly)
            .putInt("virtualizer", virtualizerStrength)
            .putInt("bass", bassStrength)
            .putInt("spaceEq", spaceEq)
            .putInt("reverb", reverbPreset)
            .putInt("preset", presetIndex)
            .putBoolean("strongMode", strongMode)
            .apply()
    }

    companion object {
        private const val PREFS = "spatial_settings"

        fun load(context: Context): SpatialSettings {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val d = SpatialSettings()
            return SpatialSettings(
                enabled = p.getBoolean("enabled", d.enabled),
                globalMode = p.getBoolean("globalMode", d.globalMode),
                headphonesOnly = p.getBoolean("headphonesOnly", d.headphonesOnly),
                virtualizerStrength = p.getInt("virtualizer", d.virtualizerStrength),
                bassStrength = p.getInt("bass", d.bassStrength),
                spaceEq = p.getInt("spaceEq", d.spaceEq),
                reverbPreset = p.getInt("reverb", d.reverbPreset),
                presetIndex = p.getInt("preset", d.presetIndex),
                strongMode = p.getBoolean("strongMode", d.strongMode),
            )
        }
    }
}

/** 미리 만든 음향 프리셋. */
data class SoundPreset(
    val name: String,
    val virtualizer: Int,
    val bass: Int,
    val spaceEq: Int,
    val reverb: Short,
)

val SOUND_PRESETS = listOf(
    SoundPreset("음악 (자연스러운 입체감)", 650, 250, 35, PresetReverb.PRESET_NONE),
    SoundPreset("영화관", 1000, 550, 55, PresetReverb.PRESET_LARGEHALL),
    SoundPreset("콘서트홀", 900, 350, 45, PresetReverb.PRESET_MEDIUMHALL),
    SoundPreset("게임 (발소리/방향감)", 1000, 250, 70, PresetReverb.PRESET_SMALLROOM),
    SoundPreset("보컬/팟캐스트", 400, 50, 20, PresetReverb.PRESET_NONE),
    SoundPreset("사용자 설정", -1, -1, -1, PresetReverb.PRESET_NONE),
)

val REVERB_NAMES = listOf("없음", "작은 방", "중간 방", "큰 방", "중간 홀", "큰 홀", "플레이트")
