import frida
import subprocess
import time
import sys

res = subprocess.run(["adb", "shell", "pidof", "com.lumiunited.aqarahome.play"], capture_output=True, text=True)
pids = res.stdout.strip().split()
if not pids:
    print("Aqara app not running!")
    sys.exit(1)

pid = int(pids[0])
print(f"Attaching native hooks to PID {pid}...", flush=True)

js = """
function bufToHex(buf, len) {
    if (!buf || buf.isNull()) return "null";
    try {
        var arr = [];
        var max = Math.min(len || 32, 64);
        for (var i = 0; i < max; i++) {
            var b = Memory.readU8(buf.add(i)).toString(16);
            arr.push(b.length === 1 ? "0" + b : b);
        }
        return arr.join("");
    } catch(e) {
        return "err:" + e;
    }
}

Process.enumerateModules().forEach(function(mod) {
    if (mod.name.indexOf("aqara_ed") !== -1) {
        console.log("🔥 [FOUND] " + mod.name + " at " + mod.base);
        mod.enumerateExports().forEach(function(exp) {
            if (exp.name.indexOf("ed_init") !== -1 || exp.name.indexOf("create") !== -1) {
                console.log("   Hooking export: " + exp.name);
                Interceptor.attach(exp.address, {
                    onEnter: function(args) {
                        console.log("🔥🔥🔥 [" + exp.name + "] CALLED!");
                        console.log("   Arg0 (ctx):  " + args[0]);
                        console.log("   Arg1 (key):  " + bufToHex(args[1], 32));
                        console.log("   Arg2 (len):  " + args[2]);
                        console.log("   Arg3 (iv):   " + bufToHex(args[3], 16));
                    }
                });
            }
        });
    }
});
"""

def on_msg(m, d):
    if 'payload' in m:
        print(f"[Frida] {m['payload']}", flush=True)
    else:
        print(f"[Frida Msg] {m}", flush=True)

d = frida.get_usb_device()
s = d.attach(pid)
script = s.create_script(js)
script.on('message', on_msg)
script.load()
print("🎉 Pure native hooks active! Listening for video stream decryptions...", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
