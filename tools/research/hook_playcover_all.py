import frida
import subprocess
import time

pid = int(subprocess.check_output(["pgrep", "-f", "AqaraHome"]).strip().split()[0])
print(f"Attaching to PID {pid}...", flush=True)

out = "/tmp/playcover_key_found.txt"
with open(out, "w") as f:
    f.write(f"Attached to PID {pid}\n")

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

// Hook all ObjC methods in classes containing Encrypt or PwdKey
var targetClasses = ["MHFrameEncryptPwdKey", "MHFrameEncryptManager", "LMCAMHFrameEncryptPwdKey", "LMCAMHFrameEncryptManager", "LMLKMHFrameEncryptPwdKey", "LMLKMHFrameEncryptManager"];

targetClasses.forEach(function(cName) {
    var cls = ObjC.classes[cName];
    if (!cls) return;
    send("Found class: " + cName);

    var methods = cls.$ownMethods || cls.$methods;
    methods.forEach(function(m) {
        try {
            var impl = cls[m].implementation;
            if (impl) {
                Interceptor.attach(impl, {
                    onEnter: function(args) {
                        var logStr = "🔥🔥🔥 [" + cName + " " + m + "] CALLED!";
                        try {
                            if (args[2]) logStr += " | arg2=" + new ObjC.Object(args[2]).toString();
                            if (args[3]) logStr += " | arg3=" + new ObjC.Object(args[3]).toString();
                            if (args[4]) logStr += " | arg4=" + new ObjC.Object(args[4]).toString();
                        } catch(e) {}
                        send(logStr);
                    },
                    onLeave: function(retval) {
                        try {
                            if (retval && !retval.isNull()) {
                                var retObj = new ObjC.Object(retval);
                                send("   --> RET: " + retObj.toString());
                            }
                        } catch(e) {}
                    }
                });
                send("   Hooked: " + m);
            }
        } catch(err) {
            send("   Error on " + m + ": " + err);
        }
    });
});
"""

def on_msg(m, d):
    msg = m.get('payload', str(m))
    print(f"[Frida] {msg}", flush=True)
    with open(out, "a") as f:
        f.write(f"{msg}\n")

d = frida.get_local_device()
s = d.attach(pid)
script = s.create_script(js)
script.on('message', on_msg)
script.load()
print(f"🎉 All ObjC hooks active! Output written to {out}", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
