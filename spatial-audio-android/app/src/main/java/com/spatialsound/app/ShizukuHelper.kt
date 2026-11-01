package com.spatialsound.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import rikka.shizuku.Shizuku

/**
 * Shizuku 로 PC 없이 DUMP 권한을 스스로 부여한다.
 * Shizuku 는 무선 디버깅으로 ADB(shell) 권한을 얻어 다른 앱이 쓸 수 있게 해 주는 앱.
 */
object ShizukuHelper {
    private const val TAG = "ShizukuHelper"
    const val PACKAGE = "moe.shizuku.privileged.api"

    enum class State { NOT_INSTALLED, NOT_RUNNING, NO_PERMISSION, READY }

    fun state(context: Context): State = when {
        !isInstalled(context) -> State.NOT_INSTALLED
        !isRunning() -> State.NOT_RUNNING
        !hasPermission() -> State.NO_PERMISSION
        else -> State.READY
    }

    fun isInstalled(context: Context) = try {
        context.packageManager.getPackageInfo(PACKAGE, 0); true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    fun isRunning() = runCatching { Shizuku.pingBinder() }.getOrDefault(false)

    fun hasPermission() = runCatching {
        !Shizuku.isPreV11() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    fun requestPermission(code: Int) {
        runCatching { Shizuku.requestPermission(code) }
    }

    /** Shizuku(셸 권한)로 `pm grant ... DUMP` 실행. 성공하면 true. 메인 스레드가 아닌 곳에서 호출. */
    fun grantDump(context: Context): Boolean {
        return try {
            val m = Shizuku::class.java.getDeclaredMethod(
                "newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java,
            )
            m.isAccessible = true
            val cmd = arrayOf("pm", "grant", context.packageName, "android.permission.DUMP")
            val p = m.invoke(null, cmd, null, null) as Process
            val err = p.errorStream.bufferedReader().readText()
            val code = p.waitFor()
            if (code != 0) Log.w(TAG, "pm grant 실패 ($code): $err")
            SessionMuter.hasDumpPermission(context)
        } catch (t: Throwable) {
            Log.e(TAG, "Shizuku 명령 실행 실패", t)
            false
        }
    }

    fun openShizuku(context: Context) {
        val i = context.packageManager.getLaunchIntentForPackage(PACKAGE) ?: return
        context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun openStore(context: Context) {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$PACKAGE"))
        try {
            context.startActivity(market)
        } catch (e: Exception) {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$PACKAGE"))
            )
        }
    }

    fun openDeveloperOptions(context: Context) {
        try {
            context.startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
        } catch (e: Exception) {
            context.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS))
        }
    }
}
