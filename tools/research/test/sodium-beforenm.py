import nacl.bindings as sodium

# HSalsa20 on curve25519 shared secret
# Let's test with the captured vectors
dev_pubs = [
    # Vector 0
    bytes.fromhex("6559142a5e849dd89e778c210a7f1c78da567236869d22fba0ccf707bd576968"),
    bytes.fromhex("0d102a92494208f2e7429e4192a6671ba423d3074fc4e0e54b72343f1aee6d7c"),
    bytes.fromhex("21f76ce3dbc62a1dc7336243bf31c1a92f1076abe21c5f57079c63777a268d7a"),
]

pubs = [
    bytes.fromhex("0ccba0614bebb4e7c3c0e467ffe5a47e4f1f769443f4fbff4bc9afc8b8edf12d"),
    bytes.fromhex("9048c3f9cd38561c24e0ff94faf0482263c066543320da916b8bd7dd5b73bf02"),
    bytes.fromhex("c8c80db5fba3bd60535b2fbe31063676d8cbed2dde03f4385e5a1841c9cf1c40"),
]

keys = [
    bytes.fromhex("fc639c2ec4167ee22f4dd023b113c9e46adbb18e427dd0fdaea48286dd54d3cf"),
    bytes.fromhex("9461184abf94f783a19f92767030b1a169d4f67ddd1127671400624a6fab90ab"),
    bytes.fromhex("2743f758746a3e61b30c98b3533208904d599a0610d38932d5d18a9eddec61a5"),
]

for i in range(3):
    # Try beforenm(pk, sk) or beforenm(sk, pk)
    try:
        k1 = sodium.crypto_box_beforenm(dev_pubs[i], pubs[i])
        if k1 == keys[i]:
            print(f"🎉 Vector {i} crypto_box_beforenm MATCH!")
        else:
            print(f"Vector {i} k1={k1.hex()[:16]} vs key={keys[i].hex()[:16]}")
    except Exception as e:
        print(f"Vector {i} err:", e)
