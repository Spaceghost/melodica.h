/* An offline client using only the installed historical libpiano public API. */
#include <piano.h>
#include <stdio.h>

int main(void) {
    PianoHandle_t piano;
    PianoRequest_t request = {0};
    PianoRequestDataLogin_t login = {0};
    const PianoReturn_t initialized = PianoInit(&piano, "demo-partner", "demo-password",
            "demo-device", "test-key", "test-key");
    if (initialized != PIANO_RET_OK) {
        fprintf(stderr, "%s\n", PianoErrorToStr(initialized));
        PianoDestroy(&piano);
        return 1;
    }
    request.data = &login;
    const PianoReturn_t result = PianoRequest(&piano, &request, PIANO_REQUEST_LOGIN);
    if (result == PIANO_RET_OK) {
        printf("%s\nTLS=%d\n%s\n", request.urlPath, request.secure ? 1 : 0,
                request.postData);
    }
    PianoDestroyRequest(&request);
    PianoDestroy(&piano);
    return result == PIANO_RET_OK ? 0 : 1;
}
