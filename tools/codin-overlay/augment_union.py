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
        raise SystemExit(f"augment_union: {label}: expected exactly one anchor, found {count}")
    src = src.replace(old, new, 1)


replace_once(
    "union local state",
    '''typedef struct C99 {
\tFILE *out;''',
    '''typedef struct C99UnionLocal {
\tString name;
\tString type_name;
\tconst UnionType *type;
} C99UnionLocal;

typedef struct C99 {
\tFILE *out;''',
)

replace_once(
    "union local fields",
    '''\tconst Statement *deferred[256];
\tSize defer_count;
} C99;''',
    '''\tconst Statement *deferred[256];
\tSize defer_count;
\tC99UnionLocal union_locals[128];
\tSize union_local_count;
} C99;''',
)

replace_once(
    "union helpers",
    '''static Bool emit_identifier(C99 *c, const Identifier *identifier) {''',
    '''static const UnionType *resolve_union_type_ref(C99 *c, const Type *type, String *type_name) {
\tif (!type || type->kind != TYPE_EXPRESSION) return NULL;
\tconst Expression *expression = RCAST(const ExpressionType *, type)->expression;
\tif (!expression || expression->kind != EXPRESSION_IDENTIFIER) return NULL;
\tconst Identifier *identifier = RCAST(const IdentifierExpression *, expression)->identifier;
\tconst Type *named_type = sema_lookup_named_type(&c->sema, identifier->contents);
\tif (!named_type || named_type->kind != TYPE_UNION) return NULL;
\tif (type_name) *type_name = identifier->contents;
\treturn RCAST(const UnionType *, named_type);
}

static Sint32 union_variant_index_for_ctype(const UnionType *type, CType wanted) {
\tif (wanted == CTYPE_UNKNOWN) return -1;
\tconst Size n_variants = array_size(type->variants);
\tfor (Size i = 0; i < n_variants; i++) {
\t\tif (sema_type_from_ast(type->variants[i]) == wanted) return CAST(Sint32, i);
\t}
\treturn -1;
}

static Sint32 union_variant_index(const UnionType *type, const Type *wanted) {
\treturn union_variant_index_for_ctype(type, sema_type_from_ast(wanted));
}

static Bool add_union_local(C99 *c, String name, String type_name, const UnionType *type) {
\tif (c->union_local_count >= sizeof c->union_locals / sizeof *c->union_locals) return false;
\tC99UnionLocal *local = &c->union_locals[c->union_local_count++];
\tlocal->name = name;
\tlocal->type_name = type_name;
\tlocal->type = type;
\treturn true;
}

static const C99UnionLocal *lookup_union_local(const C99 *c, String name) {
\tfor (Size i = c->union_local_count; i > 0; i--) {
\t\tif (string_compare(c->union_locals[i - 1].name, name)) return &c->union_locals[i - 1];
\t}
\treturn NULL;
}

static Bool emit_identifier(C99 *c, const Identifier *identifier) {''',
)

replace_once(
    "checked union assertion",
    '''\tcase EXPRESSION_COMPOUND_LITERAL:
\t\treturn emit_compound_literal(c, RCAST(const CompoundLiteralExpression *, expression));''',
    '''\tcase EXPRESSION_ASSERTION: {
\t\tconst AssertionExpression *assertion = RCAST(const AssertionExpression *, expression);
\t\tif (!assertion->type) return unsupported(c, "optional union assertion");
\t\tif (!assertion->operand || assertion->operand->kind != EXPRESSION_IDENTIFIER) {
\t\t\treturn unsupported(c, "non-local union assertion");
\t\t}
\t\tconst Identifier *identifier = RCAST(const IdentifierExpression *, assertion->operand)->identifier;
\t\tconst C99UnionLocal *local = lookup_union_local(c, identifier->contents);
\t\tif (!local) return unsupported(c, "union assertion operand type");
\t\tconst Sint32 variant = union_variant_index(local->type, assertion->type);
\t\tif (variant < 0) return unsupported(c, "union assertion variant");
\t\tconst unsigned tag = CAST(unsigned, variant) + 1u;
\t\tfprintf(c->out, "(%.*s.tag == %u ? %.*s.data._%d : (abort(), %.*s.data._%d))",
\t\t        SFMT(identifier->contents), tag,
\t\t        SFMT(identifier->contents), variant,
\t\t        SFMT(identifier->contents), variant);
\t\treturn true;
\t}
\tcase EXPRESSION_COMPOUND_LITERAL:
\t\treturn emit_compound_literal(c, RCAST(const CompoundLiteralExpression *, expression));''',
)

