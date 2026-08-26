import hashlib
import hmac
import struct
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# Test vectors from REPORT.md
vectors = [
    {
        "pub": bytes.fromhex("0ccba0614bebb4e7c3c0e467ffe5a47e4f1f769443f4fbff4bc9afc8b8edf12d"),
        "priv": bytes.fromhex("6559142a5e849dd89e778c210a7f1c78da567236869d22fba0ccf707bd576968"),
        "key": bytes.fromhex("fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf"),
        "did": b"lumi1.54ef4477da68",
    },
    {
        "pub": bytes.fromhex("9048c3f9cd38561c24e0ff94faf0482263c066543320da916b8bd7dd5b73bf02"),
        "priv": bytes.fromhex("0d102a92494208f2e7429e4192a6671ba423d3074fc4e0e54b72343f1aee6d7c"),
        "key": bytes.fromhex("9461184abf94f783a19f92767030b1a169d4f67ddd1127671400624a6fab90ab"),
        "did": b"lumi3.a5e395b63ce5e6de",
    },
    {
        "pub": bytes.fromhex("c8c80db5fba3bd60535b2fbe31063676d8cbed2dde03f4385e5a1841c9cf1c40"),
        "priv": bytes.fromhex("21f76ce3dbc62a1dc7336243bf31c1a92f1076abe21c5f57079c63777a268d7a"),
        "key": bytes.fromhex("2743f758746a3e61b30c98b3533208904d599a0610d38932d5d18a9eddec61a5"),
        "did": b"lumi1.54ef4477da68",
    }
]

print("Testing direct hash formulas...")

# Test standard direct hash transforms on (pub, priv, did)
for i, v in enumerate(vectors):
    target = v["key"]
    # Try SHA256(priv), SHA256(pub), SHA256(pub + priv), SHA256(priv + did), etc.
    candidates = {
        "sha256(priv)": hashlib.sha256(v["priv"]).digest(),
        "sha256(pub)": hashlib.sha256(v["pub"]).digest(),
        "sha256(priv+pub)": hashlib.sha256(v["priv"] + v["pub"]).digest(),
        "sha256(pub+priv)": hashlib.sha256(v["pub"] + v["priv"]).digest(),
        "sha256(priv+did)": hashlib.sha256(v["priv"] + v["did"]).digest(),
        "sha256(did+priv)": hashlib.sha256(v["did"] + v["priv"]).digest(),
        "sha256(pub+did)": hashlib.sha256(v["pub"] + v["did"]).digest(),
        "sha512(priv)[:32]": hashlib.sha512(v["priv"]).digest()[:32],
        "sha512(pub)[:32]": hashlib.sha512(v["pub"]).digest()[:32],
        "hmac_sha256(priv, pub)": hmac.new(v["priv"], v["pub"], hashlib.sha256).digest(),
        "hmac_sha256(pub, priv)": hmac.new(v["pub"], v["priv"], hashlib.sha256).digest(),
        "hmac_sha256(priv, did)": hmac.new(v["priv"], v["did"], hashlib.sha256).digest(),
        "hmac_sha256(did, priv)": hmac.new(v["did"], v["priv"], hashlib.sha256).digest(),
    }
    for name, cand in candidates.items():
        if cand == target:
            print(f"🎉 MATCH FOUND for vector {i}: {name}")

print("Done direct formula scan.")
