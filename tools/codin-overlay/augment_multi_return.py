#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit(f"usage: {sys.argv[0]} path/to/src/c99.c")

path = Path(sys.argv[1])
src = path.read_text()


def replace_once(label: str, old: str, new: str) -> None:
    global src
    count = src.count(old)
    if count != 1:
        raise SystemExit(f"augment_multi_return: {label}: expected exactly one anchor, found {count}")
    src = src.replace(old, new, 1)


replace_once(
    "emitter state",
    '''typedef struct C99 {
\tFILE *out;
\tSema sema;
\tSint32 depth;
\tBool ok;
} C99;''',
    '''typedef struct C99 {
\tFILE *out;
\tSema sema;
\tSint32 depth;
\tBool ok;
\tString current_proc_name;
\tconst ProcedureExpression *current_procedure;
\tUint32 temporary_index;
} C99;''',
)

replace_once(
    "multiple declaration lowering",
    '''static Bool emit_declaration(C99 *c, const DeclarationStatement *declaration) {
\tif (!declaration->values || array_size(declaration->names) != 1 ||
\t    array_size(declaration->values->expressions) != 1) {
\t\treturn unsupported(c, "multi-name declaration");
\t}

\tconst Expression *value = declaration->values->expressions[0];''',
    '''static Bool emit_multi_declaration(C99 *c, const DeclarationStatement *declaration) {
\tconst Size n_names = array_size(declaration->names);
\tif (!declaration->values || n_names < 2 || array_size(declaration->values->expressions) != 1) {
\t\treturn unsupported(c, "multi-name declaration shape");
\t}

\tconst Expression *value = declaration->values->expressions[0];
\tif (value->kind != EXPRESSION_CALL) return unsupported(c, "multi-name non-call declaration");
\tconst CallExpression *call = RCAST(const CallExpression *, value);
\tif (call->operand->kind != EXPRESSION_IDENTIFIER) return unsupported(c, "multi-return call operand");
\tconst Identifier *callee = RCAST(const IdentifierExpression *, call->operand)->identifier;
\tconst SemSymbol *symbol = sema_lookup(&c->sema, callee->contents);
\tif (!symbol || !symbol->procedure) return unsupported(c, "multi-return callee");

\tconst Size n_results = array_size(symbol->procedure->type->results);
\tif (n_results != n_names || n_results < 2) return unsupported(c, "multi-return arity");

\tconst Uint32 temporary = c->temporary_index++;
\tindent(c);
\tfprintf(c->out, "codin_ret_%.*s codin_tmp_%u = ", SFMT(callee->contents), temporary);
\tif (!emit_expression(c, value)) return false;
\tfputs(";\\n", c->out);

\tfor (Size i = 0; i < n_names; i++) {
\t\tconst Field *result = symbol->procedure->type->results[i];
\t\tCType type = sema_type_from_ast(result->type);
\t\tconst char *type_name = sema_c_type_name(type);
\t\tif (!type_name) return unsupported(c, "multi-return result type");
\t\tif (!sema_add_local(&c->sema, declaration->names[i]->contents, type)) {
\t\t\treturn unsupported(c, "local symbol capacity");
\t\t}
\t\tindent(c);
\t\tfprintf(c->out, "%s %.*s = codin_tmp_%u._%zu;\\n",
\t\t        type_name, SFMT(declaration->names[i]->contents), temporary, (size_t)i);
\t}
\treturn true;
}

static Bool emit_declaration(C99 *c, const DeclarationStatement *declaration) {
\tif (!declaration->values) return unsupported(c, "declaration without values");
\tif (array_size(declaration->names) > 1) return emit_multi_declaration(c, declaration);
\tif (array_size(declaration->names) != 1 || array_size(declaration->values->expressions) != 1) {
\t\treturn unsupported(c, "declaration shape");
\t}

\tconst Expression *value = declaration->values->expressions[0];''',
)

replace_once(
    "multiple return statement",
    '''static Bool emit_return(C99 *c, const ReturnStatement *statement) {
\tindent(c);
\tif (!statement->result || array_size(statement->result->expressions) == 0) {
\t\tfputs("return;\\n", c->out);
\t\treturn true;
\t}
\tif (array_size(statement->result->expressions) != 1) return unsupported(c, "multiple return values");
\tfputs("return ", c->out);
\tif (!emit_expression(c, statement->result->expressions[0])) return false;
\tfputs(";\\n", c->out);
\treturn true;
}''',
    '''static Bool emit_return(C99 *c, const ReturnStatement *statement) {
\tindent(c);
\tif (!statement->result || array_size(statement->result->expressions) == 0) {
\t\tfputs("return;\\n", c->out);
\t\treturn true;
\t}

\tconst Size n_values = array_size(statement->result->expressions);
\tconst Size n_results = c->current_procedure
\t                     ? array_size(c->current_procedure->type->results) : 0;
\tif (n_results > 1) {
\t\tif (n_values != n_results) return unsupported(c, "multiple return arity");
\t\tfprintf(c->out, "return (codin_ret_%.*s){ ", SFMT(c->current_proc_name));
\t\tfor (Size i = 0; i < n_values; i++) {
\t\t\tif (i) fputs(", ", c->out);
\t\t\tfprintf(c->out, "._%zu = ", (size_t)i);
\t\t\tif (!emit_expression(c, statement->result->expressions[i])) return false;
\t\t}
\t\tfputs(" };\\n", c->out);
\t\treturn true;
\t}

\tif (n_values != 1) return unsupported(c, "multiple return values");
\tfputs("return ", c->out);
\tif (!emit_expression(c, statement->result->expressions[0])) return false;
\tfputs(";\\n", c->out);
\treturn true;
}''',
)

