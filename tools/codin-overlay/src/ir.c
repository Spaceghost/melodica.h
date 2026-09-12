#include "ir.h"

Bool ir_lower_range_for(const ForStatement *statement, IRRangeFor *range) {
	if (statement->init || statement->post || !statement->cond) return false;
	if (statement->cond->kind != EXPRESSION_BINARY) return false;

	const BinaryExpression *in = RCAST(const BinaryExpression *, statement->cond);
	if (in->operation != OPERATOR_IN || in->lhs->kind != EXPRESSION_TUPLE ||
	    in->rhs->kind != EXPRESSION_BINARY) return false;

	const TupleExpression *indices = RCAST(const TupleExpression *, in->lhs);
	if (array_size(indices->expressions) != 1 ||
	    indices->expressions[0]->kind != EXPRESSION_IDENTIFIER) return false;

	const BinaryExpression *span = RCAST(const BinaryExpression *, in->rhs);
	if (span->operation != OPERATOR_RANGEHALF && span->operation != OPERATOR_RANGEFULL) return false;

	range->index = RCAST(const IdentifierExpression *, indices->expressions[0])->identifier;
	range->first = span->lhs;
	range->limit = span->rhs;
	range->inclusive = span->operation == OPERATOR_RANGEFULL;
	return true;
}
