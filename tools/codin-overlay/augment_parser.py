#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit(f"usage: {sys.argv[0]} path/to/src/parser.c")

path = Path(sys.argv[1])
src = path.read_text()
old = '''\tUnionType *type = 0;
\tif (parameters) {
\t\ttype = RCAST(UnionType *, tree_new_generic_union_type(parser->tree, flags, align, parameters, variants, where_clauses));
\t} else {
\t\ttype = RCAST(UnionType *, tree_new_concrete_union_type(parser->tree, flags, align, variants, where_clauses));
\t}'''
new = '''\tUnionType *type = 0;
\tif (array_size(parameters)) {
\t\ttype = RCAST(UnionType *, tree_new_generic_union_type(parser->tree, flags, align, parameters, variants, where_clauses));
\t} else {
\t\ttype = RCAST(UnionType *, tree_new_concrete_union_type(parser->tree, flags, align, variants, where_clauses));
\t}'''
count = src.count(old)
if count != 1:
    raise SystemExit(f"augment_parser: union classification anchor: expected 1, found {count}")
path.write_text(src.replace(old, new, 1))
print("augment_parser: empty union parameter list is concrete")
