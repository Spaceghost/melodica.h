LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)
LOCAL_MODULE := melodica
LOCAL_SRC_FILES := melodica_jni.c ../vendor/melodica/impl/c/melodica.c
LOCAL_C_INCLUDES := $(LOCAL_PATH)/../vendor/melodica/include
LOCAL_CFLAGS := -O3 -std=c99 -Wall -Wextra
include $(BUILD_SHARED_LIBRARY)
