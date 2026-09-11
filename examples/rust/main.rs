use std::os::raw::{c_char, c_int, c_uint};

#[repr(C)]
#[derive(Clone, Copy)]
struct MelodicaSlice {
    offset: usize,
    length: usize,
}

#[repr(C)]
struct MelodicaLoginView {
    present: u32,
    auth_token: MelodicaSlice,
    username: MelodicaSlice,
    web_name: MelodicaSlice,
    user_id: MelodicaSlice,
}

unsafe extern "C" {
    fn melodica_version() -> c_uint;
    fn melodica_parse_login(json: *const c_char, json_len: usize,
                            login: *mut MelodicaLoginView) -> c_int;
}

fn slice<'a>(json: &'a [u8], s: MelodicaSlice) -> &'a [u8] {
    &json[s.offset..s.offset + s.length]
}

fn main() {
    let json = b"{\"authToken\":\"auth-123\",\"username\":\"listener@example.com\",\"webName\":\"listener\",\"userId\":\"u-42\"}";
    let mut login = MelodicaLoginView {
        present: 0,
        auth_token: MelodicaSlice { offset: 0, length: 0 },
        username: MelodicaSlice { offset: 0, length: 0 },
        web_name: MelodicaSlice { offset: 0, length: 0 },
        user_id: MelodicaSlice { offset: 0, length: 0 },
    };

    unsafe {
        assert_ne!(melodica_version(), 0);
        assert_eq!(melodica_parse_login(json.as_ptr().cast(), json.len(), &mut login), 0);
    }
    assert_eq!(login.present, 15);
    assert_eq!(slice(json, login.auth_token), b"auth-123");
    assert_eq!(slice(json, login.username), b"listener@example.com");
    assert_eq!(slice(json, login.web_name), b"listener");
    assert_eq!(slice(json, login.user_id), b"u-42");
}
