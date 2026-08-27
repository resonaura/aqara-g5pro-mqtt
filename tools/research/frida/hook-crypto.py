import frida
import sys
import time

js_code = """
console.log("[*] Injected Frida script into Aqara Home!");

function bufToHex(buf, len) {
    if (!buf) return "null";
    var arr = [];
    var max = Math.min(len || 32, 64);
    for (var i = 0; i < max; i++) {
        var b = Memory.readU8(buf.add(i)).toString(16);
        arr.push(b.length === 1 ? "0" + b : b);
    }
    return arr.join("");
}

Java.perform(function() {
    console.log("🔥 [Java Runtime Ready!] Searching for camera & crypto classes...");

    try {
        var PwdKey = Java.use("com.lumi.ed.PwdKey");
        console.log("🔥 [HOOKED] com.lumi.ed.PwdKey found!");
        PwdKey.g.overload('java.lang.String').implementation = function(did) {
            var res = this.g(did);
            console.log("🔥🔥🔥 [PwdKey.g(" + did + ") EXECUTED!]");
            console.log("   --> Video Key: " + Java.use("java.util.Arrays").toString(res));
            return res;
        };
    } catch(e) {
        console.log("[-] PwdKey not yet found: " + e);
    }

    try {
        var AqaraED = Java.use("com.lumi.ed.AqaraED");
        console.log("🔥 [HOOKED] com.lumi.ed.AqaraED found!");
        var methods = AqaraED.class.getDeclaredMethods();
        for (var i = 0; i < methods.length; i++) {
            console.log("   --> Method: " + methods[i].toString());
        }

        // Hook create
        AqaraED.create.overload('int', '[B').implementation = function(mode, key) {
            console.log("🔥🔥🔥 [AqaraED.create(mode=" + mode + ")]");
            console.log("   Key: " + Java.use("java.util.Arrays").toString(key));
            var res = this.create(mode, key);
            console.log("   --> Handle: " + res);
            return res;
        };

        // Hook decode
        AqaraED.decode.overload('long', '[B').implementation = function(handle, data) {
            console.log("🎬 [AqaraED.decode] handle=" + handle + " data.len=" + data.length);
            var res = this.decode(handle, data);
            return res;
        };
    } catch(e) {
        console.log("[-] Error in AqaraED hook: " + e);
    }
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
print("Spawning com.lumiunited.aqarahome.play...", flush=True)
pid = device.spawn(["com.lumiunited.aqarahome.play"])
print(f"Spawned PID {pid}. Attaching session...", flush=True)
session = device.attach(pid)
script = session.create_script(js_code)
script.on('message', on_message)
script.load()
device.resume(pid)
print("🎉 Hook loaded and app resumed! Waiting for camera live view in app...", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("Stopping...")
