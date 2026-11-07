#include <jni.h>
#include "melodica.h"

JNIEXPORT jint JNICALL
Java_com_aregner_android_pandoid_MelodicaNative_abiVersion(
        JNIEnv *env, jclass type) {
    (void)env;
    (void)type;
    return (jint)melodica_abi_version();
}
