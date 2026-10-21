#include "json.h"
#include <json-c/json.h>
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(const char *text) {
    struct json_object *reference = json_tokener_parse(text);
    MelodicaJsonDoc doc;
    assert(melodica_json_parse(&doc, text));
    char *actual = melodica_json_string_dup(&doc, 0u);
    const char *expected = json_object_get_string(reference);
    if ((actual == NULL) != (expected == NULL) ||
            (actual != NULL && strcmp(actual, expected) != 0)) {
        fprintf(stderr, "string coercion: %s: expected [%s], got [%s]\n", text,
            expected == NULL ? "<null>" : expected, actual == NULL ? "<null>" : actual);
        abort();
    }
    free(actual);
    int boolean;
    assert(melodica_json_bool(&doc, 0u, &boolean));
    assert(boolean == json_object_get_boolean(reference));
    double number;
    assert(melodica_json_double(&doc, 0u, &number));
    const double reference_number = json_object_get_double(reference);
    if (!(number == reference_number || (isnan(number) && isnan(reference_number)))) {
        fprintf(stderr, "double coercion: %s: expected %.17g, got %.17g\n", text, reference_number, number);
        abort();
    }
    /* A floating NaN to integer conversion is undefined in upstream json-c. */
    if (!isnan(reference_number)) {
        long integer;
        assert(melodica_json_long(&doc, 0u, &integer));
        assert(integer == json_object_get_int(reference));
    }
    melodica_json_destroy(&doc);
    json_object_put(reference);
}

int main(void) {
    static const char *const values[] = {
        "null", "true", "false", "TRUE", "FALSE", "NULL", "0", "-0", "1", "-1",
        "2147483648", "-2147483649", "9223372036854775808", "-9223372036854775809",
        "18446744073709551616", "9999999999999999999999999999999999999999",
        "-9999999999999999999999999999999999999999", "1.75", "-1.75", "0.0", "-0.0",
        "1e2", "1e999", "-1e999", "1e-999", "NaN", "Infinity", "-Infinity", "nan", "infINity",
        "1e", "1e+", "-0e+", "1.", "01", "\"\"", "\"true\"", "\"false\"", "\"0\"",
        "\"  -12tail\"", "\"12.75\"", "\"1e999\"", "\"Infinity\"", "\"NaN\"",
        "\"\\u0000tail\"", "\"\\ud800X\\udc00\"", "[]", "{}", "[true,null,1,\"a/b\"]",
        "{\"x\":1,\"y\":true,\"x\":2}", "{\"x\":{},\"y\":[],\"z\":\"a\\u0000b\"}",
        "{\"x\":1,\"\\u0078\":2}", "{'x': 'a/b',}", "[1,2,]", "/* c */ {\"x\":01} trailing"
    };
    for (size_t i = 0u; i < sizeof(values)/sizeof(*values); ++i) check(values[i]);
    printf("json-c accessor oracle: %zu values matched\n", sizeof(values)/sizeof(*values));
    return 0;
}
