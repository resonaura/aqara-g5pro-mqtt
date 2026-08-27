import frida
import time
import sys

out_path = "/Users/resonaura/aqara-g5pro-mqtt/captured_key.txt"
with open(out_path, "w") as f:
    f.write("INITIALIZING\n")

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

// Hook native ed_init
function hookModule(mod) {
    if (mod.name.indexOf("aqara_ed") !== -1) {
        send("MODULE_LOADED:" + mod.name);
        mod.enumerateExports().forEach(function(exp) {
            if (exp.name.indexOf("ed_init") !== -1 || exp.name.indexOf("create") !== -1) {
                send("HOOKING_EXPORT:" + exp.name);
                Interceptor.attach(exp.address, {
                    onEnter: function(args) {
                        send("KEY_FOUND:" + exp.name + ":" + bufToHex(args[1], 32) + ":" + bufToHex(args[3], 16));
                    }
                });
            }
        });
    }
}

Process.enumerateModules().forEach(hookModule);
"""

def on_msg(m, d):
    print("MSG:", m, flush=True)
    if 'payload' in m:
        with open(out_path, "a") as f:
            f.write(str(m['payload']) + "\n")

d = frida.get_usb_device()
print("Spawning app...", flush=True)
pid = d.spawn(["com.lumiunited.aqarahome.play"])
print(f"Spawned PID {pid}. Attaching...", flush=True)
s = d.attach(pid)
script = s.create_script(js)
script.on('message', on_msg)
script.load()
d.resume(pid)
print(f"🎉 App running and native hooks active! Output written to {out_path}", flush=True)

while True:
    time.sleep(1)