replace_once(
    "union local construction",
    '''\tconst Expression *value = declaration->values->expressions[0];
\tif (value->kind == EXPRESSION_PROCEDURE) return unsupported(c, "nested procedure");

\tif (value->kind == EXPRESSION_COMPOUND_LITERAL) {''',
    '''\tconst Expression *value = declaration->values->expressions[0];
\tif (value->kind == EXPRESSION_PROCEDURE) return unsupported(c, "nested procedure");

\tString union_type_name = STRING_NIL;
\tconst UnionType *union_type = resolve_union_type_ref(c, declaration->type, &union_type_name);
\tif (union_type) {
\t\tconst CType value_type = sema_infer_expression(&c->sema, value);
\t\tconst Sint32 variant = union_variant_index_for_ctype(union_type, value_type);
\t\tif (variant < 0) return unsupported(c, "union initializer variant");
\t\tindent(c);
\t\tfprintf(c->out, "%.*s %.*s = (%.*s){ .tag = %u, .data._%d = ",
\t\t        SFMT(union_type_name), SFMT(declaration->names[0]->contents),
\t\t        SFMT(union_type_name), CAST(unsigned, variant) + 1u, variant);
\t\tif (!emit_expression(c, value)) return false;
\t\tfputs(" };\\n", c->out);
\t\tif (!sema_add_local(&c->sema, declaration->names[0]->contents, CTYPE_UNKNOWN)) {
\t\t\treturn unsupported(c, "local symbol capacity");
\t\t}
\t\tif (!add_union_local(c, declaration->names[0]->contents, union_type_name, union_type)) {
\t\t\treturn unsupported(c, "union local capacity");
\t\t}
\t\treturn true;
\t}

\tif (value->kind == EXPRESSION_COMPOUND_LITERAL) {''',
)

replace_once(
    "union type emitter",
    '''static Bool for_each_declaration(C99 *c, BuildContext *build, int phase) {''',
    '''static Bool emit_union_type(C99 *c, Identifier *name, const UnionType *type) {
\tif (type->kind != UNION_CONCRETE) return unsupported(c, "generic union");
\tif (type->flags) return unsupported(c, "union flags");
\tif (type->align) return unsupported(c, "union alignment override");
\tif (type->where_clauses) return unsupported(c, "union where clause");
\tconst Size n_variants = array_size(type->variants);
\tif (!n_variants) return unsupported(c, "empty union");

\tfprintf(c->out, "typedef struct %.*s {\\n", SFMT(name->contents));
\tfputs("    uint32_t tag;\\n", c->out);
\tfputs("    union {\\n", c->out);
\tfor (Size i = 0; i < n_variants; i++) {
\t\tif (sema_type_from_ast(type->variants[i]) == CTYPE_UNKNOWN) {
\t\t\treturn unsupported(c, "non-primitive union variant");
\t\t}
\t\tfputs("        ", c->out);
\t\tif (!emit_ast_type(c, type->variants[i])) return false;
\t\tfprintf(c->out, " _%zu;\\n", (size_t)i);
\t}
\tfputs("    } data;\\n", c->out);
\tfprintf(c->out, "} %.*s;\\n", SFMT(name->contents));
\treturn true;
}

static Bool for_each_declaration(C99 *c, BuildContext *build, int phase) {''',
)

replace_once(
    "top-level union dispatch",
    '''\t\t\t\tif (type && type->kind == TYPE_ENUM) {
\t\t\t\t\tif (phase == 0 && !emit_enum_type(c, name, RCAST(const EnumType *, type))) return false;
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\treturn unsupported(c, "top-level type declaration");''',
    '''\t\t\t\tif (type && type->kind == TYPE_ENUM) {
\t\t\t\t\tif (phase == 0 && !emit_enum_type(c, name, RCAST(const EnumType *, type))) return false;
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\tif (type && type->kind == TYPE_UNION) {
\t\t\t\t\tif (phase == 0 && !emit_union_type(c, name, RCAST(const UnionType *, type))) return false;
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\treturn unsupported(c, "top-level type declaration");''',
)

replace_once(
    "union lexical scope",
    '''static Bool emit_block(C99 *c, const BlockStatement *block) {
\tconst Size defer_mark = c->defer_count;''',
    '''static Bool emit_block(C99 *c, const BlockStatement *block) {
\tconst Size defer_mark = c->defer_count;
\tconst Size union_local_mark = c->union_local_count;''',
)

replace_once(
    "union lexical restore",
    '''\tc->defer_count = defer_mark;
\tc->depth--;''',
    '''\tc->defer_count = defer_mark;
\tc->union_local_count = union_local_mark;
\tc->depth--;''',
)

replace_once(
    "stdlib for checked union assertions",
    '''\t      "#include <stdint.h>\\n\\n"''',
    '''\t      "#include <stdint.h>\\n"
\t      "#include <stdlib.h>\\n\\n"''',
)

replace_once(
    "union state init",
    '''\tc.defer_count = 0;
\tsema_init(&c.sema);''',
    '''\tc.defer_count = 0;
\tc.union_local_count = 0;
\tsema_init(&c.sema);''',
)

path.write_text(src)
print("augment_union: primitive tagged unions + checked assertions applied")
