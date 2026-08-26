import frida
import time
import sys

js_code = """
Java.perform(function() {
    console.log("🔥 [Java Active] Hooking AqaraED.create...");
    try {
        var AqaraED = Java.use("com.lumi.ed.AqaraED");
        AqaraED.create.overload('int', '[B').implementation = function(mode, key) {
            console.log("🔥🔥🔥 [AqaraED.create(mode=" + mode + ") CAPTURED!]");
            var hex = [];
            for (var i = 0; i < key.length; i++) {
                var b = (key[i] & 0xFF).toString(16);
                hex.push(b.length === 1 ? "0" + b : b);
            }
            var hexKey = hex.join("");
            console.log("   🎉 KEY HEX (" + key.length + " bytes): " + hexKey);
            send({ event: "key", hex: hexKey, mode: mode });
            return this.create(mode, key);
        };
        console.log("✅ AqaraED.create successfully hooked!");
    } catch(e) {
        console.log("[-] Hook error: " + e);
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
import subprocess
res = subprocess.run(["adb", "shell", "pidof", "com.lumiunited.aqarahome.play"], capture_output=True, text=True)
pid = int(res.stdout.strip().split()[0])
print(f"Attaching to PID {pid}...", flush=True)
session = device.attach(pid)
script = session.create_script(js_code)
script.on('message', on_message)
script.load()
print("🎉 Hook active! Listening for live view crypto calls...", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    pass
