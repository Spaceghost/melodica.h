#include "../../dist/melodica.h"

#include <string_view>

int main() {
    constexpr std::string_view json =
        R"({"authToken":"auth-123","username":"listener@example.com","webName":"listener","userId":"u-42"})";
    melodica_login_view login{};

    if (melodica_version() == 0) return 1;
    if (melodica_parse_login(json.data(), json.size(), &login) != MELODICA_OK) return 2;
    if (login.present != MELODICA_LOGIN_ALL) return 3;

    const auto slice = [&](melodica_slice s) { return json.substr(s.offset, s.length); };
    if (slice(login.auth_token) != "auth-123") return 4;
    if (slice(login.username) != "listener@example.com") return 5;
    if (slice(login.web_name) != "listener") return 6;
    if (slice(login.user_id) != "u-42") return 7;
    return 0;
}
