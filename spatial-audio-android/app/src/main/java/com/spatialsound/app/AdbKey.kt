package com.spatialsound.app

import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 무선 디버깅(ADB) 연결에 쓰는 이 앱 전용 RSA 키 + 자체 서명 인증서.
 *
 * 페어링할 때 이 키의 공개키가 폰의 '페어링된 기기' 목록에 저장되고,
 * 이후 연결(TLS)에서 같은 키를 보여 줘야 adbd 가 받아 준다. 그래서 한 번 만들면 계속 같은 키를 쓴다.
 * 백업에 섞이지 않도록 noBackupFilesDir 에 보관한다.
 */
class AdbKey private constructor(val privateKey: PrivateKey, val certificate: X509Certificate) {

    companion object {
        private const val KEY_FILE = "adbkey.pk8"
        private const val CERT_FILE = "adbkey.crt"

        fun loadOrCreate(dir: File): AdbKey {
            dir.mkdirs()
            val kf = File(dir, KEY_FILE)
            val cf = File(dir, CERT_FILE)
            if (kf.isFile && cf.isFile) {
                runCatching {
                    val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(kf.readBytes()))
                    val cert = CertificateFactory.getInstance("X.509")
                        .generateCertificate(cf.inputStream().buffered()) as X509Certificate
                    return AdbKey(key, cert)
                }
            }
            val gen = KeyPairGenerator.getInstance("RSA")
            gen.initialize(2048, SecureRandom())
            val pair = gen.generateKeyPair()
            val der = selfSignedCertificate(pair.public.encoded, pair.private, "3DSound")
            val cert = CertificateFactory.getInstance("X.509")
                .generateCertificate(der.inputStream()) as X509Certificate
            // 임시 파일에 쓴 뒤 이름 바꾸기 → 중간에 꺼져도 반쪽짜리 키가 남지 않게
            writeAtomic(kf, pair.private.encoded)
            writeAtomic(cf, der)
            return AdbKey(pair.private, cert)
        }

        private fun writeAtomic(f: File, data: ByteArray) {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeBytes(data)
            if (!tmp.renameTo(f)) { f.writeBytes(data); tmp.delete() }
        }

        // --- 최소한의 X.509 v3 인증서 (DER) 만들기 ---------------------------------
        // Android 에는 인증서를 만드는 공개 API 가 없어서 직접 조립한다.

        private val OID_SHA256_RSA = byteArrayOf(
            0x2A, 0x86.toByte(), 0x48, 0x86.toByte(), 0xF7.toByte(), 0x0D, 0x01, 0x01, 0x0B
        ) // 1.2.840.113549.1.1.11
        private val OID_CN = byteArrayOf(0x55, 0x04, 0x03) // 2.5.4.3

        fun selfSignedCertificate(spki: ByteArray, key: PrivateKey, cn: String): ByteArray {
            val algId = seq(tlv(0x06, OID_SHA256_RSA), tlv(0x05, ByteArray(0)))
            val name = seq(tlv(0x31, seq(tlv(0x06, OID_CN), tlv(0x0C, cn.toByteArray(Charsets.UTF_8)))))
            val now = System.currentTimeMillis()
            val validity = seq(
                time(Date(now - 24L * 3600 * 1000)),
                time(Date(now + 30L * 365 * 24 * 3600 * 1000)),
            )
            val serial = BigInteger(63, SecureRandom()).add(BigInteger.ONE)
            val tbs = seq(
                tlv(0xA0, tlv(0x02, byteArrayOf(2))), // version v3
                tlv(0x02, serial.toByteArray()),
                algId,
                name,       // issuer = subject (자체 서명)
                validity,
                name,
                spki,       // PublicKey.getEncoded() 는 이미 SubjectPublicKeyInfo DER
            )
            val sig = Signature.getInstance("SHA256withRSA").run {
                initSign(key)
                update(tbs)
                sign()
            }
            return seq(tbs, algId, tlv(0x03, byteArrayOf(0) + sig))
        }

        /** 2049년까지는 UTCTime, 그 뒤는 GeneralizedTime (RFC 5280) */
        private fun time(d: Date): ByteArray {
            val utc = TimeZone.getTimeZone("UTC")
            val year = java.util.Calendar.getInstance(utc).apply { time = d }.get(java.util.Calendar.YEAR)
            return if (year < 2050) {
                tlv(0x17, SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US).apply { timeZone = utc }
                    .format(d).toByteArray(Charsets.US_ASCII))
            } else {
                tlv(0x18, SimpleDateFormat("yyyyMMddHHmmss'Z'", Locale.US).apply { timeZone = utc }
                    .format(d).toByteArray(Charsets.US_ASCII))
            }
        }

        private fun seq(vararg parts: ByteArray): ByteArray = tlv(0x30, concat(*parts))

        private fun concat(vararg parts: ByteArray): ByteArray {
            val out = ByteArrayOutputStream()
            for (p in parts) out.write(p)
            return out.toByteArray()
        }

        private fun tlv(tag: Int, value: ByteArray): ByteArray {
            val out = ByteArrayOutputStream()
            out.write(tag)
            val n = value.size
            when {
                n < 0x80 -> out.write(n)
                n < 0x100 -> { out.write(0x81); out.write(n) }
                n < 0x10000 -> { out.write(0x82); out.write(n shr 8); out.write(n and 0xFF) }
                else -> { out.write(0x83); out.write(n shr 16); out.write((n shr 8) and 0xFF); out.write(n and 0xFF) }
            }
            out.write(value)
            return out.toByteArray()
        }
    }
}
