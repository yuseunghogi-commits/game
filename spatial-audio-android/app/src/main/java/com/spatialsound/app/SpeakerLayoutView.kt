package com.spatialsound.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin

/**
 * 위에서 내려다본 가상 스피커 배치도.
 * 가운데가 내 머리(위쪽 = 정면), 보라색 = 앞 스피커, 하늘색 = 뒤 스피커,
 * 노란색 = 가운데 스피커, 청록색 = 옆 스피커(공간 모드 실측 엔진).
 * 앞/뒤 스피커를 손가락으로 끌면 각도가 바뀐다 (좌우는 항상 대칭).
 */
class SpeakerLayoutView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null,
) : View(context, attrs) {

    var frontAngle = 50f; private set
    var rearAngle = 120f; private set
    var rearLevel = 45f
        set(v) { field = v; invalidate() }
    /** 가운데 스피커 양 (0 = 안 그림) */
    var centerLevel = 0f
        set(v) { field = v; invalidate() }
    /** 옆 스피커(±95°) 표시 — 실측 엔진의 배경음 스피커 */
    var showSides = false
        set(v) { field = v; invalidate() }
    /** 헤드 트래킹 중이면 머리를 돌려서 표시 */
    var headYaw = 0f
        set(v) { if (abs(field - v) > 0.5f) { field = v; invalidate() } }

    /** (앞 각도, 뒤 각도, 손을 뗐는지) */
    var onChange: ((Int, Int, Boolean) -> Unit)? = null

    private val dp = resources.displayMetrics.density
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = 1.5f * dp; color = Color.argb(70, 200, 200, 230)
    }
    private val headFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x3A, 0x3A, 0x4E) }
    private val earFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x55, 0x55, 0x70) }
    private val nose = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0xDD, 0xDD, 0xEE) }
    private val front = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x9E, 0x8C, 0xFF) }
    private val rear = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x5C, 0xC8, 0xFF) }
    private val center = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0xFF, 0xD1, 0x5C) }
    private val sideP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x4F, 0xD1, 0xB0) }
    private val beam = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeWidth = 1.5f * dp }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(0xCC, 0xCC, 0xDD); textSize = 12f * dp; textAlign = Paint.Align.CENTER
    }

    private var dragging = 0 // 0 없음, 1 앞, 2 뒤

    companion object {
        private const val SIDE = 95f // HrtfRenderer.SIDE_ANGLE
    }

    fun setAngles(f: Int, r: Int) {
        frontAngle = f.toFloat(); rearAngle = r.toFloat(); invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(w, (w * 0.85f).toInt())
    }

    private val cx get() = width / 2f
    private val cy get() = height / 2f
    private val radius get() = min(width, height) / 2f - 26 * dp

    private fun pos(angleDeg: Float): Pair<Float, Float> {
        val a = Math.toRadians(angleDeg.toDouble())
        return (cx + radius * sin(a)).toFloat() to (cy - radius * cos(a)).toFloat()
    }

    override fun onDraw(c: Canvas) {
        c.drawCircle(cx, cy, radius, ring)
        c.drawCircle(cx, cy, radius * 0.5f, ring)
        c.drawText("앞", cx, cy - radius - 8 * dp, text)
        c.drawText("뒤", cx, cy + radius + 18 * dp, text)

        // 스피커 → 머리 방향 빔
        for ((ang, p, alpha) in listOf(
            Triple(frontAngle, front, 255), Triple(-frontAngle, front, 255),
            Triple(rearAngle, rear, (80 + 175 * rearLevel / 100f).toInt()),
            Triple(-rearAngle, rear, (80 + 175 * rearLevel / 100f).toInt()),
        )) {
            val (x, y) = pos(ang)
            beam.color = p.color; beam.alpha = alpha / 3
            c.drawLine(x, y, cx, cy, beam)
        }

        // 머리 (헤드 트래킹 각도만큼 회전)
        c.save()
        c.rotate(headYaw, cx, cy)
        val hr = 22 * dp
        c.drawRoundRect(RectF(cx - hr - 6 * dp, cy - 7 * dp, cx - hr + 3 * dp, cy + 7 * dp), 4 * dp, 4 * dp, earFill)
        c.drawRoundRect(RectF(cx + hr - 3 * dp, cy - 7 * dp, cx + hr + 6 * dp, cy + 7 * dp), 4 * dp, 4 * dp, earFill)
        c.drawCircle(cx, cy, hr, headFill)
        c.drawCircle(cx, cy - hr + 5 * dp, 3.5f * dp, nose)
        c.restore()

        // 가운데 / 옆 스피커 (끌 수 없음, 표시만)
        if (centerLevel > 0f) {
            val (x, y) = pos(0f)
            center.alpha = (90 + 165 * centerLevel / 100f).toInt()
            c.drawCircle(x, y, 11 * dp, center)
            c.drawText("C", x, y - 16 * dp, text)
        }
        if (showSides) {
            for (s in listOf(1f, -1f)) {
                val (x, y) = pos(SIDE * s)
                sideP.alpha = (80 + 175 * rearLevel / 100f).toInt()
                c.drawCircle(x, y, 9 * dp, sideP)
            }
        }

        // 스피커
        val sr = 13 * dp
        for (s in listOf(1f, -1f)) {
            val (fx, fy) = pos(frontAngle * s)
            c.drawCircle(fx, fy, if (dragging == 1) sr * 1.25f else sr, front)
            val (rx, ry) = pos(rearAngle * s)
            rear.alpha = (80 + 175 * rearLevel / 100f).toInt()
            c.drawCircle(rx, ry, if (dragging == 2) sr * 1.25f else sr * (0.7f + 0.3f * rearLevel / 100f), rear)
        }
        text.textSize = 11f * dp
        val (lx, ly) = pos(-frontAngle)
        c.drawText("L ${frontAngle.toInt()}°", lx, ly - 18 * dp, text)
        val (rx, ry) = pos(-rearAngle)
        c.drawText("뒤 ${rearAngle.toInt()}°", rx, ry + 28 * dp, text)
        text.textSize = 12f * dp
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val dx = e.x - cx
        val dy = e.y - cy
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // 가장 가까운 스피커 잡기 (좌우 어느 쪽이든)
                fun dist(a: Float) = listOf(a, -a).minOf { val (x, y) = pos(it); hypot(x - e.x, y - e.y) }
                val df = dist(frontAngle)
                val dr = dist(rearAngle)
                val grab = 40 * dp
                dragging = when {
                    df <= dr && df < grab -> 1
                    dr < grab -> 2
                    else -> 0
                }
                if (dragging != 0) parent?.requestDisallowInterceptTouchEvent(true)
                invalidate()
                return dragging != 0
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragging == 0) return false
                // 위쪽이 0°, 좌우 대칭이므로 절댓값
                val ang = abs(Math.toDegrees(atan2(dx.toDouble(), -dy.toDouble()))).toFloat()
                if (dragging == 1) frontAngle = ang.coerceIn(0f, 90f)
                else rearAngle = ang.coerceIn(90f, 180f)
                onChange?.invoke(frontAngle.toInt(), rearAngle.toInt(), false)
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging != 0) onChange?.invoke(frontAngle.toInt(), rearAngle.toInt(), true)
                dragging = 0
                invalidate()
                return true
            }
        }
        return super.onTouchEvent(e)
    }
}
