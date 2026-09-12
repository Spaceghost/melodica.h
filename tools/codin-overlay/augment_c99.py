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
        raise SystemExit(f"augment_c99: {label}: expected exactly one anchor, found {count}")
    src = src.replace(old, new, 1)


replace_once(
    "literal type unwrap",
    '''\treturn unsupported(c, "C type");
}

static const char *binary_operator''',
    '''\treturn unsupported(c, "C type");
}

static const Type *unwrap_literal_type(const Type *type) {
\tif (type && type->kind == TYPE_EXPRESSION) {
\t\tconst Expression *expression = RCAST(const ExpressionType *, type)->expression;
\t\tif (expression && expression->kind == EXPRESSION_TYPE) {
\t\t\treturn RCAST(const TypeExpression *, expression)->type;
\t\t}
\t}
\treturn type;
}

static const char *binary_operator''',
)

replace_once(
    "compound literal lowering",
    '''static Bool emit_compound_literal(C99 *c, const CompoundLiteralExpression *literal) {
\tif (!literal->type) return unsupported(c, "untyped compound literal");
\tfputc('(', c->out);
\tif (!emit_ast_type(c, literal->type)) return false;
\tfputs("){", c->out);

\tconst Size n_fields = array_size(literal->fields);
\tfor (Size i = 0; i < n_fields; i++) {
\t\tconst Field *field = literal->fields[i];
\t\tif (!field->name || !field->value) return unsupported(c, "positional/empty compound field");
\t\tif (i) fputs(", ", c->out);
\t\tfprintf(c->out, ".%.*s = ", SFMT(field->name->contents));
\t\tif (!emit_expression(c, field->value)) return false;
\t}
\tfputc('}', c->out);
\treturn true;
}''',
    '''static Bool emit_array_initializer(C99 *c, const CompoundLiteralExpression *literal) {
\tfputc('{', c->out);
\tconst Size n_fields = array_size(literal->fields);
\tfor (Size i = 0; i < n_fields; i++) {
\t\tconst Field *field = literal->fields[i];
\t\tif (field->name || !field->value) return unsupported(c, "named/empty array initializer");
\t\tif (i) fputs(", ", c->out);
\t\tif (!emit_expression(c, field->value)) return false;
\t}
\tfputc('}', c->out);
\treturn true;
}

static Bool emit_compound_literal(C99 *c, const CompoundLiteralExpression *literal) {
\tif (!literal->type) return unsupported(c, "untyped compound literal");
\tconst Type *literal_type = unwrap_literal_type(literal->type);

\tif (literal_type->kind == TYPE_ARRAY) {
\t\tconst ArrayType *array = RCAST(const ArrayType *, literal_type);
\t\tif (!array->count) return unsupported(c, "inferred array count");
\t\tif (array->type->kind == TYPE_ARRAY) return unsupported(c, "nested fixed array");
\t\tfputc('(', c->out);
\t\tif (!emit_ast_type(c, array->type)) return false;
\t\tfputc('[', c->out);
\t\tif (!emit_expression(c, array->count)) return false;
\t\tfputs("])", c->out);
\t\treturn emit_array_initializer(c, literal);
\t}

\tfputc('(', c->out);
\tif (!emit_ast_type(c, literal_type)) return false;
\tfputs("){", c->out);

\tconst Size n_fields = array_size(literal->fields);
\tfor (Size i = 0; i < n_fields; i++) {
\t\tconst Field *field = literal->fields[i];
\t\tif (!field->name || !field->value) return unsupported(c, "positional/empty compound field");
\t\tif (i) fputs(", ", c->out);
\t\tfprintf(c->out, ".%.*s = ", SFMT(field->name->contents));
\t\tif (!emit_expression(c, field->value)) return false;
\t}
\tfputc('}', c->out);
\treturn true;
}''',
)

replace_once(
    "enum selector lowering",
    '''\tcase EXPRESSION_SELECTOR: {
\t\tconst SelectorExpression *selector = RCAST(const SelectorExpression *, expression);
\t\tif (!selector->operand) return unsupported(c, "implicit selector");
\t\tif (!emit_expression(c, selector->operand)) return false;
\t\tfputc('.', c->out);
\t\treturn emit_identifier(c, selector->identifier);
\t}''',
    '''\tcase EXPRESSION_SELECTOR: {
\t\tconst SelectorExpression *selector = RCAST(const SelectorExpression *, expression);
\t\tif (!selector->operand) return unsupported(c, "implicit selector");
\t\tif (selector->operand->kind == EXPRESSION_IDENTIFIER) {
\t\t\tconst Identifier *type_name =
\t\t\t\tRCAST(const IdentifierExpression *, selector->operand)->identifier;
\t\t\tconst Type *named_type = sema_lookup_named_type(&c->sema, type_name->contents);
\t\t\tif (named_type && named_type->kind == TYPE_ENUM) {
\t\t\t\tfprintf(c->out, "%.*s_%.*s",
\t\t\t\t        SFMT(type_name->contents), SFMT(selector->identifier->contents));
\t\t\t\treturn true;
\t\t\t}
\t\t}
\t\tif (!emit_expression(c, selector->operand)) return false;
\t\tfputc('.', c->out);
\t\treturn emit_identifier(c, selector->identifier);
\t}''',
)

