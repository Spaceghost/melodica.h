#ifndef CODIN_SEMA_H
#define CODIN_SEMA_H

#include "build.h"
#include "tree.h"

typedef enum CType {
	CTYPE_UNKNOWN,
	CTYPE_VOID,
	CTYPE_BOOL,
	CTYPE_U8,
	CTYPE_U32,
	CTYPE_UINTPTR,
	CTYPE_U8_PTR,
} CType;

typedef struct SemSymbol {
	String name;
	CType type;
	const ProcedureExpression *procedure;
	Bool exported;
} SemSymbol;

typedef struct Sema {
	SemSymbol globals[256];
	Size global_count;
	SemSymbol locals[256];
	Size local_count;
} Sema;

void sema_init(Sema *sema);
Bool sema_collect_globals(Sema *sema, const BuildContext *build);
void sema_begin_procedure(Sema *sema, const ProcedureExpression *procedure);
Bool sema_add_local(Sema *sema, String name, CType type);
const SemSymbol *sema_lookup(const Sema *sema, String name);
CType sema_type_from_ast(const Type *type);
CType sema_infer_expression(const Sema *sema, const Expression *expression);
CType sema_procedure_result(const ProcedureExpression *procedure);
Bool sema_declaration_is_exported(const DeclarationStatement *declaration);
const char *sema_c_type_name(CType type);

#endif
