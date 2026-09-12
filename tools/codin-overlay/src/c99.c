#include "c99.h"

#include <stdint.h>

#include "ir.h"
#include "sema.h"
#include "string.h"
#include "tree.h"

typedef struct C99 {
	FILE *out;
	Sema sema;
	Sint32 depth;
	Bool ok;
} C99;

static Bool emit_expression(C99 *c, const Expression *expression);
static Bool emit_statement(C99 *c, const Statement *statement);
static Bool emit_block(C99 *c, const BlockStatement *block);

static void indent(C99 *c) {
	for (Sint32 i = 0; i < c->depth; i++) fputs("    ", c->out);
}

static Bool unsupported(C99 *c, const char *what) {
	fprintf(stderr, "codin: c99: unsupported %s\n", what);
	c->ok = false;
	return false;
}

static Bool emit_identifier(C99 *c, const Identifier *identifier) {
	if (string_compare(identifier->contents, SCLIT("nil"))) {
		fputs("NULL", c->out);
		return true;
	}
	fprintf(c->out, "%.*s", SFMT(identifier->contents));
	return true;
}

static const char *binary_operator(OperatorKind operation) {
	switch (operation) {
	case OPERATOR_CMPOR:  return "||";
	case OPERATOR_CMPAND: return "&&";
	case OPERATOR_CMPEQ:  return "==";
	case OPERATOR_NOTEQ:  return "!=";
	case OPERATOR_LT:     return "<";
	case OPERATOR_GT:     return ">";
	case OPERATOR_LTEQ:   return "<=";
	case OPERATOR_GTEQ:   return ">=";
	case OPERATOR_ADD:    return "+";
	case OPERATOR_SUB:    return "-";
	case OPERATOR_OR:     return "|";
	case OPERATOR_XOR:    return "^";
	case OPERATOR_QUO:    return "/";
	case OPERATOR_MUL:    return "*";
	case OPERATOR_MOD:    return "%";
	case OPERATOR_AND:    return "&";
	case OPERATOR_SHL:    return "<<";
	case OPERATOR_SHR:    return ">>";
	default: return NULL;
	}
}

static Bool emit_tuple_one(C99 *c, const TupleExpression *tuple) {
	if (!tuple || array_size(tuple->expressions) != 1) return unsupported(c, "multi-value tuple");
	return emit_expression(c, tuple->expressions[0]);
}

static Bool emit_call(C99 *c, const CallExpression *call) {
	if (call->operand->kind == EXPRESSION_IDENTIFIER) {
		const Identifier *identifier = RCAST(const IdentifierExpression *, call->operand)->identifier;
		CType cast_type = CTYPE_UNKNOWN;
		if (string_compare(identifier->contents, SCLIT("u8"))) cast_type = CTYPE_U8;
		else if (string_compare(identifier->contents, SCLIT("u32"))) cast_type = CTYPE_U32;
		else if (string_compare(identifier->contents, SCLIT("uintptr"))) cast_type = CTYPE_UINTPTR;
		else if (string_compare(identifier->contents, SCLIT("bool"))) cast_type = CTYPE_BOOL;
		if (cast_type != CTYPE_UNKNOWN) {
			if (array_size(call->arguments) != 1) return unsupported(c, "multi-argument scalar cast");
			fprintf(c->out, "((%s)(", sema_c_type_name(cast_type));
			if (!emit_expression(c, call->arguments[0]->value)) return false;
			fputs("))", c->out);
			return true;
		}
	}

	if (!emit_expression(c, call->operand)) return false;
	fputc('(', c->out);
	const Size n_arguments = array_size(call->arguments);
	for (Size i = 0; i < n_arguments; i++) {
		if (i) fputs(", ", c->out);
		if (!emit_expression(c, call->arguments[i]->value)) return false;
	}
	fputc(')', c->out);
	return true;
}