replace_once(
    "fixed array local declaration",
    '''\tconst Expression *value = declaration->values->expressions[0];
\tif (value->kind == EXPRESSION_PROCEDURE) return unsupported(c, "nested procedure");

\tCType type = declaration->type ? sema_type_from_ast(declaration->type)''',
    '''\tconst Expression *value = declaration->values->expressions[0];
\tif (value->kind == EXPRESSION_PROCEDURE) return unsupported(c, "nested procedure");

\tif (value->kind == EXPRESSION_COMPOUND_LITERAL) {
\t\tconst CompoundLiteralExpression *literal = RCAST(const CompoundLiteralExpression *, value);
\t\tconst Type *literal_type = unwrap_literal_type(literal->type);
\t\tif (literal_type && literal_type->kind == TYPE_ARRAY) {
\t\t\tconst ArrayType *array = RCAST(const ArrayType *, literal_type);
\t\t\tif (!array->count) return unsupported(c, "inferred array count");
\t\t\tif (array->type->kind == TYPE_ARRAY) return unsupported(c, "nested fixed array");

\t\t\tindent(c);
\t\t\tif (!emit_ast_type(c, array->type)) return false;
\t\t\tfprintf(c->out, " %.*s[", SFMT(declaration->names[0]->contents));
\t\t\tif (!emit_expression(c, array->count)) return false;
\t\t\tfputs("] = ", c->out);
\t\t\tif (!emit_array_initializer(c, literal)) return false;
\t\t\tfputs(";\\n", c->out);

\t\t\tif (!sema_add_local(&c->sema, declaration->names[0]->contents, CTYPE_UNKNOWN)) {
\t\t\t\treturn unsupported(c, "local symbol capacity");
\t\t\t}
\t\t\treturn true;
\t\t}
\t}

\tCType type = declaration->type ? sema_type_from_ast(declaration->type)''',
)

replace_once(
    "enum type emitter",
    '''\tfprintf(c->out, "} %.*s;\\n", SFMT(name->contents));
\treturn true;
}

static Bool for_each_declaration''',
    '''\tfprintf(c->out, "} %.*s;\\n", SFMT(name->contents));
\treturn true;
}

static Bool emit_enum_type(C99 *c, Identifier *name, const EnumType *type) {
\tif (!type->type) return unsupported(c, "enum without explicit backing type");
\tCType backing = sema_type_from_ast(type->type);
\tconst char *backing_name = sema_c_type_name(backing);
\tif (!backing_name) return unsupported(c, "enum backing type");

\tfprintf(c->out, "typedef %s %.*s;\\n", backing_name, SFMT(name->contents));
\tfputs("enum {\\n", c->out);
\tconst Size n_fields = array_size(type->fields);
\tfor (Size i = 0; i < n_fields; i++) {
\t\tconst Field *field = type->fields[i];
\t\tif (!field->name) return unsupported(c, "enum field");
\t\tfprintf(c->out, "    %.*s_%.*s",
\t\t        SFMT(name->contents), SFMT(field->name->contents));
\t\tif (field->value) {
\t\t\tfputs(" = ", c->out);
\t\t\tif (!emit_expression(c, field->value)) return false;
\t\t}
\t\tfputs(i + 1 < n_fields ? ",\\n" : "\\n", c->out);
\t}
\tfputs("};\\n", c->out);
\treturn true;
}

static Bool for_each_declaration''',
)

replace_once(
    "top-level enum dispatch",
    '''\t\t\t\tif (type && type->kind == TYPE_STRUCT) {
\t\t\t\t\tif (phase == 0 && !emit_struct_type(c, name, RCAST(const StructType *, type))) return false;
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\treturn unsupported(c, "top-level type declaration");''',
    '''\t\t\t\tif (type && type->kind == TYPE_STRUCT) {
\t\t\t\t\tif (phase == 0 && !emit_struct_type(c, name, RCAST(const StructType *, type))) return false;
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\tif (type && type->kind == TYPE_ENUM) {
\t\t\t\t\tif (phase == 0 && !emit_enum_type(c, name, RCAST(const EnumType *, type))) return false;
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\treturn unsupported(c, "top-level type declaration");''',
)

path.write_text(src)
print("augment_c99: fixed arrays + explicit-width enums applied")
