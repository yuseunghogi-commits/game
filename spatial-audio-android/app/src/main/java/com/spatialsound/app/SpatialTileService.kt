package com.spatialsound.app

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** 빠른 설정 패널(상단 내리기)에서 3D 사운드를 켜고 끄는 타일. */
class SpatialTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        render()
    }

    override fun onClick() {
        super.onClick()
        val s = SpatialSettings.load(this)
        val next = s.copy(enabled = !s.enabled)
        next.save(this)
        try {
            if (SoundController.sync(this)) openAppToStart()
        } catch (t: Throwable) {
            // 일부 기기에서 백그라운드 시작이 막히면 원래대로 되돌린다.
            s.save(this)
        }
        render()
    }

    /** 강력 모드는 '오디오 공유 허용' 창이 필요해서 앱 화면을 연다 */
    private fun openAppToStart() {
        val i = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_START, true)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(i)
        }
    }

    private fun render() {
        val tile = qsTile ?: return
        val on = SpatialSettings.load(this).enabled
        tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "3D 사운드"
        tile.updateTile()
    }

    companion object {
        fun requestUpdate(context: Context) {
            runCatching {
                requestListeningState(context, ComponentName(context, SpatialTileService::class.java))
            }
        }
    }
}
