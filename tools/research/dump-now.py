import frida
import subprocess
import time

res = subprocess.run(["adb", "shell", "pidof", "com.lumiunited.aqarahome.play"], capture_output=True, text=True)
pids = res.stdout.strip().split()
if not pids:
    print("Aqara app not running!")
    exit(1)

pid = int(pids[0])
print(f"Attaching to PID {pid}...")

js = """
Java.perform(function() {
    console.log("Attached to Java runtime!");

    // Hook AqaraED.create
    try {
        var AqaraED = Java.use("com.lumi.ed.AqaraED");
        AqaraED.create.overload('int', '[B').implementation = function(mode, key) {
            var hex = [];
            for (var i = 0; i < key.length; i++) {
                var b = (key[i] & 0xFF).toString(16);
                hex.push(b.length === 1 ? "0" + b : b);
            }
            var hexStr = hex.join("");
            console.log("KEY_CAPTURED:" + hexStr);
            send({ key: hexStr, mode: mode });
            return this.create(mode, key);
        };
        console.log("AqaraED.create hook installed!");
    } catch(e) {
        console.log("AqaraED error: " + e);
    }
});
"""

def on_msg(m, d):
    print("MSG:", m, flush=True)
    if 'payload' in m:
        with open("/tmp/live_crypto_captured.txt", "a") as f:
            f.write(str(m['payload']) + "\n")

d = frida.get_usb_device()
s = d.attach(pid)
script = s.create_script(js)
script.on('message', on_msg)
script.load()
print("Hook ready! Writing captures to /tmp/live_crypto_captured.txt", flush=True)

while True:
    time.sleep(1)
