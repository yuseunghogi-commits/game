package com.spatialsound.app

/** 데스크톱용 설정 (안드로이드 SpatialSettings 와 3D 엔진이 쓰는 필드가 같음). */
data class SpatialSettings(
    val virtualizerStrength: Int = 1000, // 3D 강도 0..1000
    val bassStrength: Int = 250,        // 저음 0..1000
    val spaceEq: Int = 45,              // 방 울림 0..100
    val reverbPreset: Int = 2,          // 잔향(방 크기) 0..6
    val width: Int = 65,                // 좌우 분리 0..100
    val frontAngle: Int = 45,           // 앞 스피커 각도 ±0..90°
    val rearAngle: Int = 135,           // 뒤 스피커 각도 ±90..180°
    val rearLevel: Int = 45,            // 배경음 옆/뒤 비율 (기본 엔진: 뒤 스피커 양) 0..100
    val engineMode: Int = 1,            // 0 기본(모델), 1 공간(실측), 2 정위
    val spread: Int = 90,               // 정위 모드 방향 펼침 30..120°
    val earSize: Int = 2,               // 귀 맞춤 0..4
    val hpEq: Int = 0,                  // 헤드폰 보정 (0 = 끔)
    val centerLevel: Int = 70,          // 공간 모드: 가운데 스피커 비율 0..100
    val frontElev: Int = 0,             // 앞 스피커 높이 -20..40°
    val heightLevel: Int = 25,          // 높이감 (천장 스피커) 0..100
    val topAngle: Int = 45,             // 천장 앞 스피커 좌우 각도 ±0..90°
    val topElev: Int = 45,              // 천장 앞 스피커 높이 30..85°
    val topRearAngle: Int = 135,        // 천장 뒤 스피커 좌우 각도 ±90..180°
    val topRearElev: Int = 45,          // 천장 뒤 스피커 높이 30..85°
    val bottomLevel: Int = 10,          // 바닥 스피커 비율 0..100
    val bottomAngle: Int = 45,          // 바닥 스피커 좌우 각도 ±0..180°
    val bottomElev: Int = -30,          // 바닥 스피커 높이 -40..-10°
    val enhance: Int = 30,              // 3D 강조 0..100
    val timbre: Int = 30,               // 음색 보정 0..100 (낮을수록 3D 느낌, 높을수록 원음 음색. 0 = v2.0, 100 = v2.1)
    val near: Int = 15,                 // 스침 효과 0..100 (한쪽으로 치우친 소리를 귀 바로 옆에서 지나가듯)
    val spin: Int = 0,                  // 8D 회전 0..100 (소리 전체가 머리 둘레를 돎, 0 = 끔)
)

data class SoundPreset(val name: String, val s: SpatialSettings)

val SOUND_PRESETS = listOf(
    SoundPreset("음악 (자연스러운 입체감)", SpatialSettings(1000, 250, 45, 2, 65, 45, 135, 45, centerLevel = 60, heightLevel = 25, frontElev = 0, bottomLevel = 10, enhance = 30, near = 15)),
    SoundPreset("영화관", SpatialSettings(1000, 500, 60, 3, 80, 55, 130, 65, centerLevel = 85, heightLevel = 40, frontElev = 5, bottomLevel = 20, enhance = 50, near = 50)),
    SoundPreset("콘서트홀", SpatialSettings(1000, 300, 55, 5, 60, 40, 140, 55, centerLevel = 50, heightLevel = 35, frontElev = 0, bottomLevel = 10, enhance = 30, near = 0)),
    SoundPreset("게임 (발소리/방향감)", SpatialSettings(1000, 200, 35, 1, 95, 60, 130, 50, centerLevel = 70, heightLevel = 15, frontElev = 0, bottomLevel = 15, enhance = 80, near = 70)),
    SoundPreset("보컬/팟캐스트", SpatialSettings(850, 50, 30, 1, 30, 35, 140, 20, centerLevel = 90, heightLevel = 10, frontElev = 0, bottomLevel = 0, enhance = 10, near = 0)),
    // 확실하게 3D: 큰 방 울림 더, 앞 스피커 ±60°, 배경음 옆·뒤 더, 천장·바닥 더, 3D 강조 최대, 스침
    SoundPreset("🔥 강력 3D (확실하게)", SpatialSettings(1000, 350, 70, 3, 65, 60, 130, 75, centerLevel = 50, heightLevel = 40, frontElev = 0, bottomLevel = 20, enhance = 100, near = 50)),
    // 강력 3D + 소리 전체가 머리 둘레를 15초에 한 바퀴 (음악용)
    SoundPreset("🌀 8D 회전 (머리 둘레를 돎)", SpatialSettings(1000, 300, 60, 3, 65, 60, 130, 70, centerLevel = 50, heightLevel = 35, frontElev = 0, bottomLevel = 15, enhance = 100, near = 40, spin = 40)),
)

val REVERB_NAMES = listOf("없음", "작은 방", "중간 방", "큰 방", "중간 홀", "큰 홀", "플레이트")
