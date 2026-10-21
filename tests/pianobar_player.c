/* Exercise the real pinned pianobar player with a libao null output driver.
 * Linker wrappers select that driver and retain its decoded PCM for comparison.
 * No audio hardware is opened. The UI reporter is replaced with a test logger.
 */
#include "config.h"
#include <assert.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "player.h"
#include "ui_types.h"

static FILE *pcm;
static size_t pcm_bytes;
static unsigned int opened, played, errors;

int __real_ao_default_driver_id(void);
ao_device *__real_ao_open_live(int, ao_sample_format *, ao_option *);
int __real_ao_play(ao_device *, char *, uint_32);

int __wrap_ao_default_driver_id(void) {
    const int driver = ao_driver_id("null");
    if (driver < 0) {
        fputs("libao null driver unavailable\n", stderr);
        exit(1);
    }
    return driver;
}

ao_device *__wrap_ao_open_live(int driver, ao_sample_format *format,
        ao_option *options) {
    /* Reject every output except the explicitly selected null driver. */
    if (driver != ao_driver_id("null") || format->bits != 16 ||
            format->rate != 44100 || format->channels != 1) {
        fputs("unexpected output device or sample format\n", stderr);
        exit(1);
    }
    ++opened;
    return __real_ao_open_live(driver, format, options);
}

int __wrap_ao_play(ao_device *device, char *samples, uint_32 size) {
    if (fwrite(samples, 1u, size, pcm) != size) {
        fputs("cannot record decoded PCM\n", stderr);
        exit(1);
    }
    pcm_bytes += size;
    ++played;
    return __real_ao_play(device, samples, size);
}

void BarUiMsg(const BarSettings_t *settings, const BarUiMsg_t type,
        const char *format, ...) {
    (void)settings;
    if (type == MSG_ERR) ++errors;
    va_list arguments;
    va_start(arguments, format);
    vfprintf(stderr, format, arguments);
    va_end(arguments);
}

int main(int argc, char **argv) {
    if (argc != 3) return 64;
    pcm = fopen(argv[2], "wb");
    if (pcm == NULL) return 1;
    BarSettings_t settings = {0};
    settings.timeout = 2;
    settings.bufferSecs = 1;
    settings.gainMul = 1.0;
    player_t player = {0};
    BarPlayerInit(&player, &settings);
    player.url = argv[1];
    const uintptr_t result = (uintptr_t)BarPlayerThread(&player);
    const BarPlayerMode mode = BarPlayerGetMode(&player);
    BarPlayerDestroy(&player);
    if (fclose(pcm) != 0 || result != PLAYER_RET_OK ||
            mode != PLAYER_FINISHED || opened != 1u || played == 0u ||
            errors != 0u || pcm_bytes != 44100u * 2u) {
        fprintf(stderr, "player failure: result=%lu mode=%d opens=%u "
                "blocks=%u errors=%u PCM=%zu\n", (unsigned long)result,
                mode, opened, played, errors, pcm_bytes);
        return 1;
    }
    printf("actual pianobar player: null sink, %u decoded blocks, %zu PCM bytes\n",
            played, pcm_bytes);
    return 0;
}
