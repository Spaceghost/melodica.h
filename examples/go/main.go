package main

/*
#cgo CFLAGS: -I${SRCDIR}/../../dist
#cgo LDFLAGS: ${SRCDIR}/../../build/languages/melodica.o
#include "melodica.h"
*/
import "C"

import "unsafe"

func slice(json []byte, s C.melodica_slice) string {
	start := int(s.offset)
	end := start + int(s.length)
	return string(json[start:end])
}

func main() {
	json := []byte(`{"authToken":"auth-123","username":"listener@example.com","webName":"listener","userId":"u-42"}`)
	var login C.melodica_login_view

	if C.melodica_version() == 0 {
		panic("invalid melodica version")
	}
	rc := C.melodica_parse_login((*C.char)(unsafe.Pointer(&json[0])), C.size_t(len(json)), &login)
	if rc != 0 {
		panic("melodica_parse_login failed")
	}
	if uint32(login.present) != 15 {
		panic("bad login present mask")
	}
	if slice(json, login.auth_token) != "auth-123" {
		panic("bad auth token slice")
	}
	if slice(json, login.username) != "listener@example.com" {
		panic("bad username slice")
	}
}
