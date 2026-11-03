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
    val virtualizerStrength: Int = 850,
    /** 저음 보강 0..1000 */
    val bassStrength: Int = 250,
    /** 공간 EQ(입체감 커브) 0..100 */
    val spaceEq: Int = 45,
    /** PresetReverb 프리셋 (세션 단위 적용 앱에서만 동작) */
    val reverbPreset: Int = PresetReverb.PRESET_MEDIUMROOM.toInt(),
    val presetIndex: Int = 0,
    /** true = 강력 3D 모드 (내부 오디오 캡처 + 직접 계산) */
    val strongMode: Boolean = false,
    /** 강력 모드: 좌우 넓이 0..100 (가상 스피커 각도 ±30°~±70° + 좌우 차이 강조) */
    val width: Int = 55,
    /** 강력 모드: 앞 스피커 각도 ±0~90° */
    val frontAngle: Int = 50,
    /** 강력 모드: 뒤 스피커 각도 ±90~180° */
    val rearAngle: Int = 135,
    /** 강력 모드: 뒤 스피커 소리 양 0..100 */
    val rearLevel: Int = 45,
    /** 강력 모드 엔진: 0 = 기본(머리 모델), 1 = 공간(실측 HRTF), 2 = 정위(방향 또렷) */
    val engineMode: Int = 1,
    /** 정위 모드: 스테레오 끝이 놓일 각도 30..120° */
    val spread: Int = 90,
    /** 귀 맞춤 단계 0..4 (2 = 기본) */
    val earSize: Int = 2,
    /** 공간 모드(실측): 가운데 스피커로 보낼 가운데 성분 비율 0..100 */
    val centerLevel: Int = 70,
    /** 헤드폰 보정 프로필 (0 = 끔, n = HeadphoneEq.profiles[n-1]) */
    val hpEq: Int = 0,
    /** 강력 모드 헤드 트래킹 장치: 0 = 끔, 1 = 갤럭시 버즈(블루투스 직접), 2 = 이어폰 표준 머리 센서(Android 13+) */
    val headSource: Int = 0,
    /** 헤드 트래킹 방향이 반대로 느껴질 때 */
    val headInvert: Boolean = false,
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
            .putInt("width", width)
            .putInt("headSource", headSource)
            .putInt("frontAngle", frontAngle)
            .putInt("rearAngle", rearAngle)
            .putInt("rearLevel", rearLevel)
            .putInt("engineMode", engineMode)
            .putInt("spread", spread)
            .putInt("earSize", earSize)
            .putInt("hpEq", hpEq)
            .putInt("centerLevel", centerLevel)
            .putBoolean("headInvert", headInvert)
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
                width = p.getInt("width", d.width),
                // 예전 버전의 켜기/끄기 스위치(표준 센서)를 새 선택으로 옮김
                headSource = if (p.contains("headSource")) p.getInt("headSource", 0)
                else if (p.getBoolean("headTracking", false)) 2 else 0,
                frontAngle = p.getInt("frontAngle", d.frontAngle),
                rearAngle = p.getInt("rearAngle", d.rearAngle),
                rearLevel = p.getInt("rearLevel", d.rearLevel),
                engineMode = p.getInt("engineMode", d.engineMode),
                spread = p.getInt("spread", d.spread),
                earSize = p.getInt("earSize", d.earSize),
                hpEq = p.getInt("hpEq", d.hpEq),
                centerLevel = p.getInt("centerLevel", d.centerLevel),
                headInvert = p.getBoolean("headInvert", d.headInvert),
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
    val width: Int,
    val front: Int = 50,
    val rearAngle: Int = 120,
    val rearLevel: Int = 45,
    val center: Int = 70,
)

val SOUND_PRESETS = listOf(
    // 이름, 3D 강도, 저음, 방 울림/공간감, 잔향(방 크기), 좌우 넓이
    // … 좌우 분리, 앞 스피커 각도, 뒤 스피커 각도, 배경음 옆/뒤 비율, 가운데 스피커
    SoundPreset("음악 (자연스러운 입체감)", 850, 250, 45, PresetReverb.PRESET_MEDIUMROOM, 65, 45, 135, 45, 60),
    SoundPreset("영화관", 1000, 500, 60, PresetReverb.PRESET_LARGEROOM, 80, 55, 130, 65, 85),
    SoundPreset("콘서트홀", 950, 300, 55, PresetReverb.PRESET_LARGEHALL, 60, 40, 140, 55, 50),
    SoundPreset("게임 (발소리/방향감)", 1000, 200, 35, PresetReverb.PRESET_SMALLROOM, 95, 60, 130, 50, 70),
    SoundPreset("보컬/팟캐스트", 650, 50, 30, PresetReverb.PRESET_SMALLROOM, 30, 35, 140, 20, 90),
    SoundPreset("사용자 설정", -1, -1, -1, PresetReverb.PRESET_NONE, -1),
)

val REVERB_NAMES = listOf("없음", "작은 방", "중간 방", "큰 방", "중간 홀", "큰 홀", "플레이트")
