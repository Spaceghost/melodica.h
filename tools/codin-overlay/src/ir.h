#ifndef CODIN_IR_H
#define CODIN_IR_H

#include "tree.h"

typedef struct IRRangeFor {
	Identifier *index;
	Expression *first;
	Expression *limit;
	Bool inclusive;
} IRRangeFor;

Bool ir_lower_range_for(const ForStatement *statement, IRRangeFor *range);

#endif
