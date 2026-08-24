import sys
from capstone import *
from capstone.arm import *

so_path = "/Users/resonaura/softjelly/aqara-g5pro-mqtt/apk/Aqara+Home_6.3.9_APKPure/config.armeabi_v7a/lib/armeabi-v7a/liblumidevsdk.so"

with open(so_path, "rb") as f:
    elf_data = f.read()

file_offset_base = 0x5e36c
va_base = 0x5f36c

def get_code(va, size):
    off = va - va_base + file_offset_base
    return elf_data[off:off+size]

md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)

code = get_code(0x60a44, 0x60de8 - 0x60a44)
for ins in md.disasm(code, 0x60a44):
    print(f"0x{ins.address:08x}:  {ins.mnemonic:10s} {ins.op_str}")
