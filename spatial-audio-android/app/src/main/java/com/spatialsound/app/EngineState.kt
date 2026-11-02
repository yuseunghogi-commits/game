package com.spatialsound.app

import android.os.Handler
import android.os.Looper

/** 서비스 → 화면으로 상태를 전달하는 간단한 공유 상태. */
object EngineState {
    data class Snapshot(
        val running: Boolean = false,
        val headphones: Boolean = false,
        val headphoneName: String = "",
        val globalOk: Boolean = false,
        val globalVirtualizerOk: Boolean = false,
        val globalHasControl: Boolean = true,
        /** 세션 ID → 패키지 이름 (세션을 알려준 음악 앱들) */
        val sessions: Map<Int, String> = emptyMap(),
        // --- 강력 3D 모드 ---
        val strongRunning: Boolean = false,
        val dumpGranted: Boolean = false,
        /** 원래 소리를 음소거 중인 앱 */
        val mutedApps: List<String> = emptyList(),
        /** 캡처를 막아 둔 앱 (강력 모드 적용 불가) */
        val restrictedApps: Set<String> = emptySet(),
        // --- 헤드 트래킹 ---
        val headTrackingOn: Boolean = false,
        val headSensor: String = "",
        val headYaw: Double = 0.0,
    )

    @Volatile
    var snapshot = Snapshot()
        private set

    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<(Snapshot) -> Unit>()

    fun update(transform: (Snapshot) -> Snapshot) {
        snapshot = transform(snapshot)
        val s = snapshot
        main.post { listeners.toList().forEach { it(s) } }
    }

    fun addListener(l: (Snapshot) -> Unit) {
        listeners += l
        l(snapshot)
    }

    fun removeListener(l: (Snapshot) -> Unit) {
        listeners -= l
    }
}
