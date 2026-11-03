package com.spatialsound.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.util.Log

/**
 * 업데이트 설치 진행 상황(PackageInstaller)과 '업데이트 완료'(MY_PACKAGE_REPLACED)를 받는다.
 */
class UpdateReceiver : BroadcastReceiver() {

    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            AppUpdater.ACTION_INSTALL_STATUS -> onStatus(ctx, intent)
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                // 업데이트하면서 앱이 재시작되므로 3D 도 꺼진다 → 다시 켜도록 안내
                val open = PendingIntent.getActivity(
                    ctx, 0,
                    Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                AppUpdater.notify(
                    ctx, "✅ v${AppUpdater.currentVersion(ctx)} 업데이트 완료",
                    "눌러서 3D 사운드 열기 (업데이트하면서 꺼졌다면 다시 켜 주세요)", open,
                )
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun onStatus(ctx: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        Log.i("UpdateReceiver", "install status=$status $msg")
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm == null) return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // 앱 화면이 떠 있으면 바로 확인 창, 막히면 알림을 눌러서
                runCatching { ctx.startActivity(confirm) }
                val pi = PendingIntent.getActivity(
                    ctx, 3, confirm, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                AppUpdater.notify(ctx, "업데이트 준비 완료", "눌러서 설치하기", pi)
            }
            PackageInstaller.STATUS_SUCCESS -> {
                ctx.getSystemService(NotificationManager::class.java).cancel(AppUpdater.NID_UPDATE)
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                // 사용자가 취소함 → 조용히
                ctx.getSystemService(NotificationManager::class.java).cancel(AppUpdater.NID_UPDATE)
            }
            else -> {
                val text = when (status) {
                    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                        "서명이 달라 덮어쓰기가 안 됩니다. 앱을 지운 뒤 릴리스 페이지에서 새로 설치해 주세요"
                    PackageInstaller.STATUS_FAILURE_STORAGE -> "저장 공간이 부족합니다"
                    else -> "업데이트 실패" + (msg?.let { " ($it)" } ?: "")
                }
                val page = PendingIntent.getActivity(
                    ctx, 4, Intent(Intent.ACTION_VIEW, Uri.parse(AppUpdater.RELEASES_PAGE)),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                AppUpdater.notify(ctx, "업데이트 안 됨", text, page)
            }
        }
    }
}
