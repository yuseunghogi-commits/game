package com.spatialsound.app

import android.content.Context
import android.os.Build

/** 저장된 설정에 맞춰 기본 모드 / 강력 3D 모드 서비스를 켜고 끈다. */
object SoundController {

    fun strongSupported() = Build.VERSION.SDK_INT >= 29

    /**
     * @return true 이면 강력 3D 모드를 시작해야 하는데 사용자 동의(오디오 공유 허용)가 필요함
     *         → 화면(Activity)에서 동의 창을 띄워야 한다.
     */
    fun sync(context: Context): Boolean {
        val s = SpatialSettings.load(context)
        val strong = s.strongMode && strongSupported()

        // 기본 모드는 강력 모드와 동시에 켜지 않는다 (이중 처리 방지)
        if (s.enabled && !strong) SpatialAudioService.start(context) else SpatialAudioService.stop(context)

        if (!strongSupported()) return false
        if (!s.enabled || !strong) {
            if (Strong3DService.instance != null) Strong3DService.stop(context)
            return false
        }
        val running = Strong3DService.instance
        return if (running != null) {
            running.applySettings(s)
            false
        } else {
            true
        }
    }
}
