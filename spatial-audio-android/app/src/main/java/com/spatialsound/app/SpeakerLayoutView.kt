package com.spatialsound.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
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
 * 가운데가 내 머리(위쪽 = 정면). 실선 원 = 귀 높이: 보라색 = 앞 스피커, 하늘색 = 뒤 스피커,
 * 노란색 = 가운데 스피커, 청록색 = 옆 스피커(공간 모드 실측 엔진).
 * ▲ = 천장 스피커 (앞 2개·뒤 2개), ▼ = 바닥 스피커 2개.
 *
 * 높이는 머리에서의 거리로 표시한다 (위에서 내려다본 돔):
 *  귀 높이 = 실선 원, 안쪽으로 갈수록 높이(머리 바로 옆 = 바로 위), 실선 원 바깥 = 아래.
 * 모든 스피커는 손가락으로 끌어서 옮길 수 있다 (좌우는 항상 대칭).
 */
class SpeakerLayoutView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null,
) : View(context, attrs) {

    /** 높이가 있는 스피커 한 쌍 (좌우 대칭): 좌우 각도와 높이(도, 아래 −) */
    class HeightPair(
        var angle: Float, var elev: Float,
        val minAngle: Float, val maxAngle: Float, val minElev: Float, val maxElev: Float,
    )

    var frontAngle = 50f; private set
    var rearAngle = 120f; private set
    /** 0 = 천장 앞, 1 = 천장 뒤, 2 = 바닥 */
    val heightPairs = arrayOf(
        HeightPair(45f, 45f, TOP_ANGLE_MIN.toFloat(), TOP_ANGLE_MAX.toFloat(), TOP_ELEV_MIN.toFloat(), TOP_ELEV_MAX.toFloat()),
        HeightPair(135f, 45f, TOP_REAR_MIN.toFloat(), TOP_REAR_MAX.toFloat(), TOP_ELEV_MIN.toFloat(), TOP_ELEV_MAX.toFloat()),
        HeightPair(45f, -30f, BOTTOM_ANGLE_MIN.toFloat(), BOTTOM_ANGLE_MAX.toFloat(), BOTTOM_ELEV_MIN.toFloat(), BOTTOM_ELEV_MAX.toFloat()),
    )
    var rearLevel = 45f
        set(v) { field = v; invalidate() }
    /** 가운데 스피커 양 (0 = 안 그림) */
    var centerLevel = 0f
        set(v) { field = v; invalidate() }
    /** 옆 스피커(±95°) 표시 — 실측 엔진의 배경음 스피커 */
    var showSides = false
        set(v) { field = v; invalidate() }
    /** 천장 스피커 양 (0 = 안 그림) */
    var heightLevel = 0f
        set(v) { field = v; invalidate() }
    /** 바닥 스피커 양 (0 = 안 그림) */
    var bottomLevel = 0f
        set(v) { field = v; invalidate() }
    /** 헤드 트래킹 중이면 머리를 돌려서 표시 */
    var headYaw = 0f
        set(v) { if (abs(field - v) > 0.5f) { field = v; invalidate() } }

    /** (앞 각도, 뒤 각도, 손을 뗐는지) */
    var onChange: ((Int, Int, Boolean) -> Unit)? = null
    /** 높이 스피커 (어느 쌍 0/1/2, 각도, 높이, 손을 뗐는지) */
    var onHeightChange: ((Int, Int, Int, Boolean) -> Unit)? = null

    private val dp = resources.displayMetrics.density
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = 1.5f * dp; color = Color.argb(70, 200, 200, 230)
    }
    private val ringDash = Paint(ring).apply {
        strokeWidth = 1f * dp; pathEffect = DashPathEffect(floatArrayOf(3 * dp, 4 * dp), 0f)
    }
    private val headFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x3A, 0x3A, 0x4E) }
    private val earFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x55, 0x55, 0x70) }
    private val nose = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0xDD, 0xDD, 0xEE) }
    private val front = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x9E, 0x8C, 0xFF) }
    private val rear = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x5C, 0xC8, 0xFF) }
    private val center = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0xFF, 0xD1, 0x5C) }
    private val sideP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x4F, 0xD1, 0xB0) }
    private val topPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0xF4, 0xF1, 0xFF) }
    private val bottomPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0xF0, 0xA0, 0x5A) }
    private val beam = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeWidth = 1.5f * dp }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(0xCC, 0xCC, 0xDD); textSize = 12f * dp; textAlign = Paint.Align.CENTER
    }

    private var dragging = 0 // 0 없음, 1 앞, 2 뒤, 10+i 높이 스피커 i

    companion object {
        private const val SIDE = 95f // HrtfRenderer.SIDE_ANGLE
        const val TOP_ANGLE_MIN = 0; const val TOP_ANGLE_MAX = 90
        const val TOP_REAR_MIN = 90; const val TOP_REAR_MAX = 180
        const val TOP_ELEV_MIN = 30; const val TOP_ELEV_MAX = 85
        const val BOTTOM_ANGLE_MIN = 0; const val BOTTOM_ANGLE_MAX = 180
        const val BOTTOM_ELEV_MIN = -40; const val BOTTOM_ELEV_MAX = -10
        /** 바닥(아래 40°)까지 그릴 여유: 귀 높이 원 바깥으로 (반지름 − 머리 여백) × 40/90 */
        private const val BELOW = 40f / 90f
    }

    fun setAngles(f: Int, r: Int) {
        frontAngle = f.toFloat(); rearAngle = r.toFloat(); invalidate()
    }

    /** 높이 스피커 위치 (which: 0 천장 앞, 1 천장 뒤, 2 바닥) */
    fun setHeightPair(which: Int, angle: Int, elev: Int) {
        val p = heightPairs[which]
        p.angle = angle.toFloat().coerceIn(p.minAngle, p.maxAngle)
        p.elev = elev.toFloat().coerceIn(p.minElev, p.maxElev)
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(w, w)
    }

    private val cx get() = width / 2f
    private val cy get() = height / 2f
    /** 머리와 겹치지 않게 띄우는 거리 (바로 위 = 이 거리) */
    private val clear get() = 34 * dp
    /** 귀 높이 원 반지름 — 바깥에 바닥 스피커와 글자 자리를 남김 */
    private val radius get() = (min(width, height) / 2f - 18 * dp + clear * BELOW) / (1f + BELOW)

    /** 높이 → 머리에서 거리 (높이에 비례): 0° = 귀 높이 원, 90° = 머리 바로 옆, 아래(−)는 원 바깥 */
    private fun elevDist(el: Float) = radius - (radius - clear) * el / 90f
    private fun elevFromDist(d: Float) = (radius - d) / (radius - clear) * 90f

    private fun pos(angleDeg: Float, r: Float = radius): Pair<Float, Float> {
        val a = Math.toRadians(angleDeg.toDouble())
        return (cx + r * sin(a)).toFloat() to (cy - r * cos(a)).toFloat()
    }

    private fun pairPos(p: HeightPair, side: Float) = pos(p.angle * side, elevDist(p.elev))

    private fun shown(i: Int) = if (i < 2) heightLevel > 0f else bottomLevel > 0f

    override fun onDraw(c: Canvas) {
        val outer = elevDist(BOTTOM_ELEV_MIN.toFloat())
        c.drawCircle(cx, cy, radius, ring)
        c.drawText("앞", cx, cy - outer - 4 * dp, text)
        c.drawText("뒤", cx, cy + outer + 14 * dp, text)
        text.textSize = 10f * dp
        text.alpha = 140
        if (heightLevel > 0f) {
            c.drawCircle(cx, cy, elevDist(60f), ringDash)
            c.drawText("점선 = 위 60°", cx, cy + elevDist(60f) + 13 * dp, text)
        }
        if (bottomLevel > 0f) {
            c.drawCircle(cx, cy, elevDist(-30f), ringDash)
            c.drawText("아래 30°", cx + elevDist(-30f) * 0.72f, cy + elevDist(-30f) * 0.72f + 14 * dp, text)
        }
        text.alpha = 255
        text.textSize = 12f * dp

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

        // 천장(▲) · 바닥(▼) 스피커
        for (i in heightPairs.indices) {
            if (!shown(i)) continue
            val p = heightPairs[i]
            val up = i < 2
            val paint = if (up) topPaint else bottomPaint
            val level = if (up) heightLevel else bottomLevel
            paint.alpha = if (dragging == 10 + i) 255 else (90 + 165 * level / 100f).toInt()
            val k = (if (dragging == 10 + i) 1.3f else 1f) * dp
            for (s in listOf(1f, -1f)) {
                val (x, y) = pairPos(p, s)
                val path = Path().apply {
                    if (up) { moveTo(x, y - 10 * k); lineTo(x - 9 * k, y + 7 * k); lineTo(x + 9 * k, y + 7 * k) }
                    else { moveTo(x, y + 10 * k); lineTo(x - 9 * k, y - 7 * k); lineTo(x + 9 * k, y - 7 * k) }
                    close()
                }
                c.drawPath(path, paint)
            }
        }

        // 귀 높이 스피커
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

        // 끄는 동안 왼쪽 위에 정확한 값 (손가락에 가려지지 않게)
        if (dragging >= 10) {
            val p = heightPairs[dragging - 10]
            val e = p.elev.toInt()
            val name = arrayOf("천장 앞 ▲", "천장 뒤 ▲", "바닥 ▼")[dragging - 10]
            text.textAlign = Paint.Align.LEFT
            text.textSize = 12.5f * dp
            c.drawText(name, 8 * dp, 18 * dp, text)
            c.drawText("±${p.angle.toInt()}° · " + (if (e >= 0) "위 $e°" else "아래 ${-e}°"), 8 * dp, 35 * dp, text)
            text.textAlign = Paint.Align.CENTER
        }
        text.textSize = 12f * dp
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val dx = e.x - cx
        val dy = e.y - cy
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // 가장 가까운 스피커 잡기 (좌우 어느 쪽이든)
                fun dist(x: Float, y: Float) = hypot(x - e.x, y - e.y)
                val cands = mutableListOf<Pair<Int, Float>>()
                cands += 1 to listOf(frontAngle, -frontAngle).minOf { val (x, y) = pos(it); dist(x, y) }
                cands += 2 to listOf(rearAngle, -rearAngle).minOf { val (x, y) = pos(it); dist(x, y) }
                for (i in heightPairs.indices) if (shown(i)) {
                    cands += (10 + i) to listOf(1f, -1f).minOf { val (x, y) = pairPos(heightPairs[i], it); dist(x, y) }
                }
                val best = cands.minBy { it.second }
                dragging = if (best.second < 40 * dp) best.first else 0
                if (dragging != 0) parent?.requestDisallowInterceptTouchEvent(true)
                invalidate()
                return dragging != 0
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragging == 0) return false
                // 위쪽이 0°, 좌우 대칭이므로 절댓값
                val ang = abs(Math.toDegrees(atan2(dx.toDouble(), -dy.toDouble()))).toFloat()
                if (dragging >= 10) {
                    // 방향 → 좌우 각도, 머리에서 거리 → 높이
                    val i = dragging - 10
                    val p = heightPairs[i]
                    p.angle = ang.coerceIn(p.minAngle, p.maxAngle)
                    p.elev = elevFromDist(hypot(dx, dy)).coerceIn(p.minElev, p.maxElev)
                    onHeightChange?.invoke(i, p.angle.toInt(), p.elev.toInt(), false)
                    invalidate()
                    return true
                }
                if (dragging == 1) frontAngle = ang.coerceIn(0f, 90f)
                else rearAngle = ang.coerceIn(90f, 180f)
                onChange?.invoke(frontAngle.toInt(), rearAngle.toInt(), false)
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging >= 10) {
                    val i = dragging - 10
                    onHeightChange?.invoke(i, heightPairs[i].angle.toInt(), heightPairs[i].elev.toInt(), true)
                } else if (dragging != 0) onChange?.invoke(frontAngle.toInt(), rearAngle.toInt(), true)
                dragging = 0
                invalidate()
                return true
            }
        }
        return super.onTouchEvent(e)
    }
}
