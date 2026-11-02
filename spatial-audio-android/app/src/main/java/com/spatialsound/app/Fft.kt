package com.spatialsound.app

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** 반복형 radix-2 복소 FFT (제자리). n 은 2의 거듭제곱. */
class Fft(val n: Int) {
    private val cosT = FloatArray(n / 2) { cos(2 * PI * it / n).toFloat() }
    private val sinT = FloatArray(n / 2) { sin(2 * PI * it / n).toFloat() }
    private val rev = IntArray(n).also { r ->
        var bits = 0
        while (1 shl bits < n) bits++
        for (i in 0 until n) {
            var x = i; var y = 0
            for (b in 0 until bits) { y = (y shl 1) or (x and 1); x = x shr 1 }
            r[i] = y
        }
    }

    /** inverse = true 이면 역변환 (1/n 스케일 포함) */
    fun transform(re: FloatArray, im: FloatArray, inverse: Boolean = false) {
        for (i in 0 until n) {
            val j = rev[i]
            if (j > i) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        val sgn = if (inverse) 1f else -1f
        var len = 2
        while (len <= n) {
            val half = len / 2
            val step = n / len
            var i = 0
            while (i < n) {
                var k = 0
                for (j in i until i + half) {
                    val wr = cosT[k]; val wi = sgn * sinT[k]
                    val xr = re[j + half] * wr - im[j + half] * wi
                    val xi = re[j + half] * wi + im[j + half] * wr
                    re[j + half] = re[j] - xr; im[j + half] = im[j] - xi
                    re[j] += xr; im[j] += xi
                    k += step
                }
                i += len
            }
            len = len shl 1
        }
        if (inverse) {
            val s = 1f / n
            for (i in 0 until n) { re[i] *= s; im[i] *= s }
        }
    }
}
