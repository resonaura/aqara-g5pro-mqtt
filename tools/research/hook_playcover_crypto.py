import frida
import time
import sys

js = """
console.log("Hooking PlayCover AqaraHome ObjC classes...");

function hookClass(className) {
    var cls = ObjC.classes[className];
    if (!cls) return;
    console.log("🔥 Hooking class: " + className);
    
    var methods = cls.$ownMethods;
    for (var i = 0; i < methods.length; i++) {
        var mName = methods[i];
        (function(targetMethod, name) {
            try {
                Interceptor.attach(targetMethod.implementation, {
                    onEnter: function(args) {
                        console.log("🔥🔥🔥 [" + name + "] CALLED!");
                        try {
                            if (args[2]) console.log("   Arg2: " + new ObjC.Object(args[2]).toString());
                            if (args[3]) console.log("   Arg3: " + new ObjC.Object(args[3]).toString());
                            if (args[4]) console.log("   Arg4: " + new ObjC.Object(args[4]).toString());
                            if (args[5]) console.log("   Arg5: " + new ObjC.Object(args[5]).toString());
                        } catch(e) {}
                    },
                    onLeave: function(retval) {
                        try {
                            if (retval) console.log("   --> Ret: " + new ObjC.Object(retval).toString());
                        } catch(e) {}
                    }
                });
                console.log("   [+] Hooked: " + name);
            } catch(err) {
                console.log("   [-] Error hooking " + name + ": " + err);
            }
        })(cls[mName], className + " " + mName);
    }
}

hookClass("MHFrameEncryptPwdKey");
hookClass("MHFrameEncryptManager");
hookClass("LMCAMHFrameEncryptPwdKey");
hookClass("LMCAMHFrameEncryptManager");
hookClass("LMLKMHFrameEncryptPwdKey");
hookClass("LMLKMHFrameEncryptManager");
"""

import subprocess
pid = int(subprocess.check_output(["pgrep", "-f", "AqaraHome"]).strip().split()[0])
print(f"Attaching to macOS AqaraHome (PID {pid})...", flush=True)

log_file = open("/tmp/playcover_captured_key.txt", "w", buffering=1)
log_file.write(f"Attached to PID {pid}\n")
log_file.flush()

def on_msg(m, d):
    msg = m.get('payload', str(m))
    print(f"[Frida] {msg}", flush=True)
    log_file.write(f"{msg}\n")
    log_file.flush()

d = frida.get_local_device()
s = d.attach(pid)
script = s.create_script(js)
script.on('message', on_msg)
script.load()
log_file.write("HOOKS_LOADED_SUCCESSFULLY\n")
log_file.flush()
print("🎉 Hooks active on macOS PlayCover AqaraHome! Listening...", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
