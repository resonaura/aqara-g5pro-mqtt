package com.aqara.signer;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.Symbol;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.*;
import com.github.unidbg.memory.Memory;
import com.github.unidbg.pointer.UnidbgPointer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

public class AqaraP2PClient extends AbstractJni {
    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final Symbol ppcsInitialize;
    private final Symbol ppcsConnect;
    private final Symbol ppcsWrite;
    private final Symbol ppcsRead;
    private final Symbol ppcsClose;
    private final Symbol ppcsCheck;

    public AqaraP2PClient() throws Exception {
        emulator = AndroidEmulatorBuilder.for32Bit()
                .setProcessName("com.lumiunited.aqarahome.play")
                .build();
        emulator.getSyscallHandler().setEnableThreadDispatcher(true);
        Memory memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));
        vm = emulator.createDalvikVM();
        vm.setJni(this);
        vm.setVerbose(true);

        File soFile = new File("libPPCS_API.so");
        if (!soFile.exists()) {
            try (InputStream is = getClass().getClassLoader().getResourceAsStream("libPPCS_API.so")) {
                if (is != null) {
                    soFile = File.createTempFile("libPPCS_API", ".so");
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

        ppcsInitialize = module.findSymbolByName("PPCS_Initialize");
        ppcsConnect = module.findSymbolByName("PPCS_Connect");
        ppcsWrite = module.findSymbolByName("PPCS_Write");
        ppcsRead = module.findSymbolByName("PPCS_Read");
        ppcsClose = module.findSymbolByName("PPCS_Close");
        ppcsCheck = module.findSymbolByName("PPCS_Check");
    }

    public int initialize(String initString) {
        Memory memory = emulator.getMemory();
        byte[] bytes = (initString + "\0").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        UnidbgPointer ptr = memory.malloc(bytes.length, true).getPointer();
        ptr.write(0, bytes, 0, bytes.length);
        Number ret = ppcsInitialize.call(emulator, ptr);
        return ret.intValue();
    }

    public int connect(String targetId, boolean enableLan, int port) {
        Memory memory = emulator.getMemory();
        byte[] bytes = (targetId + "\0").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        UnidbgPointer ptr = memory.malloc(bytes.length, true).getPointer();
        ptr.write(0, bytes, 0, bytes.length);
        Number ret = ppcsConnect.call(emulator, ptr, enableLan ? 1 : 0, port);
        return ret.intValue();
    }

    public int write(int handle, int channel, byte[] data) {
        Memory memory = emulator.getMemory();
        UnidbgPointer ptr = memory.malloc(data.length, true).getPointer();
        ptr.write(0, data, 0, data.length);
        Number ret = ppcsWrite.call(emulator, handle, channel, ptr, data.length);
        return ret.intValue();
    }

    public byte[] read(int handle, int channel, int maxSize, int timeoutMs) {
        Memory memory = emulator.getMemory();
        UnidbgPointer bufPtr = memory.malloc(maxSize, true).getPointer();
        UnidbgPointer sizePtr = memory.malloc(4, true).getPointer();
        sizePtr.setInt(0, maxSize);

        Number ret = ppcsRead.call(emulator, handle, channel, bufPtr, sizePtr, timeoutMs);
        if (ret.intValue() >= 0) {
            int readLen = sizePtr.getInt(0);
            if (readLen > 0) {
                return bufPtr.getByteArray(0, readLen);
            }
        }
        return null;
    }

    public int close(int handle) {
        Number ret = ppcsClose.call(emulator, handle);
        return ret.intValue();
    }

    public void destroy() {
        try {
            emulator.close();
        } catch (Exception ignored) {}
    }

    public int connectByServer(String targetId, boolean enableLan, int port, String serverString) {
        Memory memory = emulator.getMemory();
        byte[] tidBytes = (targetId + "\0").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        UnidbgPointer tidPtr = memory.malloc(tidBytes.length, true).getPointer();
        tidPtr.write(0, tidBytes, 0, tidBytes.length);

        byte[] srvBytes = (serverString + "\0").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        UnidbgPointer srvPtr = memory.malloc(srvBytes.length, true).getPointer();
        srvPtr.write(0, srvBytes, 0, srvBytes.length);

        Symbol ppcsConnectByServer = module.findSymbolByName("PPCS_ConnectByServer");
        if (ppcsConnectByServer != null) {
            Number ret = ppcsConnectByServer.call(emulator, tidPtr, enableLan ? 1 : 0, port, srvPtr);
            return ret.intValue();
        }
        return -1;
    }

    public static void main(String[] args) {
        System.setProperty("org.slf4j.simpleLogger.defaultLogLevel", "info");
        try {
            System.out.println("🚀 Initializing Unidbg Aqara P2P Client...");
            AqaraP2PClient client = new AqaraP2PClient();

            String initString = args.length > 0 ? args[0] : "EFGBFFBMKFIBGLJFFPHKFDEMGENHHBMHHLFCBLDEANJLLGKCDCACCLPDGKKEIILJBBNCKICMPPNHBFDL:aqaraus19kn";
            String targetId = args.length > 1 ? args[1] : "AQARAUS-207160-BRSYM";
            String serverStr = initString.split(":")[0];

            System.out.println("📌 InitString: " + initString);
            System.out.println("📌 Target DID: " + targetId);

            int initRes = client.initialize(initString);
            System.out.println("✅ PPCS_Initialize Result: " + initRes);

            System.out.println("⏳ Connecting via PPCS_ConnectByServer...");
            int handle = client.connectByServer(targetId, true, 0, serverStr);
            System.out.println("🎉 PPCS_ConnectByServer Handle: " + handle);

            if (handle < 0) {
                System.out.println("⏳ Connecting via PPCS_Connect...");
                handle = client.connect(targetId, true, 0);
                System.out.println("🎉 PPCS_Connect Handle: " + handle);
            }

            if (handle >= 0) {
                System.out.println("🔌 Connected! Handle=" + handle);
                client.close(handle);
            }

            client.destroy();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
