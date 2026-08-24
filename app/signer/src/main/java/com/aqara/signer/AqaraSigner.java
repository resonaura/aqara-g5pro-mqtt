package com.aqara.signer;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.*;
import com.github.unidbg.linux.android.dvm.array.ByteArray;
import com.github.unidbg.memory.Memory;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Paths;

public class AqaraSigner extends AbstractJni {
    private final AndroidEmulator emulator;
    private final VM vm;
    private final DvmClass LumiDevSDK;
    private final Module module;

    public AqaraSigner() throws Exception {
        emulator = AndroidEmulatorBuilder.for32Bit()
                .setProcessName("com.lumiunited.aqarahome.play")
                .build();
        Memory memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));
        vm = emulator.createDalvikVM();
        vm.setJni(this);
        vm.setVerbose(false);

        File soFile = new File("liblumidevsdk.so");
        if (!soFile.exists()) {
            try (InputStream is = getClass().getClassLoader().getResourceAsStream("liblumidevsdk.so")) {
                if (is != null) {
                    soFile = File.createTempFile("liblumidevsdk", ".so");
                    soFile.deleteOnExit();
                    try (FileOutputStream fos = new FileOutputStream(soFile)) {
                        byte[] buf = new byte[8192];
                        int r;
                        while ((r = is.read(buf)) != -1) {
                            fos.write(buf, 0, r);
                        }
                    }
                }
            }
        }

        DalvikModule dm = vm.loadLibrary(soFile, true);
        module = dm.getModule();
        dm.callJNI_OnLoad(emulator);

        LumiDevSDK = vm.resolveClass("com/lumi/lumidevsdk/LumiDevSDK");
    }

    public byte[] getDecryptedInfo(byte[] data) {
        DvmObject<?> res = LumiDevSDK.callStaticJniMethodObject(
                emulator,
                "getDecryptedInfo([B)[B",
                new ByteArray(vm, data)
        );
        return res != null && res.getValue() instanceof byte[] ? (byte[]) res.getValue() : null;
    }

    public String getSignHead(String appId, String nonce, String timeStr, String token, String userId, String body) {
        DvmObject<?> res = LumiDevSDK.callStaticJniMethodObject(
                emulator,
                "getSignHead(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                new StringObject(vm, appId != null ? appId : ""),
                new StringObject(vm, nonce != null ? nonce : ""),
                new StringObject(vm, timeStr != null ? timeStr : ""),
                new StringObject(vm, token != null ? token : ""),
                new StringObject(vm, userId != null ? userId : ""),
                new StringObject(vm, body != null ? body : "")
        );
        return res != null && res.getValue() != null ? res.getValue().toString() : null;
    }

    public void destroy() {
        try {
            emulator.close();
        } catch (Exception ignored) {}
    }

    public static void main(String[] args) {
        System.setProperty("org.slf4j.simpleLogger.defaultLogLevel", "error");

        if (args.length > 0 && args[0].equals("--decrypt-file")) {
            try {
                AqaraSigner signer = new AqaraSigner();
                byte[] in = Files.readAllBytes(Paths.get(args[1]));
                byte[] out = signer.getDecryptedInfo(in);
                if (out != null) {
                    System.out.write(out);
                } else {
                    System.err.println("Decryption failed or returned null");
                }
                signer.destroy();
            } catch (Exception e) {
                e.printStackTrace(System.err);
            }
            return;
        }

        if (args.length < 6) {
            System.err.println("Usage: java -jar aqara-signer.jar <appId> <nonce> <timeStr> <token> <userId> <body>");
            System.exit(1);
        }

        try {
            AqaraSigner signer = new AqaraSigner();
            String appId = args[0];
            String nonce = args[1];
            String timeStr = args[2];
            String token = args[3];
            String userId = args[4];
            String body = args[5];

            String result = signer.getSignHead(appId, nonce, timeStr, token, userId, body);
            System.out.println(result != null ? result : "");
            signer.destroy();
        } catch (Exception e) {
            e.printStackTrace(System.err);
            System.exit(1);
        }
    }
}
