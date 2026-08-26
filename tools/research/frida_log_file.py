import frida
import subprocess
import time
import sys

res = subprocess.run(["adb", "shell", "pidof", "com.lumiunited.aqarahome.play"], capture_output=True, text=True)
pids = res.stdout.strip().split()
if not pids:
    print("Aqara app not running!", flush=True)
    sys.exit(1)

pid = int(pids[0])
log_file = open("/tmp/native_key.log", "w", buffering=1)
log_file.write(f"Attached to PID {pid}\n")
log_file.flush()

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
        send("MODULE:" + mod.name + ":" + mod.base);
        mod.enumerateExports().forEach(function(exp) {
            if (exp.name.indexOf("ed_init") !== -1 || exp.name.indexOf("create") !== -1) {
                send("HOOKED_EXPORT:" + exp.name);
                Interceptor.attach(exp.address, {
                    onEnter: function(args) {
                        send("KEY_FOUND:" + exp.name + ":" + bufToHex(args[1], 32) + ":" + bufToHex(args[3], 16));
                    }
                });
            }
        });
    }
});
"""

def on_msg(m, d):
    if 'payload' in m:
        log_file.write(str(m['payload']) + "\n")
        log_file.flush()
    else:
        log_file.write(str(m) + "\n")
        log_file.flush()

d = frida.get_usb_device()
s = d.attach(pid)
script = s.create_script(js)
script.on('message', on_msg)
script.load()
log_file.write("HOOK_ACTIVE_AND_READY\n")
log_file.flush()

while True:
    time.sleep(1)
