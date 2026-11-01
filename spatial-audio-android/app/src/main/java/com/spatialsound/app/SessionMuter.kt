package com.spatialsound.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.audiofx.DynamicsProcessing
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.Process
import android.util.Log
import org.lsposed.hiddenapibypass.HiddenApiBypass
import java.io.FileInputStream

/**
 * 강력 3D 모드에서 "원래 소리"를 끄는 역할.
 *
 * 캡처한 소리를 직접 처리해서 다시 내보내므로, 유튜브 원래 소리가 그대로 나가면 소리가 두 번 들린다.
 * 그래서 재생 중인 앱의 오디오 세션마다 입력 게인 -200dB 짜리 DynamicsProcessing 을 붙여 음소거한다.
 * (내부 오디오 캡처는 이 이펙트 앞에서 소리를 가져가므로 캡처 쪽은 그대로 들어온다.
 *  RootlessJamesDSP 가 쓰는 것과 같은 방법.)
 *
 * 다른 앱의 세션 번호는 일반 API로는 알 수 없어서 시스템 오디오 서비스의 덤프를 읽는다.
 * 이를 위해 한 번만 ADB 로 DUMP 권한을 줘야 한다:
 *   adb shell pm grant com.spatialsound.app android.permission.DUMP
 */
class SessionMuter(private val context: Context) {

    data class Session(val id: Int, val uid: Int, val pkg: String)

    private val muted = mutableMapOf<Int, Pair<Session, DynamicsProcessing>>()
    private val myUid = Process.myUid()

    /** 지금 음소거 중인 앱 목록 (화면 표시용) */
    val mutedPackages: List<String> get() = muted.values.map { it.first.pkg }.distinct()

    /** 캡처를 막아 둔 앱(넷플릭스·크롬 등) — 음소거하면 아예 안 들리므로 건드리지 않는다 */
    var restrictedPackages: Set<String> = emptySet()
        private set

    fun hasDumpPermission() = hasDumpPermission(context)

    /** 덤프를 읽어 새 세션은 음소거, 사라진 세션은 정리. 1초마다 호출. */
    fun poll() {
        if (!hasDumpPermission()) return
        val found = findSessions()
        // 사라진 세션 해제
        val gone = muted.keys - found.keys
        gone.forEach { id -> muted.remove(id)?.second?.let { release(it) } }
        // 제어권을 잃은(다른 앱이 가져간) 세션은 다시 만들기
        muted.entries.filter { !runCatching { it.value.second.hasControl() }.getOrDefault(false) }
            .map { it.key }.forEach { id -> muted.remove(id)?.second?.let { release(it) } }
        // 새 세션 음소거
        for ((id, s) in found) {
            if (muted.containsKey(id)) continue
            if (s.uid == myUid || s.pkg in EXCLUDED || s.pkg in restrictedPackages) continue
            val fx = mute(id) ?: continue
            muted[id] = s to fx
            Log.i(TAG, "음소거: session=$id pkg=${s.pkg}")
        }
    }

    fun releaseAll() {
        muted.values.forEach { release(it.second) }
        muted.clear()
    }

    private fun mute(session: Int): DynamicsProcessing? = try {
        DynamicsProcessing(Int.MAX_VALUE, session, null).apply {
            setInputGainAllChannelsTo(-200f)
            setEnabled(true)
        }
    } catch (t: Throwable) {
        Log.w(TAG, "세션 $session 음소거 실패: ${t.message}")
        null
    }

    private fun release(fx: DynamicsProcessing) {
        runCatching { fx.setEnabled(false); fx.release() }
    }

    // --- 덤프 파싱 -----------------------------------------------------------

