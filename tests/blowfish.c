#include "blowfish.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

static void check(const uint8_t key[8], const uint8_t plain[8], const uint8_t cipher[8]) {
    MelodicaBlowfish ctx;
    uint8_t block[8];
    assert(melodica_blowfish_init(&ctx, key, 8u));
    memcpy(block, plain, sizeof(block));
    melodica_blowfish_encrypt_block(&ctx, block);
    assert(memcmp(block, cipher, sizeof(block)) == 0);
    melodica_blowfish_decrypt_block(&ctx, block);
    assert(memcmp(block, plain, sizeof(block)) == 0);
    melodica_blowfish_clear(&ctx);
}

int main(void) {
    static const uint8_t key0[8] = {0};
    static const uint8_t plain0[8] = {0};
    static const uint8_t cipher0[8] = {0x4e,0xf9,0x97,0x45,0x61,0x98,0xdd,0x78};

    static const uint8_t key1[8] = {0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff};
    static const uint8_t plain1[8] = {0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff};
    static const uint8_t cipher1[8] = {0x51,0x86,0x6f,0xd5,0xb8,0x5e,0xcb,0x8a};

    static const uint8_t key2[8] = {0x30,0,0,0,0,0,0,0};
    static const uint8_t plain2[8] = {0x10,0,0,0,0,0,0,1};
    static const uint8_t cipher2[8] = {0x7d,0x85,0x6f,0x9a,0x61,0x30,0x63,0xf2};

    check(key0, plain0, cipher0);
    check(key1, plain1, cipher1);
    check(key2, plain2, cipher2);
    return 0;
}