static Bool emit_expression(C99 *c, const Expression *expression) {
	if (!expression) return unsupported(c, "null expression");

	switch (expression->kind) {
	case EXPRESSION_IDENTIFIER:
		return emit_identifier(c, RCAST(const IdentifierExpression *, expression)->identifier);
	case EXPRESSION_LITERAL:
		fprintf(c->out, "%.*s", SFMT(RCAST(const LiteralExpression *, expression)->value));
		return true;
	case EXPRESSION_TUPLE:
		return emit_tuple_one(c, RCAST(const TupleExpression *, expression));
	case EXPRESSION_INDEX: {
		const IndexExpression *index = RCAST(const IndexExpression *, expression);
		if (index->rhs) return unsupported(c, "multi-index expression");
		if (!emit_expression(c, index->operand)) return false;
		fputc('[', c->out);
		if (!emit_expression(c, index->lhs)) return false;
		fputc(']', c->out);
		return true;
	}
	case EXPRESSION_CALL:
		return emit_call(c, RCAST(const CallExpression *, expression));
	case EXPRESSION_CAST: {
		const CastExpression *cast = RCAST(const CastExpression *, expression);
		CType type = sema_type_from_ast(cast->type);
		const char *name = sema_c_type_name(type);
		if (!name) return unsupported(c, "cast type");
		fprintf(c->out, "((%s)(", name);
		if (!emit_expression(c, cast->expression)) return false;
		fputs("))", c->out);
		return true;
	}
	case EXPRESSION_UNARY: {
		const UnaryExpression *unary = RCAST(const UnaryExpression *, expression);
		const char *op = NULL;
		switch (unary->operation) {
		case OPERATOR_NOT: op = "!"; break;
		case OPERATOR_SUB: op = "-"; break;
		case OPERATOR_ADD: op = "+"; break;
		default: return unsupported(c, "unary operator");
		}
		fputc('(', c->out);
		fputs(op, c->out);
		if (!emit_expression(c, unary->operand)) return false;
		fputc(')', c->out);
		return true;
	}
	case EXPRESSION_BINARY: {
		const BinaryExpression *binary = RCAST(const BinaryExpression *, expression);
		if (binary->operation == OPERATOR_ANDNOT) {
			fputc('(', c->out);
			if (!emit_expression(c, binary->lhs)) return false;
			fputs(" & ~(", c->out);
			if (!emit_expression(c, binary->rhs)) return false;
			fputs("))", c->out);
			return true;
		}
		const char *op = binary_operator(binary->operation);
		if (!op) return unsupported(c, "binary operator");
		fputc('(', c->out);
		if (!emit_expression(c, binary->lhs)) return false;
		fprintf(c->out, " %s ", op);
		if (!emit_expression(c, binary->rhs)) return false;
		fputc(')', c->out);
		return true;
	}
	default:
		return unsupported(c, "expression kind");
	}
}

static const char *assignment_operator(AssignmentKind assignment) {
	switch (assignment) {
	case ASSIGNMENT_EQ:  return "=";
	case ASSIGNMENT_ADD: return "+=";
	case ASSIGNMENT_SUB: return "-=";
	case ASSIGNMENT_MUL: return "*=";
	case ASSIGNMENT_QUO: return "/=";
	case ASSIGNMENT_MOD: return "%=";
	case ASSIGNMENT_AND: return "&=";
	case ASSIGNMENT_OR:  return "|=";
	case ASSIGNMENT_XOR: return "^=";
	case ASSIGNMENT_SHL: return "<<=";
	case ASSIGNMENT_SHR: return ">>=";
	default: return NULL;
	}
}

static Bool emit_declaration(C99 *c, const DeclarationStatement *declaration) {
	if (!declaration->values || array_size(declaration->names) != 1 ||
	    array_size(declaration->values->expressions) != 1) {
		return unsupported(c, "multi-name declaration");
	}

	const Expression *value = declaration->values->expressions[0];
	if (value->kind == EXPRESSION_PROCEDURE) return unsupported(c, "nested procedure");

	CType type = declaration->type ? sema_type_from_ast(declaration->type)
	                               : sema_infer_expression(&c->sema, value);
	if (type == CTYPE_UNKNOWN && value->kind == EXPRESSION_LITERAL) type = CTYPE_UINTPTR;
	const char *name = sema_c_type_name(type);
	if (!name) return unsupported(c, "inferred local type");

	if (!sema_add_local(&c->sema, declaration->names[0]->contents, type)) {
		return unsupported(c, "local symbol capacity");
	}
	indent(c);
	fprintf(c->out, "%s %.*s = ", name, SFMT(declaration->names[0]->contents));
	if (!emit_expression(c, value)) return false;
	fputs(";\n", c->out);
	return true;
}

static Bool emit_assignment(C99 *c, const AssignmentStatement *assignment) {
	if (array_size(assignment->lhs->expressions) != 1 || array_size(assignment->rhs->expressions) != 1) {
		return unsupported(c, "tuple assignment");
	}
	const char *op = assignment_operator(assignment->assignment);
	if (!op) return unsupported(c, "assignment operator");
	indent(c);
	if (!emit_expression(c, assignment->lhs->expressions[0])) return false;
	fprintf(c->out, " %s ", op);
	if (!emit_expression(c, assignment->rhs->expressions[0])) return false;
	fputs(";\n", c->out);
	return true;
}

static Bool emit_if(C99 *c, const IfStatement *statement) {
	if (statement->init) return unsupported(c, "if initializer");
	indent(c);
	fputs("if (", c->out);
	if (!emit_expression(c, statement->cond)) return false;
	fputs(") ", c->out);
	if (!emit_block(c, statement->body)) return false;
	if (statement->elif) {
		indent(c);
		fputs("else ", c->out);
		if (!emit_block(c, statement->elif)) return false;
	}
	return true;
}

