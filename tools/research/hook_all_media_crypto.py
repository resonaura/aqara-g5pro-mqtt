import frida
import sys
import time

js_code = """
function bufToHex(buf, len) {
    if (!buf) return "null";
    try {
        var arr = [];
        var max = Math.min(len || 32, 64);
        for (var i = 0; i < max; i++) {
            var b = Memory.readU8(buf.add(i)).toString(16);
            arr.push(b.length === 1 ? "0" + b : b);
        }
        return arr.join("");
    } catch(e) {
        return "error:" + e;
    }
}

// 1. Hook native libaqara_ed.so
Process.enumerateModules().forEach(function(mod) {
    if (mod.name.indexOf("aqara_ed") !== -1 || mod.name.indexOf("lumidevsdk") !== -1 || mod.name.indexOf("PPCS") !== -1) {
        console.log("[*] Found module: " + mod.name + " at " + mod.base);
        mod.enumerateExports().forEach(function(exp) {
            if (exp.name.indexOf("ed_init") !== -1 ||
                exp.name.indexOf("create_cipher") !== -1 ||
                exp.name.indexOf("AqaraED_create") !== -1) {
                console.log("   --> Attaching to export: " + exp.name + " (" + exp.address + ")");
                Interceptor.attach(exp.address, {
                    onEnter: function(args) {
                        console.log("🔥🔥🔥 [NATIVE " + exp.name + "] CALLED!");
                        console.log("   Arg0: " + args[0]);
                        console.log("   Arg1 (hex): " + bufToHex(args[1], 32));
                        console.log("   Arg2: " + args[2]);
                        console.log("   Arg3 (hex): " + bufToHex(args[3], 16));
                    }
                });
            }
        });
    }
});

// 2. Hook Java layer
Java.perform(function() {
    console.log("[*] Hooking Java layer...");
    
    // AqaraED
    try {
        var AqaraED = Java.use("com.lumi.ed.AqaraED");
        AqaraED.create.overload('int', '[B').implementation = function(mode, key) {
            console.log("🔥🔥🔥 [Java AqaraED.create(mode=" + mode + ")]");
            var hex = [];
            for (var i = 0; i < key.length; i++) {
                var b = (key[i] & 0xFF).toString(16);
                hex.push(b.length === 1 ? "0" + b : b);
            }
            console.log("   🎉 KEY HEX: " + hex.join(""));
            return this.create(mode, key);
        };
    } catch(e) {}

    // Find any loaded classes related to P2P / Stream / Decrypt
    Java.enumerateLoadedClasses({
        onMatch: function(c) {
            if (c.indexOf("com.lumi") !== -1 && (c.indexOf("Decrypt") !== -1 || c.indexOf("Cipher") !== -1 || c.indexOf("Video") !== -1 || c.indexOf("P2P") !== -1 || c.indexOf("Camera") !== -1)) {
                if (c.indexOf("View") === -1 && c.indexOf("Binding") === -1 && c.indexOf("Activity") === -1) {
                    // console.log("   Loaded class: " + c);
                }
            }
        },
        onComplete: function() {}
    });
});
"""

def on_message(message, data):
    if message['type'] == 'send':
        print(f"[Frida] {message['payload']}", flush=True)
    elif message['type'] == 'log':
        print(f"[Frida Log] {message['payload']}", flush=True)
    else:
        print(f"[Frida Msg] {message}", flush=True)

device = frida.get_usb_device()
import subprocess
res = subprocess.run(["adb", "shell", "pidof", "com.lumiunited.aqarahome.play"], capture_output=True, text=True)
pid = int(res.stdout.strip().split()[0])
print(f"Attaching to PID {pid}...", flush=True)
session = device.attach(pid)
script = session.create_script(js_code)
script.on('message', on_message)
script.load()
print("🎉 Hook suite active! Waiting for camera video playback...", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
