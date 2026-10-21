/* General C99 lowering for the pinned Codin AST used by the protocol package.
 * This file contains compiler machinery only. Protocol algorithms are read from
 * impl/codin/piano/*.odin by Codin's parser and emitted as ordinary C functions.
 * The smaller experimental serializer backend remains a separate executable.
 */
#include "c99.h"
#include "tree.h"
#include "ir.h"
#include "sema.h"
#include "string.h"
#include <stdlib.h>

#define PN(a) ((a) ? array_size(a) : 0)
typedef struct { String name; const Type *type; const DeclarationStatement *decl;
    const ProcedureExpression *proc; Bool foreign; } PianoSymbol;
typedef struct {
    FILE *out; Bool ok; unsigned depth, serial;
    PianoSymbol globals[2048], locals[2048]; Size nglobal, nlocal;
    PointerType pointers[16384]; Size npointer;
    const Statement *defers[512]; Size ndefer;
    Size loop_defers[128]; Size nloop;
    const ProcedureExpression *procedure; String procedure_name;
    BuiltinType integer, size, byte, boolean, string, rawptr;
} PianoC99;

static Bool px(PianoC99 *, const Expression *, const Type *);
static Bool ps(PianoC99 *, const Statement *);
static Bool pb(PianoC99 *, const BlockStatement *);
static const Type *pi(PianoC99 *, const Expression *);
static Bool pt(PianoC99 *, const Type *);
static Bool pdecl(PianoC99 *, const Type *, String);
static void pad(PianoC99 *c) { for (unsigned i=0; i<c->depth; ++i) fputs("    ",c->out); }
static Bool pe(PianoC99 *c, const char *message) {
    fprintf(stderr,"codin: protocol C99: %s (in %.*s)\n",message,SFMT(c->procedure_name));
    c->ok=false; return false;
}
static Bool eq(String a, const char *b) { return string_compare(a,string_from_null(b)); }
static const char *primitive(String n) {
    if(eq(n,"bool"))return "bool";
    if(eq(n,"u8"))return "uint8_t"; if(eq(n,"i8"))return "int8_t";
    if(eq(n,"u16"))return "uint16_t"; if(eq(n,"i16"))return "int16_t";
    if(eq(n,"u32"))return "uint32_t"; if(eq(n,"i32"))return "int32_t";
    if(eq(n,"u64"))return "uint64_t"; if(eq(n,"i64"))return "int64_t";
    if(eq(n,"int"))return "intptr_t"; if(eq(n,"uint")||eq(n,"uintptr"))return "uintptr_t";
    if(eq(n,"f32"))return "float"; if(eq(n,"f64"))return "double";
    if(eq(n,"cstring")||eq(n,"string"))return "char *";
    if(eq(n,"rawptr"))return "void *";
    return NULL;
}
static const Type *builtin(PianoC99 *c, String n) {
    if(eq(n,"cstring")||eq(n,"string"))return &c->string.base;
    if(eq(n,"rawptr"))return &c->rawptr.base;
    if(eq(n,"bool"))return &c->boolean.base;
    if(eq(n,"u8"))return &c->byte.base;
    if(eq(n,"uintptr")||eq(n,"uint"))return &c->size.base;
    if(primitive(n)) {
        BuiltinType *t=calloc(1,sizeof(*t));
        if(!t){pe(c,"compiler allocation failed");return NULL;}
        t->base.kind=TYPE_BUILTIN; t->identifier=n; return &t->base;
    }
    return NULL;
}
static const Type *pointer_to(PianoC99 *c,const Type *element) {
    if(c->npointer>=16384){pe(c,"pointer inference capacity exceeded");return NULL;}
    PointerType *p=&c->pointers[c->npointer++];p->base.kind=TYPE_POINTER;p->type=(Type*)element;
    return &p->base;
}
static PianoSymbol *lookup(PianoC99 *c,String name) {
    for(Size i=c->nlocal;i>0;--i)if(string_compare(c->locals[i-1].name,name))return &c->locals[i-1];
    for(Size i=c->nglobal;i>0;--i)if(string_compare(c->globals[i-1].name,name))return &c->globals[i-1];
    return NULL;
}
static Bool local(PianoC99*c,String name,const Type*type){
    if(c->nlocal>=2048)return pe(c,"local symbol capacity exceeded");
    c->locals[c->nlocal++]=(PianoSymbol){.name=name,.type=type};return true;
}
static String type_name(const Type*t){
    if(!t)return STRING_NIL;
    if(t->kind==TYPE_BUILTIN)return ((const BuiltinType*)t)->identifier;
    if(t->kind==TYPE_EXPRESSION){const Expression*e=((const ExpressionType*)t)->expression;
        if(e&&e->kind==EXPRESSION_IDENTIFIER)return ((const IdentifierExpression*)e)->identifier->contents;}
    return STRING_NIL;
}
static const Type *resolve(PianoC99*c,const Type*t){
    for(unsigned i=0;t&&t->kind==TYPE_EXPRESSION&&i<64;++i){
        const Expression*e=((const ExpressionType*)t)->expression;
        if(e&&e->kind==EXPRESSION_TYPE){t=((const TypeExpression*)e)->type;continue;}
        PianoSymbol*s=lookup(c,type_name(t));if(!s||!s->type||s->type==t)break;t=s->type;
    }return t;
}
static Bool isptr(PianoC99*c,const Type*t){
    t=resolve(c,t);return t&&(t->kind==TYPE_POINTER||t->kind==TYPE_MULTI_POINTER);
}
static const Type *element(PianoC99*c,const Type*t){
    t=resolve(c,t);if(!t)return NULL;
    if(t->kind==TYPE_POINTER)return ((const PointerType*)t)->type;
    if(t->kind==TYPE_MULTI_POINTER)return ((const MultiPointerType*)t)->type;
    if(t->kind==TYPE_ARRAY)return ((const ArrayType*)t)->type;
    if(eq(type_name(t),"cstring")||eq(type_name(t),"string"))return &c->byte.base;
    return NULL;
}
static const Type *field_type(PianoC99*c,const Type*t,String name){
    t=resolve(c,t);if(isptr(c,t))t=resolve(c,element(c,t));
    if(t&&t->kind==TYPE_STRUCT){const StructType*s=(const StructType*)t;
        for(Size i=0;i<PN(s->fields);++i)if(s->fields[i]->name&&string_compare(s->fields[i]->name->contents,name))return s->fields[i]->type;}
    return NULL;
}
static const ProcedureExpression *called(PianoC99*c,const Expression*e){
    if(!e||e->kind!=EXPRESSION_IDENTIFIER)return NULL;
    PianoSymbol*s=lookup(c,((const IdentifierExpression*)e)->identifier->contents);return s?s->proc:NULL;
}
static const Type *pi(PianoC99*c,const Expression*e){
    if(!e)return NULL;
    switch(e->kind){
    case EXPRESSION_IDENTIFIER:{String n=((const IdentifierExpression*)e)->identifier->contents;
        if(eq(n,"true")||eq(n,"false"))return &c->boolean.base;
        PianoSymbol*s=lookup(c,n);return s?s->type:builtin(c,n);}
    case EXPRESSION_LITERAL:{const LiteralExpression*l=(const LiteralExpression*)e;
        return l->kind==LITERAL_STRING?&c->string.base:&c->integer.base;}
    case EXPRESSION_CAST:return ((const CastExpression*)e)->type;
    case EXPRESSION_TYPE:return ((const TypeExpression*)e)->type;
    case EXPRESSION_SELECTOR:{const SelectorExpression*s=(const SelectorExpression*)e;return field_type(c,pi(c,s->operand),s->identifier->contents);}
    case EXPRESSION_INDEX:return element(c,pi(c,((const IndexExpression*)e)->operand));
    case EXPRESSION_COMPOUND_LITERAL:return ((const CompoundLiteralExpression*)e)->type;
    case EXPRESSION_TUPLE:{const TupleExpression*t=(const TupleExpression*)e;return PN(t->expressions)==1?pi(c,t->expressions[0]):NULL;}
    case EXPRESSION_UNARY:{const UnaryExpression*u=(const UnaryExpression*)e;
        if(u->operation==OPERATOR_AND)return pointer_to(c,pi(c,u->operand));
        if(u->operation==OPERATOR_POINTER)return element(c,pi(c,u->operand));
        if(u->operation==OPERATOR_NOT)return &c->boolean.base;
        return pi(c,u->operand);}
    case EXPRESSION_BINARY:{const BinaryExpression*b=(const BinaryExpression*)e;
        switch(b->operation){case OPERATOR_CMPEQ:case OPERATOR_NOTEQ:case OPERATOR_LT:case OPERATOR_GT:
        case OPERATOR_LTEQ:case OPERATOR_GTEQ:case OPERATOR_CMPAND:case OPERATOR_CMPOR:return &c->boolean.base;
        default:{const Type*t=pi(c,b->lhs);return t?t:pi(c,b->rhs);}}}
    case EXPRESSION_CALL:{const CallExpression*call=(const CallExpression*)e;
        if(call->operand->kind==EXPRESSION_IDENTIFIER){String n=((const IdentifierExpression*)call->operand)->identifier->contents;
            if(eq(n,"size_of")||eq(n,"align_of")||eq(n,"offset_of")||eq(n,"len"))return &c->size.base;
            const Type*t=builtin(c,n);if(t)return t;
            PianoSymbol*s=lookup(c,n);if(s&&s->proc&&PN(s->proc->type->results)==1)return s->proc->type->results[0]->type;
            if(s&&s->type)return s->type;}
        return NULL;}
    default:return NULL;}
}
static Bool pt(PianoC99*c,const Type*t){
    if(!t)return pe(c,"missing inferred type");
    if(t->kind==TYPE_POINTER||t->kind==TYPE_MULTI_POINTER){if(!pt(c,element(c,t)))return false;fputs(" *",c->out);return true;}
    if(t->kind==TYPE_ARRAY){const ArrayType*a=(const ArrayType*)t;if(!pt(c,a->type))return false;fputc('[',c->out);if(!px(c,a->count,NULL))return false;fputc(']',c->out);return true;}
    if(t->kind==TYPE_EXPRESSION){const Expression*e=((const ExpressionType*)t)->expression;
        if(e&&e->kind==EXPRESSION_TYPE)return pt(c,((const TypeExpression*)e)->type);}
    String n=type_name(t);const char*p=primitive(n);
    if(p)fputs(p,c->out);else if(n.length)fprintf(c->out,"%.*s",SFMT(n));else return pe(c,"unsupported type shape");
    return true;
}
static Bool pdecl(PianoC99*c,const Type*t,String n){
    const Type *actual=resolve(c,t);
    if(actual&&actual->kind==TYPE_ARRAY){const ArrayType*a=(const ArrayType*)actual;
        if(!pdecl(c,a->type,n))return false;fputc('[',c->out);if(!px(c,a->count,NULL))return false;fputc(']',c->out);return true;}
    if(!pt(c,t))return false;fprintf(c->out," %.*s",SFMT(n));return true;
}
static const char *pop(OperatorKind op){switch(op){
    case OPERATOR_ADD:return "+";case OPERATOR_SUB:return "-";case OPERATOR_MUL:return "*";
    case OPERATOR_QUO:return "/";case OPERATOR_MOD:return "%";case OPERATOR_AND:return "&";
    case OPERATOR_OR:return "|";case OPERATOR_XOR:return "^";case OPERATOR_SHL:return "<<";case OPERATOR_SHR:return ">>";
    case OPERATOR_CMPEQ:return "==";case OPERATOR_NOTEQ:return "!=";case OPERATOR_LT:return "<";case OPERATOR_GT:return ">";
    case OPERATOR_LTEQ:return "<=";case OPERATOR_GTEQ:return ">=";case OPERATOR_CMPAND:return "&&";case OPERATOR_CMPOR:return "||";
    default:return NULL;}}