replace_once(
    "procedure result lowering",
    '''static Bool emit_prototype(C99 *c, const DeclarationStatement *declaration,
                           Identifier *name, const ProcedureExpression *procedure) {
\tCType result = sema_procedure_result(procedure);
\tconst char *result_name = sema_c_type_name(result);
\tif (!result_name) return unsupported(c, "procedure result type");
\tif (!sema_declaration_is_exported(declaration)) fputs("static ", c->out);
\tfprintf(c->out, "%s %.*s(", result_name, SFMT(name->contents));
\tif (!emit_parameters(c, procedure)) return false;
\tfputs(");\\n", c->out);
\treturn true;
}

static Bool emit_definition(C99 *c, const DeclarationStatement *declaration,
                            Identifier *name, const ProcedureExpression *procedure) {
\tCType result = sema_procedure_result(procedure);
\tconst char *result_name = sema_c_type_name(result);
\tif (!result_name) return unsupported(c, "procedure result type");

\tsema_begin_procedure(&c->sema, procedure);
\tif (!sema_declaration_is_exported(declaration)) fputs("static ", c->out);
\tfprintf(c->out, "%s %.*s(", result_name, SFMT(name->contents));
\tif (!emit_parameters(c, procedure)) return false;
\tfputs(") ", c->out);
\tif (!emit_block(c, procedure->body)) return false;
\tfputc('\\n', c->out);
\treturn true;
}''',
    '''static Bool emit_procedure_result_type(C99 *c, Identifier *name,
                                       const ProcedureExpression *procedure) {
\tconst Size n_results = array_size(procedure->type->results);
\tif (n_results > 1) {
\t\tfprintf(c->out, "codin_ret_%.*s", SFMT(name->contents));
\t\treturn true;
\t}
\tCType result = sema_procedure_result(procedure);
\tconst char *result_name = sema_c_type_name(result);
\tif (!result_name) return unsupported(c, "procedure result type");
\tfputs(result_name, c->out);
\treturn true;
}

static Bool emit_multi_return_type(C99 *c, Identifier *name,
                                   const ProcedureExpression *procedure) {
\tconst Size n_results = array_size(procedure->type->results);
\tif (n_results < 2) return true;
\tfprintf(c->out, "typedef struct codin_ret_%.*s {\\n", SFMT(name->contents));
\tfor (Size i = 0; i < n_results; i++) {
\t\tconst Field *result = procedure->type->results[i];
\t\tfputs("    ", c->out);
\t\tif (!emit_ast_type(c, result->type)) return false;
\t\tfprintf(c->out, " _%zu;\\n", (size_t)i);
\t}
\tfprintf(c->out, "} codin_ret_%.*s;\\n", SFMT(name->contents));
\treturn true;
}

static Bool emit_prototype(C99 *c, const DeclarationStatement *declaration,
                           Identifier *name, const ProcedureExpression *procedure) {
\tif (!sema_declaration_is_exported(declaration)) fputs("static ", c->out);
\tif (!emit_procedure_result_type(c, name, procedure)) return false;
\tfprintf(c->out, " %.*s(", SFMT(name->contents));
\tif (!emit_parameters(c, procedure)) return false;
\tfputs(");\\n", c->out);
\treturn true;
}

static Bool emit_definition(C99 *c, const DeclarationStatement *declaration,
                            Identifier *name, const ProcedureExpression *procedure) {
\tsema_begin_procedure(&c->sema, procedure);
\tif (!sema_declaration_is_exported(declaration)) fputs("static ", c->out);
\tif (!emit_procedure_result_type(c, name, procedure)) return false;
\tfprintf(c->out, " %.*s(", SFMT(name->contents));
\tif (!emit_parameters(c, procedure)) return false;
\tfputs(") ", c->out);

\tString saved_name = c->current_proc_name;
\tconst ProcedureExpression *saved_procedure = c->current_procedure;
\tc->current_proc_name = name->contents;
\tc->current_procedure = procedure;
\tBool ok = emit_block(c, procedure->body);
\tc->current_proc_name = saved_name;
\tc->current_procedure = saved_procedure;
\tif (!ok) return false;
\tfputc('\\n', c->out);
\treturn true;
}''',
)

replace_once(
    "phase zero return structs",
    '''\t\t\tif (value->kind == EXPRESSION_PROCEDURE) {
\t\t\t\tconst ProcedureExpression *procedure = RCAST(const ProcedureExpression *, value);
\t\t\t\tif (phase == 1 && !emit_prototype(c, declaration, name, procedure)) return false;
\t\t\t\tif (phase == 2 && !emit_definition(c, declaration, name, procedure)) return false;
\t\t\t} else if (phase == 0) {''',
    '''\t\t\tif (value->kind == EXPRESSION_PROCEDURE) {
\t\t\t\tconst ProcedureExpression *procedure = RCAST(const ProcedureExpression *, value);
\t\t\t\tif (phase == 0 && !emit_multi_return_type(c, name, procedure)) return false;
\t\t\t\tif (phase == 1 && !emit_prototype(c, declaration, name, procedure)) return false;
\t\t\t\tif (phase == 2 && !emit_definition(c, declaration, name, procedure)) return false;
\t\t\t} else if (phase == 0) {''',
)

replace_once(
    "state initialization",
    '''\tc.out = out;
\tc.depth = 0;
\tc.ok = true;
\tsema_init(&c.sema);''',
    '''\tc.out = out;
\tc.depth = 0;
\tc.ok = true;
\tc.current_proc_name = STRING_NIL;
\tc.current_procedure = NULL;
\tc.temporary_index = 0;
\tsema_init(&c.sema);''',
)

path.write_text(src)
print("augment_multi_return: struct-return ABI + destructuring applied")
