#include <stdio.h>

#include "string.h"
#include "build.h"
#include "c99.h"
#include "dump.h"

typedef struct Command Command;

struct Command {
	String name;
	String description;
};

static const Command COMMANDS[] = {
	{ SLIT("dump-ast"), SLIT("dump the generated syntax tree to stdout") },
	{ SLIT("emit-c"),   SLIT("emit strict C99: emit-c <package> -o <file.c>") },
};

String project_name(String path) {
	(void)path;
	return SCLIT("main");
}

static int usage(const char *app) {
	printf("Usage:\n");
	printf("\t%s dump-ast <package>\n", app);
	printf("\t%s emit-c <package> -o <file.c>\n", app);
	printf("Commands:\n");
	Size max = 0;
	for (Size i = 0; i < sizeof(COMMANDS)/sizeof *COMMANDS; i++) {
		if (COMMANDS[i].name.length > max) max = COMMANDS[i].name.length;
	}
	for (Size i = 0; i < sizeof(COMMANDS)/sizeof *COMMANDS; i++) {
		printf("\t%.*s%*c\t%.*s\n", SFMT(COMMANDS[i].name),
		       CAST(Sint32, max - COMMANDS[i].name.length), ' ', SFMT(COMMANDS[i].description));
	}
	return 1;
}

static Bool build_package(BuildContext *build, String pathname) {
	build_init(build, SCLIT("arena"), SCLIT("async"), SCLIT("spall"));
	build_add_package(build, pathname);
	build_wait(build);

	Bool ok = true;
	mutex_lock(&build->mutex);
	const Size n_work = array_size(build->work);
	for (Size i = 0; i < n_work; i++) {
		if (build->work[i]->error) {
			ok = false;
			break;
		}
	}
	mutex_unlock(&build->mutex);
	return ok;
}

static Bool dump_ast(String pathname) {
	BuildContext build;
	if (!build_package(&build, pathname)) {
		build_fini(&build);
		return false;
	}
	mutex_lock(&build.mutex);
	const Size n_work = array_size(build.work);
	for (Size i = 0; i < n_work; i++) dump(build.work[i]->tree);
	mutex_unlock(&build.mutex);
	build_fini(&build);
	return true;
}

static Bool emit_c(String pathname, const char *output) {
	BuildContext build;
	if (!build_package(&build, pathname)) {
		build_fini(&build);
		return false;
	}

	FILE *file = fopen(output, "wb");
	if (!file) {
		fprintf(stderr, "codin: could not open output '%s'\n", output);
		build_fini(&build);
		return false;
	}

	mutex_lock(&build.mutex);
	Bool ok = c99_emit_build(file, &build);
	mutex_unlock(&build.mutex);
	if (fclose(file) != 0) ok = false;
	build_fini(&build);
	return ok;
}

int main(int argc, char **argv) {
	const char *app = argv[0];
	if (argc == 3 && !strcmp(argv[1], "dump-ast")) {
		return dump_ast(string_from_null(argv[2])) ? 0 : 1;
	}
	if (argc == 5 && !strcmp(argv[1], "emit-c") && !strcmp(argv[3], "-o")) {
		return emit_c(string_from_null(argv[2]), argv[4]) ? 0 : 1;
	}
	return usage(app);
}
