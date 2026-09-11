#include "../../dist/melodica.h"

#include <string.h>

static int slice_eq(const char *json, melodica_slice s, const char *want) {
    return s.length == strlen(want) && memcmp(json + s.offset, want, s.length) == 0;
}

int main(void) {
    const char json[] =
        "{\"authToken\":\"auth-123\",\"username\":\"listener@example.com\","
        "\"webName\":\"listener\",\"userId\":\"u-42\"}";
    melodica_login_view login = {0};

    if (melodica_version() == 0) return 1;
    if (melodica_parse_login(json, sizeof json - 1, &login) != MELODICA_OK) return 2;
    if (login.present != MELODICA_LOGIN_ALL) return 3;
    if (!slice_eq(json, login.auth_token, "auth-123")) return 4;
    if (!slice_eq(json, login.username, "listener@example.com")) return 5;
    if (!slice_eq(json, login.web_name, "listener")) return 6;
    if (!slice_eq(json, login.user_id, "u-42")) return 7;
    return 0;
}
