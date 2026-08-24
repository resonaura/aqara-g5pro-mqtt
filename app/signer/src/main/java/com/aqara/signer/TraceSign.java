package com.aqara.signer;
import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.*;
import com.github.unidbg.memory.Memory;
import java.io.File;

public class TraceSign extends AbstractJni {
    public static void main(String[] args) throws Exception {
        new TraceSign().run();
    }
    void run() throws Exception {
        AndroidEmulator emulator = AndroidEmulatorBuilder.for32Bit().setProcessName("com.lumiunited.aqarahome.play").build();
        Memory memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));
        VM vm = emulator.createDalvikVM();
        vm.setJni(this);
        vm.setVerbose(true);
        DalvikModule dm = vm.loadLibrary(new File("liblumidevsdk.so"), true);
        dm.callJNI_OnLoad(emulator);
        DvmClass c = vm.resolveClass("com/lumi/lumidevsdk/LumiDevSDK");
        StringObject r = c.callStaticJniMethodObject(emulator,
            "getSignHead(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            new StringObject(vm,"444c476ef7135e53330f46e7"),
            new StringObject(vm,""),
            new StringObject(vm,"abc123nonce"),
            new StringObject(vm,""),
            new StringObject(vm,"1756000000000"),
            new StringObject(vm,"{\"a\":1}"));
        System.out.println("RESULT=" + r.getValue());
    }
}
