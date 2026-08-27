import frida
import sys

js = """
console.log("🚀 Hooking AqaraHome Talkback & Audio Methods...");

function bufToHex(buf, len) {
    if (!buf) return "null";
    try {
        var arr = [];
        var max = Math.min(len || 64, 256);
        for (var i = 0; i < max; i++) {
            var b = Memory.readU8(buf.add(i)).toString(16);
            arr.push(b.length === 1 ? "0" + b : b);
        }
        return arr.join(" ");
    } catch(e) {
        return "error: " + e;
    }
}

// 1. Hook LHP2PDataManager methods
if (ObjC.available) {
    try {
        var LHP2PDataManager = ObjC.classes.LHP2PDataManager;
        
        // p2pSendCMDWithType:channel:body:completion:
        Interceptor.attach(LHP2PDataManager['- p2pSendCMDWithType:channel:body:completion:'].implementation, {
            onEnter: function(args) {
                var type = args[2].toInt32();
                var chan = args[3].toInt32();
                var bodyObj = new ObjC.Object(args[4]);
                console.log("\\n🔥 [LHP2PDataManager sendCMD]");
                console.log("   Type: 0x" + type.toString(16) + " (" + type + ")");
                console.log("   Channel: " + chan);
                console.log("   Body (" + bodyObj.$className + "): " + bodyObj.toString());
            }
        });

        // p2pSendFrameWithChannel:body:completion:
        Interceptor.attach(LHP2PDataManager['- p2pSendFrameWithChannel:body:completion:'].implementation, {
            onEnter: function(args) {
                var chan = args[2].toInt32();
                var bodyObj = new ObjC.Object(args[3]);
                console.log("\\n🎙️ [LHP2PDataManager sendFrame]");
                console.log("   Channel: " + chan);
                console.log("   Body len: " + (bodyObj ? bodyObj.length() : 0));
                if (bodyObj && bodyObj.bytes) {
                    console.log("   Hex [0..64]: " + bufToHex(bodyObj.bytes(), 64));
                }
            }
        });

        // startTalkWithCompletion:
        Interceptor.attach(LHP2PDataManager['- startTalkWithCompletion:'].implementation, {
            onEnter: function(args) {
                console.log("\\n📢 [LHP2PDataManager startTalkWithCompletion:] CALLED!");
            }
        });

        // stopTalkWithCompletion:
        Interceptor.attach(LHP2PDataManager['- stopTalkWithCompletion:'].implementation, {
            onEnter: function(args) {
                console.log("\\n🔇 [LHP2PDataManager stopTalkWithCompletion:] CALLED!");
            }
        });

        // sendAudioData:completion:
        Interceptor.attach(LHP2PDataManager['- sendAudioData:completion:'].implementation, {
            onEnter: function(args) {
                var dataObj = new ObjC.Object(args[2]);
                console.log("\\n🔊 [LHP2PDataManager sendAudioData]");
                console.log("   Data len: " + (dataObj ? dataObj.length() : 0));
                if (dataObj && dataObj.bytes) {
                    console.log("   Hex: " + bufToHex(dataObj.bytes(), 32));
                }
            }
        });

        // AudioTalk classes
        if (ObjC.classes.LMCAMHLumiCameraAudioTalk) {
            Interceptor.attach(ObjC.classes.LMCAMHLumiCameraAudioTalk['- onAudioDataReady:length:'].implementation, {
                onEnter: function(args) {
                    var len = args[3].toInt32();
                    console.log("🎙️ [LMCAMHLumiCameraAudioTalk onAudioDataReady] len=" + len + " hex=" + bufToHex(args[2], 16));
                }
            });
        }

        console.log("✅ All Talkback hooks attached successfully!");
    } catch(e) {
        console.error("❌ Error attaching ObjC hooks:", e);
    }
}
"""

def on_message(message, data):
    print("FRIDA:", message)

session = frida.attach(12190)
script = session.create_script(js)
script.on('message', on_message)
script.load()
print("Attached to PID 12190. Listening for Talkback actions in Aqara Home app...")
sys.stdin.read()
