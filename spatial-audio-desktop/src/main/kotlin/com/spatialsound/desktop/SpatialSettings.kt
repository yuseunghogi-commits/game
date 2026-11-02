package com.spatialsound.app

/** 데스크톱용 설정 (안드로이드 SpatialSettings 와 3D 엔진이 쓰는 필드가 같음). */
data class SpatialSettings(
    val virtualizerStrength: Int = 850, // 3D 강도 0..1000
    val bassStrength: Int = 250,        // 저음 0..1000
    val spaceEq: Int = 45,              // 방 울림 0..100
    val reverbPreset: Int = 2,          // 잔향(방 크기) 0..6
    val width: Int = 65,                // 좌우 넓이 0..100
)

data class SoundPreset(val name: String, val s: SpatialSettings)

val SOUND_PRESETS = listOf(
    SoundPreset("음악 (자연스러운 입체감)", SpatialSettings(850, 250, 45, 2, 65)),
    SoundPreset("영화관", SpatialSettings(1000, 500, 60, 3, 80)),
    SoundPreset("콘서트홀", SpatialSettings(950, 300, 55, 5, 60)),
    SoundPreset("게임 (발소리/방향감)", SpatialSettings(1000, 200, 35, 1, 95)),
    SoundPreset("보컬/팟캐스트", SpatialSettings(650, 50, 30, 1, 30)),
)

val REVERB_NAMES = listOf("없음", "작은 방", "중간 방", "큰 방", "중간 홀", "큰 홀", "플레이트")