static Bool emit_return(C99 *c, const ReturnStatement *statement) {
	indent(c);
	if (!statement->result || array_size(statement->result->expressions) == 0) {
		fputs("return;\n", c->out);
		return true;
	}
	if (array_size(statement->result->expressions) != 1) return unsupported(c, "multiple return values");
	fputs("return ", c->out);
	if (!emit_expression(c, statement->result->expressions[0])) return false;
	fputs(";\n", c->out);
	return true;
}

static Bool emit_for(C99 *c, const ForStatement *statement) {
	IRRangeFor range;
	if (!ir_lower_range_for(statement, &range)) return unsupported(c, "non-range for loop");

	CType index_type = sema_infer_expression(&c->sema, range.limit);
	if (index_type == CTYPE_UNKNOWN) index_type = CTYPE_UINTPTR;
	const char *name = sema_c_type_name(index_type);
	if (!name) return unsupported(c, "range index type");

	const Size saved_locals = c->sema.local_count;
	if (!sema_add_local(&c->sema, range.index->contents, index_type)) return unsupported(c, "local symbol capacity");

	indent(c);
	fprintf(c->out, "for (%s %.*s = ", name, SFMT(range.index->contents));
	if (!emit_expression(c, range.first)) return false;
	fprintf(c->out, "; %.*s %s ", SFMT(range.index->contents), range.inclusive ? "<=" : "<");
	if (!emit_expression(c, range.limit)) return false;
	fprintf(c->out, "; ++%.*s) ", SFMT(range.index->contents));
	if (!emit_block(c, statement->body)) return false;
	c->sema.local_count = saved_locals;
	return true;
}

static Bool emit_switch(C99 *c, const SwitchStatement *statement) {
	if (statement->init) return unsupported(c, "switch initializer");
	indent(c);
	fputs("switch (", c->out);
	if (statement->cond) {
		if (!emit_expression(c, statement->cond)) return false;
	} else {
		fputs("true", c->out);
	}
	fputs(") {\n", c->out);
	c->depth++;

	const Size n_clauses = array_size(statement->clauses);
	for (Size i = 0; i < n_clauses; i++) {
		const CaseClause *clause = statement->clauses[i];
		if (!clause->expressions || array_size(clause->expressions->expressions) == 0) {
			indent(c); fputs("default:\n", c->out);
		} else {
			const Size n_cases = array_size(clause->expressions->expressions);
			for (Size j = 0; j < n_cases; j++) {
				indent(c); fputs("case ", c->out);
				if (!emit_expression(c, clause->expressions->expressions[j])) return false;
				fputs(":\n", c->out);
			}
		}
		c->depth++;
		const Size n_statements = array_size(clause->statements);
		for (Size j = 0; j < n_statements; j++) {
			if (!emit_statement(c, clause->statements[j])) return false;
		}
		indent(c); fputs("break;\n", c->out);
		c->depth--;
	}
	c->depth--;
	indent(c); fputs("}\n", c->out);
	return true;
}

static Bool emit_statement(C99 *c, const Statement *statement) {
	switch (statement->kind) {
	case STATEMENT_EMPTY: return true;
	case STATEMENT_DECLARATION: return emit_declaration(c, RCAST(const DeclarationStatement *, statement));
	case STATEMENT_ASSIGNMENT: return emit_assignment(c, RCAST(const AssignmentStatement *, statement));
	case STATEMENT_IF: return emit_if(c, RCAST(const IfStatement *, statement));
	case STATEMENT_RETURN: return emit_return(c, RCAST(const ReturnStatement *, statement));
	case STATEMENT_FOR: return emit_for(c, RCAST(const ForStatement *, statement));
	case STATEMENT_SWITCH: return emit_switch(c, RCAST(const SwitchStatement *, statement));
	case STATEMENT_EXPRESSION:
		indent(c);
		if (!emit_expression(c, RCAST(const ExpressionStatement *, statement)->expression)) return false;
		fputs(";\n", c->out);
		return true;
	case STATEMENT_BRANCH: {
		const BranchStatement *branch = RCAST(const BranchStatement *, statement);
		indent(c);
		if (branch->branch == KEYWORD_BREAK) fputs("break;\n", c->out);
		else if (branch->branch == KEYWORD_CONTINUE) fputs("continue;\n", c->out);
		else return unsupported(c, "branch statement");
		return true;
	}
	case STATEMENT_BLOCK:
		indent(c);
		return emit_block(c, RCAST(const BlockStatement *, statement));
	case STATEMENT_PACKAGE: case STATEMENT_IMPORT:
		return true;
	default:
		return unsupported(c, "statement kind");
	}
}