static Bool px(PianoC99*c,const Expression*e,const Type*expected){
    if(!e)return pe(c,"missing expression");
    switch(e->kind){
    case EXPRESSION_IDENTIFIER:{String n=((const IdentifierExpression*)e)->identifier->contents;
        if(eq(n,"nil"))fputs("NULL",c->out);else if(primitive(n))fputs(primitive(n),c->out);
        else fprintf(c->out,"%.*s",SFMT(n));return true;}
    case EXPRESSION_LITERAL:fprintf(c->out,"%.*s",SFMT(((const LiteralExpression*)e)->value));return true;
    case EXPRESSION_TYPE:return pt(c,((const TypeExpression*)e)->type);
    case EXPRESSION_TUPLE:{const TupleExpression*t=(const TupleExpression*)e;if(PN(t->expressions)!=1)return pe(c,"tuple expression");return px(c,t->expressions[0],expected);}
    case EXPRESSION_SELECTOR:{const SelectorExpression*s=(const SelectorExpression*)e;
        fputc('(',c->out);if(!px(c,s->operand,NULL))return false;fputc(')',c->out);
        fputs(isptr(c,pi(c,s->operand))?"->":".",c->out);fprintf(c->out,"%.*s",SFMT(s->identifier->contents));return true;}
    case EXPRESSION_INDEX:{const IndexExpression*i=(const IndexExpression*)e;
        fputc('(',c->out);if(!px(c,i->operand,NULL))return false;fputs(")[",c->out);if(!px(c,i->lhs,NULL))return false;fputc(']',c->out);return true;}
    case EXPRESSION_CAST:{const CastExpression*x=(const CastExpression*)e;
        fputs("((",c->out);if(!pt(c,x->type?x->type:expected))return false;fputs(")(",c->out);
        if(!px(c,x->expression,NULL))return false;fputs("))",c->out);return true;}
    case EXPRESSION_UNARY:{const UnaryExpression*u=(const UnaryExpression*)e;const char*op=NULL;
        switch(u->operation){case OPERATOR_AND:op="&";break;case OPERATOR_POINTER:op="*";break;
        case OPERATOR_NOT:op="!";break;case OPERATOR_XOR:op="~";break;case OPERATOR_ADD:op="+";break;case OPERATOR_SUB:op="-";break;default:return pe(c,"unary operator");}
        fprintf(c->out,"(%s(",op);if(!px(c,u->operand,NULL))return false;fputs("))",c->out);return true;}
    case EXPRESSION_BINARY:{const BinaryExpression*b=(const BinaryExpression*)e;const char*op=pop(b->operation);
        if(!op&&b->operation!=OPERATOR_ANDNOT)return pe(c,"binary operator");
        fputc('(',c->out);if(!px(c,b->lhs,NULL))return false;fprintf(c->out," %s ",op?op:"& ~");
        if(!px(c,b->rhs,NULL))return false;fputc(')',c->out);return true;}
    case EXPRESSION_TERNARY:{const TernaryExpression*t=(const TernaryExpression*)e;fputc('(',c->out);
        if(!px(c,t->cond,NULL))return false;fputs(" ? ",c->out);if(!px(c,t->on_true,expected))return false;
        fputs(" : ",c->out);if(!px(c,t->on_false,expected))return false;fputc(')',c->out);return true;}
    case EXPRESSION_COMPOUND_LITERAL:{const CompoundLiteralExpression*l=(const CompoundLiteralExpression*)e;
        const Type*t=l->type?l->type:expected;if(!t)return pe(c,"untyped compound without destination");
        fputc('(',c->out);if(!pt(c,t))return false;fputs("){",c->out);
        if(!PN(l->fields))fputc('0',c->out);
        for(Size i=0;i<PN(l->fields);++i){if(i)fputs(", ",c->out);const Field*f=l->fields[i];
            if(f->name)fprintf(c->out,".%.*s = ",SFMT(f->name->contents));if(!px(c,f->value,NULL))return false;}
        fputc('}',c->out);return true;}
    case EXPRESSION_CALL:{const CallExpression*call=(const CallExpression*)e;
        const ProcedureExpression*p=called(c,call->operand);
        if(call->operand->kind==EXPRESSION_IDENTIFIER){String n=((const IdentifierExpression*)call->operand)->identifier->contents;
            const char*type=primitive(n);
            if(type){if(PN(call->arguments)!=1)return pe(c,"scalar cast arity");fprintf(c->out,"((%s)(",type);
                if(!px(c,call->arguments[0]->value,NULL))return false;fputs("))",c->out);return true;}
            if(eq(n,"size_of")){fputs("sizeof(",c->out);if(PN(call->arguments)!=1||!px(c,call->arguments[0]->value,NULL))return false;fputc(')',c->out);return true;}
            if(eq(n,"align_of")){fputs("(sizeof(struct { char prefix; ",c->out);
                if(PN(call->arguments)!=1||!px(c,call->arguments[0]->value,NULL))return false;
                fputs(" value; }) - sizeof(",c->out);
                if(!px(c,call->arguments[0]->value,NULL))return false;
                fputs("))",c->out);return true;}
            if(eq(n,"offset_of")){fputs("offsetof(",c->out);if(PN(call->arguments)!=2||!px(c,call->arguments[0]->value,NULL))return false;
                fputs(", ",c->out);if(!px(c,call->arguments[1]->value,NULL))return false;fputc(')',c->out);return true;}
            if(eq(n,"len")){const Type*t=PN(call->arguments)?resolve(c,pi(c,call->arguments[0]->value)):NULL;
                if(t&&t->kind==TYPE_ARRAY)return px(c,((const ArrayType*)t)->count,NULL);
                fputs("strlen(",c->out);if(!px(c,call->arguments[0]->value,NULL))return false;fputc(')',c->out);return true;}}
        if(!px(c,call->operand,NULL))return false;fputc('(',c->out);
        Size n=PN(call->arguments),params=p?PN(p->type->params):0;
        for(Size i=0;i<n;++i){if(i)fputs(", ",c->out);if(!px(c,call->arguments[i]->value,i<params?p->type->params[i]->type:NULL))return false;}
        for(Size i=n;i<params;++i){const Field*f=p->type->params[i];if(f->flags&FIELD_FLAG_C_VARARG)break;
            if(!f->value)return pe(c,"missing required argument");if(i)fputs(", ",c->out);if(!px(c,f->value,f->type))return false;}
        fputc(')',c->out);return true;}
    default:return pe(c,"expression kind");}
}
static Bool defer_from(PianoC99*c,Size first){
    for(Size i=c->ndefer;i>first;--i)if(!ps(c,c->defers[i-1]))return false;return true;
}
static const char *assignop(AssignmentKind k){switch(k){
    case ASSIGNMENT_EQ:return "=";case ASSIGNMENT_ADD:return "+=";case ASSIGNMENT_SUB:return "-=";
    case ASSIGNMENT_MUL:return "*=";case ASSIGNMENT_QUO:return "/=";case ASSIGNMENT_MOD:return "%=";
    case ASSIGNMENT_AND:return "&=";case ASSIGNMENT_OR:return "|=";case ASSIGNMENT_XOR:return "^=";
    case ASSIGNMENT_SHL:return "<<=";case ASSIGNMENT_SHR:return ">>=";default:return NULL;}}
