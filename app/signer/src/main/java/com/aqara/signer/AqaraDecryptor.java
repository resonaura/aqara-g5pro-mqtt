package com.aqara.signer;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.Symbol;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.*;
import com.github.unidbg.memory.Memory;
import com.github.unidbg.pointer.UnidbgPointer;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Paths;

public class AqaraDecryptor extends AbstractJni {
    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final Symbol edInit;
    private final Symbol edDecode;
    private final Memory memory;
    private final UnidbgPointer ctxPtr;

    public AqaraDecryptor() throws Exception {
        emulator = AndroidEmulatorBuilder.for32Bit()
                .setProcessName("com.lumiunited.aqarahome.play")
                .build();
        memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));
        vm = emulator.createDalvikVM();
        vm.setJni(this);
        vm.setVerbose(false);

        File soFile = new File("libaqara_ed.so");
        if (!soFile.exists()) {
            try (InputStream is = getClass().getClassLoader().getResourceAsStream("libaqara_ed.so")) {
                if (is != null) {
                    soFile = File.createTempFile("libaqara_ed", ".so");
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

        edInit = module.findSymbolByName("ed_init");
        edDecode = module.findSymbolByName("ed_decode");
        ctxPtr = memory.malloc(2048, true).getPointer();
    }

    public boolean init(byte[] key, byte[] iv) {
        UnidbgPointer keyPtr = memory.malloc(key.length, true).getPointer();
        keyPtr.write(0, key, 0, key.length);

        UnidbgPointer ivPtr = memory.malloc(iv.length, true).getPointer();
        ivPtr.write(0, iv, 0, iv.length);

        Number res = edInit.call(emulator, ctxPtr, keyPtr, key.length, ivPtr);
        return res != null && res.intValue() >= 0;
    }

    public byte[] decode(byte[] ciphertext) {
        UnidbgPointer dataPtr = memory.malloc(ciphertext.length, true).getPointer();
        dataPtr.write(0, ciphertext, 0, ciphertext.length);

        Number decRes = edDecode.call(emulator, ctxPtr, dataPtr, ciphertext.length);
        if (decRes != null && decRes.intValue() >= 0) {
            return dataPtr.getByteArray(0, ciphertext.length);
        }
        return ciphertext;
    }

    public void destroy() {
        try {
            emulator.close();
        } catch (Exception ignored) {}
    }

    public static byte[] hexToBytes(String s) {
        int len = s.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(s.charAt(i), 16) << 4)
                    + Character.digit(s.charAt(i + 1), 16));
        }
        return data;
    }

    public static void main(String[] args) {
        System.setProperty("org.slf4j.simpleLogger.defaultLogLevel", "error");

        if (args.length >= 2 && args[0].equals("--pipe")) {
            try {
                String keyHex = args[1];
                byte[] key = hexToBytes(keyHex);
                AqaraDecryptor dec = new AqaraDecryptor();

                DataInputStream in = new DataInputStream(new BufferedInputStream(System.in));
                DataOutputStream out = new DataOutputStream(new BufferedOutputStream(System.out));
                byte[] iv = new byte[16];

                while (true) {
                    try {
                        int len = in.readInt();
                        if (len <= 16) break;
                        byte[] frame = new byte[len];
                        in.readFully(frame);

                        System.arraycopy(frame, 0, iv, 0, 16);
                        byte[] cipher = new byte[len - 16];
                        System.arraycopy(frame, 16, cipher, 0, len - 16);

                        dec.init(key, iv);
                        byte[] plain = dec.decode(cipher);
                        if (plain != null) {
                            out.writeInt(plain.length);
                            out.write(plain);
                            out.flush();
                        } else {
                            out.writeInt(0);
                            out.flush();
                        }
                    } catch (EOFException eof) {
                        break;
                    }
                }
                dec.destroy();
            } catch (Exception e) {
                e.printStackTrace(System.err);
                System.exit(1);
            }
            return;
        }

        if (args.length >= 3 && args[0].equals("--decrypt-file")) {
            try {
                String keyHex = args[1];
                String inFile = args[2];
                String outFile = args.length > 3 ? args[3] : null;

                byte[] key = hexToBytes(keyHex);
                byte[] raw = Files.readAllBytes(Paths.get(inFile));

                byte[] iv = new byte[16];
                System.arraycopy(raw, 0, iv, 0, 16);

                byte[] ciphertext = new byte[raw.length - 16];
                System.arraycopy(raw, 16, ciphertext, 0, raw.length - 16);

                AqaraDecryptor dec = new AqaraDecryptor();
                dec.init(key, iv);
                byte[] decrypted = dec.decode(ciphertext);
                dec.destroy();

                if (decrypted != null) {
                    if (outFile != null) {
                        Files.write(Paths.get(outFile), decrypted);
                        System.out.println("✅ Decrypted file saved to " + outFile);
                    } else {
                        System.out.write(decrypted);
                    }
                } else {
                    System.err.println("❌ Decryption failed");
                    System.exit(1);
                }
            } catch (Exception e) {
                e.printStackTrace(System.err);
                System.exit(1);
            }
            return;
        }

        System.out.println("Usage: java -cp aqara-signer.jar com.aqara.signer.AqaraDecryptor --pipe <key_hex>");
    }
}