static Bool emit_block(C99 *c, const BlockStatement *block) {
	fputs("{\n", c->out);
	c->depth++;
	const Size n_statements = array_size(block->statements);
	for (Size i = 0; i < n_statements; i++) {
		if (!emit_statement(c, block->statements[i])) return false;
	}
	c->depth--;
	indent(c);
	fputs("}\n", c->out);
	return true;
}

static Bool declaration_parts(const DeclarationStatement *declaration,
                              Identifier **name, const Expression **value) {
	if (!declaration->values || array_size(declaration->names) != 1 ||
	    array_size(declaration->values->expressions) != 1) return false;
	*name = declaration->names[0];
	*value = declaration->values->expressions[0];
	return true;
}

static Bool emit_parameters(C99 *c, const ProcedureExpression *procedure) {
	const Size n_params = array_size(procedure->type->params);
	if (!n_params) {
		fputs("void", c->out);
		return true;
	}
	for (Size i = 0; i < n_params; i++) {
		const Field *field = procedure->type->params[i];
		CType type = sema_type_from_ast(field->type);
		const char *type_name = sema_c_type_name(type);
		if (!type_name || !field->name) return unsupported(c, "procedure parameter type");
		if (i) fputs(", ", c->out);
		fprintf(c->out, "%s %.*s", type_name, SFMT(field->name->contents));
	}
	return true;
}

static Bool emit_prototype(C99 *c, const DeclarationStatement *declaration,
                           Identifier *name, const ProcedureExpression *procedure) {
	CType result = sema_procedure_result(procedure);
	const char *result_name = sema_c_type_name(result);
	if (!result_name) return unsupported(c, "procedure result type");
	if (!sema_declaration_is_exported(declaration)) fputs("static ", c->out);
	fprintf(c->out, "%s %.*s(", result_name, SFMT(name->contents));
	if (!emit_parameters(c, procedure)) return false;
	fputs(");\n", c->out);
	return true;
}

static Bool emit_definition(C99 *c, const DeclarationStatement *declaration,
                            Identifier *name, const ProcedureExpression *procedure) {
	CType result = sema_procedure_result(procedure);
	const char *result_name = sema_c_type_name(result);
	if (!result_name) return unsupported(c, "procedure result type");

	sema_begin_procedure(&c->sema, procedure);
	if (!sema_declaration_is_exported(declaration)) fputs("static ", c->out);
	fprintf(c->out, "%s %.*s(", result_name, SFMT(name->contents));
	if (!emit_parameters(c, procedure)) return false;
	fputs(") ", c->out);
	if (!emit_block(c, procedure->body)) return false;
	fputc('\n', c->out);
	return true;
}

static Bool for_each_declaration(C99 *c, BuildContext *build, int phase) {
	const Size n_work = array_size(build->work);
	for (Size w = 0; w < n_work; w++) {
		Tree *tree = build->work[w]->tree;
		const Size n_statements = array_size(tree->statements);
		for (Size i = 0; i < n_statements; i++) {
			if (tree->statements[i]->kind != STATEMENT_DECLARATION) continue;
			const DeclarationStatement *declaration = RCAST(const DeclarationStatement *, tree->statements[i]);
			Identifier *name;
			const Expression *value;
			if (!declaration_parts(declaration, &name, &value)) return unsupported(c, "top-level declaration");

			if (value->kind == EXPRESSION_PROCEDURE) {
				const ProcedureExpression *procedure = RCAST(const ProcedureExpression *, value);
				if (phase == 1 && !emit_prototype(c, declaration, name, procedure)) return false;
				if (phase == 2 && !emit_definition(c, declaration, name, procedure)) return false;
			} else if (phase == 0) {
				CType type = declaration->type ? sema_type_from_ast(declaration->type)
				                               : sema_infer_expression(&c->sema, value);
				const char *type_name = sema_c_type_name(type);
				if (!type_name) return unsupported(c, "top-level constant type");
				fprintf(c->out, "static const %s %.*s = ", type_name, SFMT(name->contents));
				if (!emit_expression(c, value)) return false;
				fputs(";\n", c->out);
			}
		}
	}
	return true;
}

Bool c99_emit_build(FILE *out, BuildContext *build) {
	C99 c;
	c.out = out;
	c.depth = 0;
	c.ok = true;
	sema_init(&c.sema);
	if (!sema_collect_globals(&c.sema, build)) return false;

	fputs("/* generated by Codin's strict C99 backend */\n"
	      "#include <stdbool.h>\n"
	      "#include <stddef.h>\n"
	      "#include <stdint.h>\n\n", out);

	if (!for_each_declaration(&c, build, 0)) return false;
	fputc('\n', out);
	if (!for_each_declaration(&c, build, 1)) return false;
	fputc('\n', out);
	if (!for_each_declaration(&c, build, 2)) return false;
	return c.ok;
}
