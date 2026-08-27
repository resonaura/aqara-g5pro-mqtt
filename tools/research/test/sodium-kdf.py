import hashlib
import nacl.bindings as sodium

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

print("Testing libsodium crypto primitives...")
for i, v in enumerate(vectors):
    target = v["key"]
    # 1. Scalarmult base with priv (should give pub)
    calc_pub = sodium.crypto_scalarmult_base(v["priv"])
    if calc_pub == v["pub"]:
        print(f"Vector {i}: priv -> pub MATCHES!")
    else:
        print(f"Vector {i}: pub mismatch! calc={calc_pub.hex()[:16]} vs given={v['pub'].hex()[:16]}")

    # 2. Test blake2b
    b2b = hashlib.blake2b(v["priv"], digest_size=32).digest()
    if b2b == target:
        print(f"🎉 Vector {i} BLAKE2b MATCH!")
    b2b_pub = hashlib.blake2b(v["pub"], digest_size=32).digest()
    if b2b_pub == target:
        print(f"🎉 Vector {i} BLAKE2b(pub) MATCH!")
