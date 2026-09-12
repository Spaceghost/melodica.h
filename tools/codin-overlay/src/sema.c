#include "sema.h"

#include "string.h"

static CType ctype_from_name(String name) {
	if (string_compare(name, SCLIT("bool")))    return CTYPE_BOOL;
	if (string_compare(name, SCLIT("u8")))      return CTYPE_U8;
	if (string_compare(name, SCLIT("u32")))     return CTYPE_U32;
	if (string_compare(name, SCLIT("uintptr"))) return CTYPE_UINTPTR;
	return CTYPE_UNKNOWN;
}

void sema_init(Sema *sema) {
	sema->global_count = 0;
	sema->local_count = 0;
}

const char *sema_c_type_name(CType type) {
	switch (type) {
	case CTYPE_VOID:    return "void";
	case CTYPE_BOOL:    return "bool";
	case CTYPE_U8:      return "uint8_t";
	case CTYPE_U32:     return "uint32_t";
	case CTYPE_UINTPTR: return "uintptr_t";
	case CTYPE_U8_PTR:  return "uint8_t *";
	case CTYPE_UNKNOWN: break;
	}
	return NULL;
}

CType sema_type_from_ast(const Type *type) {
	if (!type) return CTYPE_UNKNOWN;

	switch (type->kind) {
	case TYPE_BUILTIN:
		return ctype_from_name(RCAST(const BuiltinType *, type)->identifier);
	case TYPE_EXPRESSION: {
		const Expression *expression = RCAST(const ExpressionType *, type)->expression;
		if (expression && expression->kind == EXPRESSION_IDENTIFIER) {
			const Identifier *identifier = RCAST(const IdentifierExpression *, expression)->identifier;
			return ctype_from_name(identifier->contents);
		}
		return CTYPE_UNKNOWN;
	}
	case TYPE_POINTER:
		return sema_type_from_ast(RCAST(const PointerType *, type)->type) == CTYPE_U8 ? CTYPE_U8_PTR : CTYPE_UNKNOWN;
	case TYPE_MULTI_POINTER:
		return sema_type_from_ast(RCAST(const MultiPointerType *, type)->type) == CTYPE_U8 ? CTYPE_U8_PTR : CTYPE_UNKNOWN;
	default:
		return CTYPE_UNKNOWN;
	}
}

CType sema_procedure_result(const ProcedureExpression *procedure) {
	const Size n_results = array_size(procedure->type->results);
	if (n_results == 0) return CTYPE_VOID;
	if (n_results != 1) return CTYPE_UNKNOWN;
	return sema_type_from_ast(procedure->type->results[0]->type);
}

Bool sema_declaration_is_exported(const DeclarationStatement *declaration) {
	/*
	 * Codin's old parser leaves DeclarationStatement.attributes uninitialized
	 * for declarations without a parser-owned attribute array. Do not inspect
	 * it in the C99 bring-up subset. Our public ABI is intentionally namespaced,
	 * so linkage is derived from the stable melodica_ prefix until attribute
	 * ownership is repaired in the upstream fork.
	 */
	return array_size(declaration->names) == 1 &&
	       string_starts_with(declaration->names[0]->contents, SCLIT("melodica_"));
}

static Bool add_symbol(SemSymbol *symbols, Size *count, String name, CType type,
                       const ProcedureExpression *procedure, Bool exported) {
	if (*count >= 256) return false;
	symbols[*count].name = name;
	symbols[*count].type = type;
	symbols[*count].procedure = procedure;
	symbols[*count].exported = exported;
	(*count)++;
	return true;
}

Bool sema_add_local(Sema *sema, String name, CType type) {
	return add_symbol(sema->locals, &sema->local_count, name, type, NULL, false);
}

const SemSymbol *sema_lookup(const Sema *sema, String name) {
	for (Size i = sema->local_count; i > 0; i--) {
		if (string_compare(sema->locals[i - 1].name, name)) return &sema->locals[i - 1];
	}
	for (Size i = sema->global_count; i > 0; i--) {
		if (string_compare(sema->globals[i - 1].name, name)) return &sema->globals[i - 1];
	}
	return NULL;
}

static CType infer_identifier(const Sema *sema, const IdentifierExpression *expression) {
	const String name = expression->identifier->contents;
	CType builtin = ctype_from_name(name);
	if (builtin != CTYPE_UNKNOWN) return builtin;
	const SemSymbol *symbol = sema_lookup(sema, name);
	return symbol ? symbol->type : CTYPE_UNKNOWN;
}

