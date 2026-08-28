/*
 * Frida script to hook AqaraHome P2P commands and audio frames
 * Attach to PID 74826 (or specify via -p)
 * Logs:
 *   - P2P commands: type and channel
 *   - Audio frames: channel and payload size
 *   - Optional: talk stop/restart methods
 */

// Helper to log with timestamp
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Main
setImmediate(function () {
  log("Starting AqaraHome hooking script...");

  // Try to find the P2P data manager class
  var p2pManagerClass = ObjC.classes.LMLKP2PDataManager;
  if (!p2pManagerClass) {
    log("ERROR: Class LMLKP2PDataManager not found. Trying alternatives...");
    // Try to find any class containing "P2P" or "DataManager"
    var classNames = ObjC.classes;
    for (var i = 0; i < classNames.length; i++) {
      var name = classNames[i];
      if (name.indexOf("P2P") >= 0 && name.indexOf("DataManager") >= 0) {
        p2pManagerClass = ObjC.classes[name];
        log("Found alternative class: " + name);
        break;
      }
    }
    if (!p2pManagerClass) {
      log("ERROR: Could not find P2P manager class. Exiting.");
      return;
    }
  } else {
    log("Found class: LMLKP2PDataManager");
  }

  // Hook p2pSendCMD (or sendCMD if p2pSendCMD doesn't exist)
  var p2pSendCMD =
    p2pManagerClass["- p2pSendCMD:"] ||
    p2pManagerClass["- sendCMD:"] ||
    p2pManagerClass["- sendCMD:channel:"] ||
    p2pManagerClass["- sendCMD:withChannel:"];

  if (p2pSendCMD) {
    Interceptor.attach(p2pSendCMD.implementation, {
      onEnter: function (args) {
        // Assuming first argument is self, second is cmd data (NSData), third might be channel
        var self = args[0];
        var cmdData = args[1]; // NSData
        var channel = args.length > 2 ? args[2] : ptr(0); // default to 0 if not present
        log("-> p2pSendCMD called");
        if (!cmdData.isNull()) {
          // Extract first two bytes as command type (big-endian)
          var data = ObjC.Object(cmdData);
          var bytes = data.bytes();
          if (data.length() >= 2) {
            var type = (bytes[0] << 8) | bytes[1];
            log(
              "   Command type: 0x" +
                type.toString(16) +
                ", Channel: " +
                channel,
            );
          } else {
            log("   Command data too short: " + data.length() + " bytes");
          }
        } else {
          log("   Command data is null");
        }
      },
      onLeave: function (retval) {
        log("<- p2pSendCMD returned");
      },
    });
    log("Hooked p2pSendCMD/sendCMD");
  } else {
    log("WARNING: Could not find p2pSendCMD or sendCMD method");
  }

  // Hook sendAudioFrame (or sendAudioData)
  var sendAudioFrame =
    p2pManagerClass["- sendAudioFrame:"] ||
    p2pManagerClass["- sendAudioData:"] ||
    p2pManagerClass["- sendAudioFrame:channel:"] ||
    p2pManagerClass["- sendAudioData:channel:"];

  if (sendAudioFrame) {
    Interceptor.attach(sendAudioFrame.implementation, {
      onEnter: function (args) {
        var self = args[0];
        var audioData = args[1]; // NSData
        var channel = args.length > 2 ? args[2] : ptr(0);
        log("-> sendAudioFrame called");
        if (!audioData.isNull()) {
          var data = ObjC.Object(audioData);
          log(
            "   Audio frame size: " +
              data.length() +
              " bytes, Channel: " +
              channel,
          );
          // Optionally check for ADTS header (0xFFFx)
          if (data.length() >= 2) {
            var bytes = data.bytes();
            if ((bytes[0] & 0xff) === 0xff && (bytes[1] & 0xf0) === 0xf0) {
              log("   ADTS header detected");
            }
          }
        } else {
          log("   Audio data is null");
        }
      },
      onLeave: function (retval) {
        log("<- sendAudioFrame returned");
      },
    });
    log("Hooked sendAudioFrame/sendAudioData");
  } else {
    log("WARNING: Could not find sendAudioFrame or sendAudioData method");
  }

  // Optional: hook stopTalkWithCompletion to ensure it's not called during talkback
  var stopTalk =
    p2pManagerClass["- stopTalkWithCompletion:"] ||
    p2pManagerClass["- stopTalk"] ||
    p2pManagerClass["- stopTalkWithCompletion"];

  if (stopTalk) {
    Interceptor.attach(stopTalk.implementation, {
      onEnter: function (args) {
        log(
          "!! stopTalkWithCompletion called - THIS SHOULD NOT HAPPEN DURING TALKBACK !!",
        );
      },
      onLeave: function (retval) {
        log("<- stopTalkWithCompletion returned");
      },
    });
    log("Hooked stopTalkWithCompletion (for monitoring)");
  } else {
    log("INFO: stopTalkWithCompletion not found (optional)");
  }

  log("Hooking complete. Waiting for events...");
});
