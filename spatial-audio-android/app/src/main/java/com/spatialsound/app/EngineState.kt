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