CType sema_infer_expression(const Sema *sema, const Expression *expression) {
	if (!expression) return CTYPE_UNKNOWN;

	switch (expression->kind) {
	case EXPRESSION_IDENTIFIER:
		return infer_identifier(sema, RCAST(const IdentifierExpression *, expression));
	case EXPRESSION_TYPE:
		return sema_type_from_ast(RCAST(const TypeExpression *, expression)->type);
	case EXPRESSION_CAST:
		return sema_type_from_ast(RCAST(const CastExpression *, expression)->type);
	case EXPRESSION_CALL: {
		const CallExpression *call = RCAST(const CallExpression *, expression);
		if (call->operand->kind == EXPRESSION_IDENTIFIER) {
			const String name = RCAST(const IdentifierExpression *, call->operand)->identifier->contents;
			CType builtin = ctype_from_name(name);
			if (builtin != CTYPE_UNKNOWN) return builtin;
			const SemSymbol *symbol = sema_lookup(sema, name);
			if (symbol && symbol->procedure) return symbol->type;
		}
		return CTYPE_UNKNOWN;
	}
	case EXPRESSION_INDEX: {
		const IndexExpression *index = RCAST(const IndexExpression *, expression);
		return sema_infer_expression(sema, index->operand) == CTYPE_U8_PTR ? CTYPE_U8 : CTYPE_UNKNOWN;
	}
	case EXPRESSION_TUPLE: {
		const TupleExpression *tuple = RCAST(const TupleExpression *, expression);
		return array_size(tuple->expressions) == 1 ? sema_infer_expression(sema, tuple->expressions[0]) : CTYPE_UNKNOWN;
	}
	case EXPRESSION_BINARY: {
		const BinaryExpression *binary = RCAST(const BinaryExpression *, expression);
		switch (binary->operation) {
		case OPERATOR_CMPEQ: case OPERATOR_NOTEQ:
		case OPERATOR_LT: case OPERATOR_GT: case OPERATOR_LTEQ: case OPERATOR_GTEQ:
		case OPERATOR_CMPAND: case OPERATOR_CMPOR:
			return CTYPE_BOOL;
		default: {
			CType lhs = sema_infer_expression(sema, binary->lhs);
			if (lhs != CTYPE_UNKNOWN) return lhs;
			return sema_infer_expression(sema, binary->rhs);
		}
		}
	}
	case EXPRESSION_LITERAL:
		return CTYPE_UNKNOWN;
	default:
		return CTYPE_UNKNOWN;
	}
}

Bool sema_collect_globals(Sema *sema, const BuildContext *build) {
	const Size n_work = array_size(build->work);
	for (Size w = 0; w < n_work; w++) {
		const Tree *tree = build->work[w]->tree;
		const Size n_statements = array_size(tree->statements);
		for (Size i = 0; i < n_statements; i++) {
			const Statement *statement = tree->statements[i];
			if (statement->kind != STATEMENT_DECLARATION) continue;
			const DeclarationStatement *declaration = RCAST(const DeclarationStatement *, statement);
			if (!declaration->values || array_size(declaration->names) != 1 ||
			    array_size(declaration->values->expressions) != 1) continue;

			const Expression *value = declaration->values->expressions[0];
			const ProcedureExpression *procedure = NULL;
			CType type = CTYPE_UNKNOWN;
			if (value->kind == EXPRESSION_PROCEDURE) {
				procedure = RCAST(const ProcedureExpression *, value);
				type = sema_procedure_result(procedure);
			} else {
				type = declaration->type ? sema_type_from_ast(declaration->type)
				                         : sema_infer_expression(sema, value);
			}

			if (!add_symbol(sema->globals, &sema->global_count,
			                declaration->names[0]->contents, type, procedure,
			                sema_declaration_is_exported(declaration))) return false;
		}
	}
	return true;
}

void sema_begin_procedure(Sema *sema, const ProcedureExpression *procedure) {
	sema->local_count = 0;
	const Size n_params = array_size(procedure->type->params);
	for (Size i = 0; i < n_params; i++) {
		const Field *field = procedure->type->params[i];
		if (field->name) {
			sema_add_local(sema, field->name->contents, sema_type_from_ast(field->type));
		}
	}
}
