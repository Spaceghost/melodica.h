/* Shared, deterministic C-ABI conformance test. No implementation is embedded. */
#include "melodica.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define MAX_INPUT 1024u
#define MAX_OUTPUT (6u * MAX_INPUT + 128u)
#define GUARD 17u
static size_t case_id, checks;
static uint32_t rng = UINT32_C(0x51A7C0DE);
static void check(int ok,const char *what,unsigned kind,size_t n,size_t cap){++checks;if(!ok){fprintf(stderr,"case=%zu kind=%u length=%zu capacity=%zu: %s\n",case_id,kind,n,cap,what);exit(1);}}
static uint32_t next_random(void){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return rng;}
static size_t invoke(unsigned k,char*d,size_t c,const uint8_t*s,size_t n,uintptr_t t){if(k==0)return melodica_url_encode(d,c,s,n);if(k==1)return melodica_json_escape(d,c,s,n);return melodica_station_list_request(d,c,s,n,t);}
static size_t size_call(unsigned k,const uint8_t*s,size_t n,uintptr_t t){if(k==0)return melodica_url_encode_size(s,n);if(k==1)return melodica_json_escape_size(s,n);return melodica_station_list_request_size(s,n,t);}
static size_t reference(unsigned k,char*out,const uint8_t*s,size_t n,uintptr_t t){static const char a[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";static const char h[]="0123456789ABCDEF";size_t p=0;if(k==2){const char*x="{\"returnAllStations\":true,\"userAuthToken\":\"";p=strlen(x);memcpy(out,x,p);}for(size_t i=0;i<n;++i){unsigned c=s[i];if(k==0){if(c&&strchr(a,(int)c))out[p++]=(char)c;else{out[p++]='%';out[p++]=h[c/16u];out[p++]=h[c%16u];}}else{const char*e=NULL;switch(c){case'"':e="\\\"";break;case'\\':e="\\\\";break;case'\b':e="\\b";break;case'\f':e="\\f";break;case'\n':e="\\n";break;case'\r':e="\\r";break;case'\t':e="\\t";break;default:break;}if(e){memcpy(out+p,e,2);p+=2;}else if(c<32u){memcpy(out+p,"\\u00",4);p+=4;out[p++]=h[c/16u];out[p++]=h[c%16u];}else out[p++]=(char)c;}}if(k==2){char x[96];int z=snprintf(x,sizeof x,"\",\"syncTime\":%" PRIuPTR "}",t);check(z>0&&(size_t)z<sizeof x,"oracle decimal",k,n,0);memcpy(out+p,x,(size_t)z);p+=(size_t)z;}return p;}
static void one_case(const uint8_t*s,size_t n,uintptr_t t){char expected[MAX_OUTPUT];uint8_t original[MAX_INPUT];memcpy(original,s,n);++case_id;for(unsigned k=0;k<3;++k){size_t needed=reference(k,expected,s,n,t),caps[]={0u,1u,needed?needed-1u:0u,needed,needed+1u,6u*n+96u};check(size_call(k,s,n,t)==needed,"size",k,n,0);check(invoke(k,NULL,MAX_OUTPUT,s,n,t)==needed,"null destination",k,n,MAX_OUTPUT);for(size_t q=0;q<sizeof caps/sizeof*caps;++q){unsigned char storage[MAX_OUTPUT+2u*GUARD];size_t cap=caps[q];memset(storage,0xA5,sizeof storage);size_t actual=invoke(k,(char*)storage+GUARD,cap,s,n,t);check(actual==needed,"return length",k,n,cap);size_t written=cap<needed?0u:needed;check(!written||memcmp(storage+GUARD,expected,written)==0,"output bytes",k,n,cap);int untouched=1;for(size_t j=0;j<GUARD;++j)if(storage[j]!=0xA5)untouched=0;for(size_t j=GUARD+written;j<sizeof storage;++j)if(storage[j]!=0xA5)untouched=0;check(untouched,"short-buffer write / guard / terminator",k,n,cap);check(memcmp(original,s,n)==0,"source mutation",k,n,cap);}}}
/* A bulk-copy fast path must preserve the ABI's existing forward copy for
 * overlapping spans. Clean data forces both transforms through copy_bytes. */
static void overlap_cases(void) {
    static const int shifts[] = {-17, -1, 0, 1, 17};
    const size_t n = 64u, source_offset = 49u;
    for (unsigned kind = 0; kind < 2; ++kind) {
        for (size_t q = 0; q < sizeof shifts / sizeof *shifts; ++q) {
            unsigned char actual[256], expected[256];
            const size_t destination_offset =
                (size_t)((ptrdiff_t)source_offset + shifts[q]);
            memset(actual, 0xA5, sizeof actual);
            for (size_t i = 0; i < n; ++i)
                actual[source_offset + i] = (unsigned char)('A' + i % 26u);
            memcpy(expected, actual, sizeof actual);
            for (size_t i = 0; i < n; ++i)
                expected[destination_offset + i] = expected[source_offset + i];
            ++case_id;
            check(invoke(kind, (char *)actual + destination_offset, n,
                         actual + source_offset, n, 0) == n,
                  "overlapping copy length", kind, n, n);
            check(memcmp(actual, expected, sizeof actual) == 0,
                  "overlapping forward copy / guards", kind, n, n);
        }
    }
}

/* Exercise packed-word classifiers at every alignment and escape boundary. */
static void word_boundary_cases(void) {
    static const uint8_t pairs[][2] = {
        {0xffu, 0x00u}, {0x20u, 0x1fu}, {'"', '\\'},
        {'\\', '"'}, {0x80u, '"'}, {0x9fu, 0x20u}
    };
    for (size_t prefix = 0; prefix < 8u; ++prefix) {
        for (size_t position = 0; position < 4u; ++position) {
            for (size_t pair = 0; pair < sizeof pairs / sizeof *pairs; ++pair) {
                uint8_t input[32];
                memset(input, 'A', sizeof input);
                input[1u + prefix + position] = pairs[pair][0];
                input[2u + prefix + position] = pairs[pair][1];
                one_case(input + 1u, prefix + position + 10u, UINTPTR_MAX);
            }
        }
    }
}

int main(void){overlap_cases();word_boundary_cases();uint8_t input[MAX_INPUT+1u];check(melodica_abi_version()==MELODICA_ABI_VERSION,"ABI",0,0,0);memset(input,0,sizeof input);one_case(input+1,0,0);for(unsigned b=0;b<256;++b){input[1]=(uint8_t)b;one_case(input+1,1,UINTPTR_MAX);}for(unsigned b=0;b<256;++b)input[b+1]=(uint8_t)b;one_case(input+1,256,UINTPTR_MAX);static const char clean[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";for(size_t i=0;i<MAX_INPUT;++i)input[i+1]=(uint8_t)clean[i%(sizeof clean-1u)];for(size_t n=0;n<=MAX_INPUT;++n)if(n<34u||n==63u||n==64u||n==65u||n==127u||n==128u||n==129u||n==255u||n==256u||n==257u||n==511u||n==512u||n==513u||n==MAX_INPUT)one_case(input+1,n,0);uintptr_t power=1u;for(;;){for(unsigned d=0;d<3;++d)one_case(input+1,33,power-1u+d);if(power>UINTPTR_MAX/10u)break;power*=10u;}for(unsigned trial=0;trial<1024;++trial){size_t n=next_random()%(MAX_INPUT+1u);for(size_t i=0;i<n;++i)input[i+1]=(uint8_t)next_random();uintptr_t t=(uintptr_t)next_random();if(sizeof(uintptr_t)>4u)t=(t<<16u)^next_random();one_case(input+1,n,t);}for(unsigned k=0;k<3;++k){unsigned char storage[32];memset(storage,0xA5,sizeof storage);check(size_call(k,NULL,SIZE_MAX,UINTPTR_MAX)==0,"null source size",k,0,0);check(invoke(k,(char*)storage,sizeof storage,NULL,SIZE_MAX,UINTPTR_MAX)==0,"null source",k,0,sizeof storage);for(size_t j=0;j<sizeof storage;++j)check(storage[j]==0xA5,"null source write",k,0,sizeof storage);}printf("conformance: %zu cases, %zu checks; all bytes, guards, short buffers, decimal boundaries: ok\n",case_id,checks);return 0;}
