package com.aregner.android.pandoid;

final class MelodicaNative {
    static {
        System.loadLibrary("melodica");
    }

    private MelodicaNative() {}

    static native int abiVersion();

    static boolean initialize() {
        return abiVersion() == 1;
    }
}
