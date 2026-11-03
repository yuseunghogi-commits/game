"""APK 서명 키를 '항상 같은 키'로 만든다 (앱 덮어쓰기·자동 업데이트에 필요).

저장소 비밀값 APK_SIGNING_SECRET 이 있으면, 그 값에서 RSA 키와 인증서를 결정적으로 만든다
→ 어느 빌드에서 만들어도 똑같은 서명이 나온다 (키를 어디에도 저장할 필요 없음).
비밀값이 없으면 아무것도 하지 않는다 (워크플로가 캐시에 보관한 키를 쓰거나 새로 만든다).

사용: python3 apk_signing_key.py <출력.p12> <비밀번호>
"""
import datetime
import hashlib
import hmac
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID


class Drbg:
    """HMAC-SHA256 카운터 방식 난수열 (같은 씨앗 → 같은 수열)."""

    def __init__(self, seed: bytes):
        self.key = seed
        self.n = 0

    def bytes(self, k: int) -> bytes:
        out = b""
        while len(out) < k:
            self.n += 1
            out += hmac.new(self.key, self.n.to_bytes(8, "big"), hashlib.sha256).digest()
        return out[:k]

    def int_bits(self, bits: int) -> int:
        return int.from_bytes(self.bytes((bits + 7) // 8), "big") >> ((8 - bits % 8) % 8)


SMALL_PRIMES = [p for p in range(3, 2000) if all(p % d for d in range(2, int(p ** 0.5) + 1))]


def is_probable_prime(n: int, rng: Drbg, rounds: int = 64) -> bool:
    if n < 2:
        return False
    for p in SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        a = 2 + rng.int_bits(n.bit_length()) % (n - 3)
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def gen_prime(rng: Drbg, bits: int, e: int) -> int:
    while True:
        c = rng.int_bits(bits) | (0b11 << (bits - 2)) | 1  # 위 두 비트 = 1 → n 이 정확히 2048비트
        if (c - 1) % e != 0 and is_probable_prime(c, rng):
            return c


def main():
    out, password = sys.argv[1], sys.argv[2]
    secret = os.environ.get("APK_SIGNING_SECRET", "")
    if not secret:
        print("APK_SIGNING_SECRET 없음 → 캐시 키 사용")
        return
    # 비밀값을 느린 KDF 로 늘려서 씨앗으로 (짧은 비밀번호 추측을 어렵게)
    seed = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), b"3dsound-apk-signing-v1", 1_000_000, 32)
    rng = Drbg(seed)
    e = 65537
    p = gen_prime(rng, 1024, e)
    q = gen_prime(rng, 1024, e)
    while q == p:
        q = gen_prime(rng, 1024, e)
    if p < q:
        p, q = q, p
    n = p * q
    assert n.bit_length() == 2048
    d = pow(e, -1, (p - 1) * (q - 1))
    key = rsa.RSAPrivateNumbers(
        p=p, q=q, d=d, dmp1=d % (p - 1), dmq1=d % (q - 1), iqmp=pow(q, -1, p),
        public_numbers=rsa.RSAPublicNumbers(e, n),
    ).private_key()
    # 인증서도 날짜·일련번호를 고정 → 인증서 바이트까지 매번 같음 (RSA PKCS#1 v1.5 서명은 결정적)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "3DSound")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(int.from_bytes(rng.bytes(8), "big") >> 1 | 1)
        .not_valid_before(datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        .not_valid_after(datetime.datetime(2125, 12, 31, tzinfo=datetime.timezone.utc))
        .sign(key, hashes.SHA256())
    )
    data = pkcs12.serialize_key_and_certificates(
        b"spatialsound", key, cert, None, serialization.BestAvailableEncryption(password.encode()),
    )
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "wb") as f:
        f.write(data)
    fp = hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()
    print("고정 서명 키 생성 · 인증서 SHA-256", ":".join(fp[i:i + 2] for i in range(0, 16, 2)), "…")


if __name__ == "__main__":
    main()