static Bool post_expression(PianoC99*c,const Statement*s){
    if(!s)return true;
    if(s->kind==STATEMENT_EXPRESSION)return px(c,((const ExpressionStatement*)s)->expression,NULL);
    if(s->kind==STATEMENT_ASSIGNMENT){const AssignmentStatement*a=(const AssignmentStatement*)s;
        if(PN(a->lhs->expressions)!=1||PN(a->rhs->expressions)!=1)return pe(c,"tuple loop post");
        const char*op=assignop(a->assignment);if(!op)return pe(c,"loop post operator");
        if(!px(c,a->lhs->expressions[0],NULL))return false;fprintf(c->out," %s ",op);
        return px(c,a->rhs->expressions[0],pi(c,a->lhs->expressions[0]));}
    return pe(c,"loop post statement");
}
static Bool declaration(PianoC99*c,const DeclarationStatement*d){
    Size n=PN(d->names),values=d->values?PN(d->values->expressions):0;
    if(n>1&&values==1){const Expression*e=d->values->expressions[0];
        const ProcedureExpression*p=e->kind==EXPRESSION_CALL?called(c,((const CallExpression*)e)->operand):NULL;
        if(p&&PN(p->type->results)==n){unsigned id=c->serial++;const CallExpression*call=(const CallExpression*)e;
            String name=((const IdentifierExpression*)call->operand)->identifier->contents;
            pad(c);fprintf(c->out,"%.*s_result tmp_%u = ",SFMT(name),id);if(!px(c,e,NULL))return false;fputs(";\n",c->out);
            for(Size i=0;i<n;++i){const Type*t=p->type->results[i]->type;pad(c);if(!pdecl(c,t,d->names[i]->contents))return false;
                fprintf(c->out," = tmp_%u.v%zu;\n",id,(size_t)i);if(!local(c,d->names[i]->contents,t))return false;}return true;}}
    if(values&&values!=n)return pe(c,"declaration value count");
    for(Size i=0;i<n;++i){const Expression*value=values?d->values->expressions[i]:NULL;
        const Type*t=d->type?d->type:pi(c,value);if(!t)return pe(c,"local inference");
        pad(c);if(!pdecl(c,t,d->names[i]->contents))return false;fputs(" = ",c->out);
        if(value){if(resolve(c,t)->kind==TYPE_ARRAY&&value->kind==EXPRESSION_COMPOUND_LITERAL){
                const CompoundLiteralExpression*l=(const CompoundLiteralExpression*)value;fputc('{',c->out);
                if(!PN(l->fields))fputc('0',c->out);
                for(Size k=0;k<PN(l->fields);++k){if(k)fputs(", ",c->out);if(!px(c,l->fields[k]->value,NULL))return false;}fputc('}',c->out);
            }else if(!px(c,value,t))return false;
        }else fputs("{0}",c->out);
        fputs(";\n",c->out);if(!local(c,d->names[i]->contents,t))return false;}
    return true;
}
static Bool ps(PianoC99*c,const Statement*s){
    if(!s)return true;
    switch(s->kind){
    case STATEMENT_EMPTY:case STATEMENT_PACKAGE:case STATEMENT_IMPORT:case STATEMENT_FOREIGN_IMPORT:return true;
    case STATEMENT_DECLARATION:return declaration(c,(const DeclarationStatement*)s);
    case STATEMENT_EXPRESSION:pad(c);if(!px(c,((const ExpressionStatement*)s)->expression,NULL))return false;fputs(";\n",c->out);return true;
    case STATEMENT_ASSIGNMENT:{const AssignmentStatement*a=(const AssignmentStatement*)s;
        if(PN(a->lhs->expressions)!=1||PN(a->rhs->expressions)!=1)return pe(c,"tuple assignment");
        const Expression *lhs=a->lhs->expressions[0];
        if(a->assignment==ASSIGNMENT_EQ&&lhs->kind==EXPRESSION_IDENTIFIER&&
            eq(((const IdentifierExpression*)lhs)->identifier->contents,"_")){
            pad(c);fputs("(void)(",c->out);if(!px(c,a->rhs->expressions[0],NULL))return false;
            fputs(");\n",c->out);return true;}
        const char*op=assignop(a->assignment);if(!op)return pe(c,"assignment operator");
        pad(c);if(!px(c,a->lhs->expressions[0],NULL))return false;fprintf(c->out," %s ",op);
        if(!px(c,a->rhs->expressions[0],pi(c,a->lhs->expressions[0])))return false;fputs(";\n",c->out);return true;}
    case STATEMENT_BLOCK:pad(c);return pb(c,(const BlockStatement*)s);
    case STATEMENT_IF:{const IfStatement*i=(const IfStatement*)s;Size locals=c->nlocal;
        if(i->init&&!ps(c,i->init))return false;pad(c);fputs("if ",c->out);
        if(i->cond->kind!=EXPRESSION_BINARY)fputc('(',c->out);
        if(!px(c,i->cond,NULL))return false;
        if(i->cond->kind!=EXPRESSION_BINARY)fputc(')',c->out);
        fputc(' ',c->out);
        if(!pb(c,i->body))return false;if(i->elif){pad(c);fputs("else ",c->out);if(!pb(c,i->elif))return false;}c->nlocal=locals;return true;}
    case STATEMENT_DEFER:if(c->ndefer>=512)return pe(c,"defer capacity");c->defers[c->ndefer++]=((const DeferStatement*)s)->statement;return true;
    case STATEMENT_RETURN:{const ReturnStatement*r=(const ReturnStatement*)s;Size n=r->result?PN(r->result->expressions):0;
        unsigned id=c->serial++;if(n){pad(c);
            if(n>1)fprintf(c->out,"%.*s_result",SFMT(c->procedure_name));else if(!pt(c,c->procedure->type->results[0]->type))return false;
            fprintf(c->out," return_%u = ",id);if(n>1)fputc('{',c->out);
            for(Size i=0;i<n;++i){if(i)fputs(", ",c->out);if(!px(c,r->result->expressions[i],c->procedure->type->results[i]->type))return false;}
            if(n>1)fputc('}',c->out);fputs(";\n",c->out);}
        if(!defer_from(c,0))return false;pad(c);if(n)fprintf(c->out,"return return_%u;\n",id);else fputs("return;\n",c->out);return true;}
    case STATEMENT_BRANCH:{const BranchStatement*b=(const BranchStatement*)s;
        if(c->nloop&&!defer_from(c,c->loop_defers[c->nloop-1]))return false;pad(c);
        if(b->branch==KEYWORD_BREAK)fputs("break;\n",c->out);else if(b->branch==KEYWORD_CONTINUE)fputs("continue;\n",c->out);
        else return pe(c,"branch kind");return true;}
    case STATEMENT_FOR:{const ForStatement*f=(const ForStatement*)s;Size locals=c->nlocal;IRRangeFor range;
        pad(c);fputs("{\n",c->out);c->depth++;
        if(f->init&&!ps(c,f->init))return false;
        Bool ranged=ir_lower_range_for(f,&range);const BinaryExpression*in=NULL;
        if(!ranged&&f->cond&&f->cond->kind==EXPRESSION_BINARY&&((const BinaryExpression*)f->cond)->operation==OPERATOR_IN)in=(const BinaryExpression*)f->cond;
        pad(c);
        if(ranged){const Type*t=pi(c,range.limit);if(!t)t=&c->size.base;
            fputs("for (",c->out);if(!pdecl(c,t,range.index->contents))return false;fputs(" = ",c->out);if(!px(c,range.first,t))return false;
            fprintf(c->out,"; %.*s %s ",SFMT(range.index->contents),range.inclusive?"<=":"<");if(!px(c,range.limit,t))return false;
            fprintf(c->out,"; ++%.*s) ",SFMT(range.index->contents));if(!local(c,range.index->contents,t))return false;
        }else if(in){const TupleExpression*names=(const TupleExpression*)in->lhs;const Type*t=resolve(c,pi(c,in->rhs));
            if(!t||t->kind!=TYPE_ARRAY||PN(names->expressions)!=1)return pe(c,"foreach requires fixed array");
            String name=((const IdentifierExpression*)names->expressions[0])->identifier->contents;unsigned id=c->serial++;
            fprintf(c->out,"for (uintptr_t index_%u = 0; index_%u < ",id,id);if(!px(c,((const ArrayType*)t)->count,NULL))return false;
            fprintf(c->out,"; ++index_%u) {\n",id);c->depth++;pad(c);if(!pdecl(c,element(c,t),name))return false;
            fputs(" = (",c->out);if(!px(c,in->rhs,NULL))return false;fprintf(c->out,")[index_%u];\n",id);
            if(!local(c,name,element(c,t)))return false;
        }else {fputs("for (; ",c->out);if(f->cond){if(!px(c,f->cond,NULL))return false;}else fputs("true",c->out);
            fputs("; ",c->out);if(!post_expression(c,f->post))return false;fputs(") ",c->out);}
        if(c->nloop>=128)return pe(c,"loop nesting capacity");c->loop_defers[c->nloop++]=c->ndefer;
        if(!pb(c,f->body))return false;
        c->nloop--;if(in){c->depth--;pad(c);fputs("}\n",c->out);}c->depth--;pad(c);fputs("}\n",c->out);c->nlocal=locals;return true;}
    case STATEMENT_SWITCH:{const SwitchStatement*w=(const SwitchStatement*)s;if(w->init&&!ps(c,w->init))return false;
        pad(c);fputs("switch (",c->out);if(!px(c,w->cond,NULL))return false;fputs(") {\n",c->out);c->depth++;
        for(Size i=0;i<PN(w->clauses);++i){const CaseClause*k=w->clauses[i];Size locals=c->nlocal,defers=c->ndefer;
            Size n=k->expressions?PN(k->expressions->expressions):0;
            if(!n){pad(c);fputs("default:\n",c->out);}for(Size j=0;j<n;++j){pad(c);fputs("case ",c->out);if(!px(c,k->expressions->expressions[j],NULL))return false;fputs(":\n",c->out);}
            pad(c);fputs("{\n",c->out);c->depth++;
            for(Size j=0;j<PN(k->statements);++j)if(!ps(c,k->statements[j]))return false;
            if(!defer_from(c,defers))return false;c->ndefer=defers;pad(c);fputs("break;\n",c->out);c->depth--;pad(c);fputs("}\n",c->out);c->nlocal=locals;}
        c->depth--;pad(c);fputs("}\n",c->out);return true;}
    default:return pe(c,"statement kind");}
}
static Bool pb(PianoC99*c,const BlockStatement*b){Size locals=c->nlocal,defers=c->ndefer;
    fputs("{\n",c->out);c->depth++;for(Size i=0;i<PN(b->statements);++i)if(!ps(c,b->statements[i]))return false;
    if(!defer_from(c,defers))return false;c->ndefer=defers;c->nlocal=locals;c->depth--;pad(c);fputs("}\n",c->out);return true;
}
static Bool collect(PianoC99*c,const Statement*s,Bool foreign){
    if(s->kind==STATEMENT_FOREIGN_BLOCK){const BlockStatement*b=((const ForeignBlockStatement*)s)->body;
        for(Size i=0;i<PN(b->statements);++i)if(!collect(c,b->statements[i],true))return false;return true;}
    if(s->kind!=STATEMENT_DECLARATION)return true;const DeclarationStatement*d=(const DeclarationStatement*)s;
    if(PN(d->names)!=1||!d->values||PN(d->values->expressions)!=1)return pe(c,"top-level declaration shape");
    if(c->nglobal>=2048)return pe(c,"global capacity");const Expression*e=d->values->expressions[0];
    PianoSymbol sym={.name=d->names[0]->contents,.decl=d,.foreign=foreign};
    if(e->kind==EXPRESSION_PROCEDURE)sym.proc=(const ProcedureExpression*)e;
    else if(e->kind==EXPRESSION_TYPE)sym.type=((const TypeExpression*)e)->type;
    else sym.type=d->type?d->type:pi(c,e);c->globals[c->nglobal++]=sym;return true;
}
static Bool parameters(PianoC99*c,const ProcedureExpression*p){Size n=PN(p->type->params);if(!n)fputs("void",c->out);
    for(Size i=0;i<n;++i){const Field*f=p->type->params[i];if(i)fputs(", ",c->out);
        if(f->flags&FIELD_FLAG_C_VARARG){fputs("...",c->out);continue;}
        const Type*t=f->type?f->type:pi(c,f->value);if(!f->name||!pdecl(c,t,f->name->contents))return false;}
    return true;
}
static Bool result_type(PianoC99*c,PianoSymbol*s){Size n=PN(s->proc->type->results);
    if(!n)fputs("void",c->out);else if(n>1)fprintf(c->out,"%.*s_result",SFMT(s->name));else return pt(c,s->proc->type->results[0]->type);return true;
}
Bool c99_emit_build(FILE*out,BuildContext*build){
    PianoC99*c=calloc(1,sizeof(*c));if(!c)return false;c->out=out;c->ok=true;
    c->integer.base.kind=c->size.base.kind=c->byte.base.kind=c->boolean.base.kind=c->string.base.kind=c->rawptr.base.kind=TYPE_BUILTIN;
    c->integer.identifier=SCLIT("int");c->size.identifier=SCLIT("uintptr");c->byte.identifier=SCLIT("u8");
    c->boolean.identifier=SCLIT("bool");c->string.identifier=SCLIT("cstring");c->rawptr.identifier=SCLIT("rawptr");
    for(Size w=0;w<PN(build->work);++w){const Tree*t=build->work[w]->tree;
        for(Size i=0;i<PN(t->statements);++i)if(!collect(c,t->statements[i],false))return false;}
    fputs("/* Protocol code emitted from Odin-dialect sources by the pinned Codin parser. */\n"
          "#include <stdbool.h>\n#include <stdint.h>\n#include <stddef.h>\n#include <stdlib.h>\n"
          "#include <string.h>\n#include <stdio.h>\n#include <time.h>\n\n",out);
    for(Size i=0;i<c->nglobal;++i){PianoSymbol*s=&c->globals[i];if(s->type&&s->type->kind==TYPE_STRUCT)
        fprintf(out,"typedef struct %.*s %.*s;\n",SFMT(s->name),SFMT(s->name));}
    for(Size i=0;i<c->nglobal;++i){PianoSymbol*s=&c->globals[i];if(s->type&&s->type->kind==TYPE_STRUCT){
        const StructType*t=(const StructType*)s->type;fprintf(out,"struct %.*s {\n",SFMT(s->name));
        for(Size j=0;j<PN(t->fields);++j){const Field*f=t->fields[j];fputs("    ",out);if(!pdecl(c,f->type,f->name->contents))return false;fputs(";\n",out);}fputs("};\n",out);
    }else if(s->proc&&PN(s->proc->type->results)>1){fprintf(out,"typedef struct %.*s_result {\n",SFMT(s->name));
        for(Size j=0;j<PN(s->proc->type->results);++j){if(!pt(c,s->proc->type->results[j]->type))return false;fprintf(out," v%zu;\n",(size_t)j);}
        fprintf(out,"} %.*s_result;\n",SFMT(s->name));
    }else if(!s->proc){const Expression*e=s->decl->values->expressions[0];
        if(e->kind==EXPRESSION_TYPE)return pe(c,"non-struct top-level type");
        fprintf(out,"#define %.*s (",SFMT(s->name));if(!px(c,e,s->type))return false;fputs(")\n",out);}}
    for(Size i=0;i<c->nglobal;++i){PianoSymbol*s=&c->globals[i];if(!s->proc)continue;
        if(s->foreign&&(eq(s->name,"calloc")||eq(s->name,"malloc")||eq(s->name,"free")||eq(s->name,"memcpy")||
            eq(s->name,"strlen")||eq(s->name,"strcmp")||eq(s->name,"strdup")||eq(s->name,"strtoul")||eq(s->name,"strtol")||
            eq(s->name,"time")||eq(s->name,"snprintf")))continue;
        if(!s->foreign&&!sema_declaration_is_exported(s->decl))fputs("static ",out);
        if(!result_type(c,s))return false;fprintf(out," %.*s(",SFMT(s->name));if(!parameters(c,s->proc))return false;fputs(");\n",out);}
    for(Size i=0;i<c->nglobal;++i){PianoSymbol*s=&c->globals[i];if(!s->proc||s->foreign)continue;
        c->nlocal=0;c->ndefer=0;c->nloop=0;c->procedure=s->proc;c->procedure_name=s->name;
        for(Size j=0;j<PN(s->proc->type->params);++j){const Field*f=s->proc->type->params[j];if(f->name)
            if(!local(c,f->name->contents,f->type?f->type:pi(c,f->value)))return false;}
        if(!sema_declaration_is_exported(s->decl))fputs("static ",out);
        if(!result_type(c,s))return false;fprintf(out," %.*s(",SFMT(s->name));if(!parameters(c,s->proc))return false;fputs(") ",out);
        if(!pb(c,s->proc->body))return false;fputc('\n',out);}
    Bool ok=c->ok;free(c);return ok;
}