    private fun findSessions(): Map<Int, Session> {
        val result = mutableMapOf<Int, Session>()

        dump("media.audio_policy")?.let { d ->
            val restricted = mutableSetOf<String>()
            CAPTURE_ALLOWED.findAll(d).forEach { m ->
                val pkg = m.groupValues[2].removePrefix("shared:")
                if (m.groupValues[1].trim().lowercase() != "true") restricted += pkg
            }
            restrictedPackages = restricted
            for (re in listOf(POLICY_SESSION_29, POLICY_SESSION_33)) {
                re.findAll(d).forEach { m ->
                    val id = m.groupValues[1].toIntOrNull() ?: return@forEach
                    val uid = m.groupValues[2].toIntOrNull() ?: return@forEach
                    if (isRecordable(m.groupValues[4])) result[id] = Session(id, uid, pkgOf(uid))
                }
            }
        }
        if (result.isEmpty()) {
            dump("audio")?.let { d ->
                AUDIO_PLAYBACK.findAll(d).forEach { m ->
                    val uid = m.groupValues[1].toIntOrNull() ?: return@forEach
                    val id = m.groupValues[5].toIntOrNull() ?: return@forEach
                    if (id > 0 && isRecordable(m.groupValues[3])) result[id] = Session(id, uid, pkgOf(uid))
                }
            }
        }
        return result
    }

    private fun isRecordable(usage: String): Boolean {
        val u = usage.uppercase()
        return "MEDIA" in u || "GAME" in u || "UNKNOWN" in u
    }

    private fun pkgOf(uid: Int): String =
        context.packageManager.getPackagesForUid(uid)?.firstOrNull() ?: uid.toString()

    private fun dump(service: String): String? {
        val binder = getService(service) ?: return null
        return try {
            val pipe = ParcelFileDescriptor.createPipe()
            binder.dumpAsync(pipe[1].fileDescriptor, arrayOf())
            pipe[1].close()
            FileInputStream(pipe[0].fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }
                .also { pipe[0].close() }
        } catch (t: Throwable) {
            Log.w(TAG, "$service 덤프 실패: ${t.message}")
            null
        }
    }

    private fun getService(name: String): IBinder? {
        val sm = runCatching { Class.forName("android.os.ServiceManager") }.getOrNull() ?: return null
        runCatching {
            return sm.getMethod("getService", String::class.java).invoke(null, name) as IBinder?
        }
        if (Build.VERSION.SDK_INT >= 28) {
            runCatching { return HiddenApiBypass.invoke(sm, null, "getService", name) as IBinder? }
        }
        return null
    }

    companion object {
        private const val TAG = "SessionMuter"

        fun hasDumpPermission(context: Context) =
            context.checkSelfPermission(Manifest.permission.DUMP) == PackageManager.PERMISSION_GRANTED

        const val GRANT_COMMAND = "adb shell pm grant com.spatialsound.app android.permission.DUMP"

        /** 음성비서처럼 음소거하면 곤란한 앱 */
        private val EXCLUDED = setOf(
            "com.google.android.googlequicksearchbox",
            "com.google.android.as",
            "com.samsung.android.bixby.agent",
            "com.samsung.android.visionintelligence",
        )

        // RootlessJamesDSP 의 덤프 정규식을 참고 (Android 버전마다 형식이 다름)
        private val POLICY_SESSION_29 =
            """Session Id:\s*(\d+)\s+UID:\s*(\d+)[\S\s]*?Attributes:[\S\s]*?Content type:\s*(\w+)\s*Usage:\s*(\w+)""".toRegex()
        private val POLICY_SESSION_33 =
            """Session ID:\s*(\d+);\s*uid \s*(\d+);[\S\s]*?Attributes:[\S\s]*?Content type:\s*(\w+)\s*Usage:\s*(\w+)""".toRegex()
        private val CAPTURE_ALLOWED =
            """allowPlaybackCapture=(\S+)(?:\s*,).+packageName=(\S+)""".toRegex()
        private val AUDIO_PLAYBACK =
            """AudioPlaybackConfiguration.*u/pid:(\d+)/(\d+).*usage=(\w+).*content=(\w+).*sessionId:(\d+)""".toRegex()
    }
}
