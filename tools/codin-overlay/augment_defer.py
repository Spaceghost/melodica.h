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
        raise SystemExit(f"augment_defer: {label}: expected exactly one anchor, found {count}")
    src = src.replace(old, new, 1)


replace_once(
    "defer state",
    '''\tString current_proc_name;
\tconst ProcedureExpression *current_procedure;
\tUint32 temporary_index;
} C99;''',
    '''\tString current_proc_name;
\tconst ProcedureExpression *current_procedure;
\tUint32 temporary_index;
\tconst Statement *deferred[256];
\tSize defer_count;
} C99;''',
)

replace_once(
    "defer helper",
    '''static Bool emit_expression(C99 *c, const Expression *expression);
static Bool emit_statement(C99 *c, const Statement *statement);
static Bool emit_block(C99 *c, const BlockStatement *block);
''',
    '''static Bool emit_expression(C99 *c, const Expression *expression);
static Bool emit_statement(C99 *c, const Statement *statement);
static Bool emit_block(C99 *c, const BlockStatement *block);

static Bool emit_deferred_range(C99 *c, Size mark) {
\tfor (Size i = c->defer_count; i > mark; i--) {
\t\tif (!emit_statement(c, c->deferred[i - 1])) return false;
\t}
\treturn true;
}
''',
)

replace_once(
    "return cleanup lowering",
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
    '''static Bool emit_return(C99 *c, const ReturnStatement *statement) {
\tif (!c->current_procedure) return unsupported(c, "return outside procedure");
\tif (!statement->result || array_size(statement->result->expressions) == 0) {
\t\tif (!emit_deferred_range(c, 0)) return false;
\t\tindent(c);
\t\tfputs("return;\\n", c->out);
\t\treturn true;
\t}

\tconst Size n_values = array_size(statement->result->expressions);
\tconst Size n_results = array_size(c->current_procedure->type->results);
\tconst Uint32 temporary = c->temporary_index++;

\tif (n_results > 1) {
\t\tif (n_values != n_results) return unsupported(c, "multiple return arity");
\t\tindent(c);
\t\tfprintf(c->out, "codin_ret_%.*s codin_ret_tmp_%u = (codin_ret_%.*s){ ",
\t\t        SFMT(c->current_proc_name), temporary, SFMT(c->current_proc_name));
\t\tfor (Size i = 0; i < n_values; i++) {
\t\t\tif (i) fputs(", ", c->out);
\t\t\tfprintf(c->out, "._%zu = ", (size_t)i);
\t\t\tif (!emit_expression(c, statement->result->expressions[i])) return false;
\t\t}
\t\tfputs(" };\\n", c->out);
\t} else {
\t\tif (n_values != 1) return unsupported(c, "multiple return values");
\t\tCType result = sema_procedure_result(c->current_procedure);
\t\tconst char *result_name = sema_c_type_name(result);
\t\tif (!result_name) return unsupported(c, "return capture type");
\t\tindent(c);
\t\tfprintf(c->out, "%s codin_ret_tmp_%u = ", result_name, temporary);
\t\tif (!emit_expression(c, statement->result->expressions[0])) return false;
\t\tfputs(";\\n", c->out);
\t}

\tif (!emit_deferred_range(c, 0)) return false;
\tindent(c);
\tfprintf(c->out, "return codin_ret_tmp_%u;\\n", temporary);
\treturn true;
}''',
)

replace_once(
    "case bodies are declaration-safe blocks",
    '''\t\tc->depth++;
\t\tconst Size n_statements = array_size(clause->statements);
\t\tfor (Size j = 0; j < n_statements; j++) {
\t\t\tif (!emit_statement(c, clause->statements[j])) return false;
\t\t}
\t\tindent(c); fputs("break;\\n", c->out);
\t\tc->depth--;
''',
    '''\t\tindent(c); fputs("{\\n", c->out);
\t\tc->depth++;
\t\tconst Size n_statements = array_size(clause->statements);
\t\tfor (Size j = 0; j < n_statements; j++) {
\t\t\tif (!emit_statement(c, clause->statements[j])) return false;
\t\t}
\t\tindent(c); fputs("break;\\n", c->out);
\t\tc->depth--;
\t\tindent(c); fputs("}\\n", c->out);
''',
)

replace_once(
    "defer statement",
    '''\tcase STATEMENT_BLOCK:
\t\tindent(c);
\t\treturn emit_block(c, RCAST(const BlockStatement *, statement));''',
    '''\tcase STATEMENT_DEFER: {
\t\tconst DeferStatement *defer = RCAST(const DeferStatement *, statement);
\t\tif (c->defer_count >= sizeof c->deferred / sizeof *c->deferred) {
\t\t\treturn unsupported(c, "too many active defers");
\t\t}
\t\tc->deferred[c->defer_count++] = defer->statement;
\t\treturn true;
\t}
\tcase STATEMENT_BLOCK:
\t\tindent(c);
\t\treturn emit_block(c, RCAST(const BlockStatement *, statement));''',
)

replace_once(
    "scope defer epilogue",
    '''static Bool emit_block(C99 *c, const BlockStatement *block) {
\tfputs("{\\n", c->out);
\tc->depth++;
\tconst Size n_statements = array_size(block->statements);
\tfor (Size i = 0; i < n_statements; i++) {
\t\tif (!emit_statement(c, block->statements[i])) return false;
\t}
\tc->depth--;
\tindent(c);
\tfputs("}\\n", c->out);
\treturn true;
}''',
    '''static Bool emit_block(C99 *c, const BlockStatement *block) {
\tconst Size defer_mark = c->defer_count;
\tfputs("{\\n", c->out);
\tc->depth++;
\tconst Size n_statements = array_size(block->statements);
\tfor (Size i = 0; i < n_statements; i++) {
\t\tif (!emit_statement(c, block->statements[i])) return false;
\t}
\tif (!emit_deferred_range(c, defer_mark)) return false;
\tc->defer_count = defer_mark;
\tc->depth--;
\tindent(c);
\tfputs("}\\n", c->out);
\treturn true;
}''',
)

replace_once(
    "defer state init",
    '''\tc.current_procedure = NULL;
\tc.temporary_index = 0;
\tsema_init(&c.sema);''',
    '''\tc.current_procedure = NULL;
\tc.temporary_index = 0;
\tc.defer_count = 0;
\tsema_init(&c.sema);''',
)

path.write_text(src)
print("augment_defer: lexical LIFO defers + return capture + case blocks applied")
