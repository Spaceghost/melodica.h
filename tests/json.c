#include "json.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    const char *text =
        "{\"stat\":\"ok\",\"n\":42,\"flag\":true,"
        "\"result\":{\"name\":\"caf\\u00e9 \\ud83c\\udfb6\",\"items\":[1,2,3]}}";
    MelodicaJsonDoc doc;
    assert(melodica_json_parse(&doc, text));
    assert(doc.count > 0u);

    const size_t stat = melodica_json_object_get(&doc, 0u, "stat");
    assert(melodica_json_string_is(&doc, stat, "ok"));

    long n = 0;
    assert(melodica_json_long(&doc, melodica_json_object_get(&doc, 0u, "n"), &n));
    assert(n == 42);

    int flag = 0;
    assert(melodica_json_bool(&doc, melodica_json_object_get(&doc, 0u, "flag"), &flag));
    assert(flag == 1);

    const size_t result = melodica_json_object_get(&doc, 0u, "result");
    char *name = melodica_json_string_dup(&doc, melodica_json_object_get(&doc, result, "name"));
    assert(name != NULL);
    assert(strcmp(name, "caf\xc3\xa9 \xf0\x9f\x8e\xb6") == 0);
    free(name);

    const size_t items = melodica_json_object_get(&doc, result, "items");
    assert(melodica_json_array_count(&doc, items) == 3u);
    long third = 0;
    assert(melodica_json_long(&doc, melodica_json_array_get(&doc, items, 2u), &third));
    assert(third == 3);

    melodica_json_destroy(&doc);

    assert(!melodica_json_parse(&doc, "{\"broken\":[1,}"));
    return 0;
}
