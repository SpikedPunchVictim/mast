# The five changes to the resolver that no test noticed (D140). Run from the repository root:
#   python3 docs/defects/repro/2026-10-08-review/mutations.py m1 && pnpm vitest run src/ast src/indexer src/graph src/mcp
#   git checkout src
# m1: a name declared twice in a function keeps its dynamic-import binding
# m2: a call through a type annotation is placed by a dynamic-import local of the same name
# m3: `const { X } = import('./x')` binds X without the await
# m4: a package entry that is a .d.ts file is taken as its own source
# m5: calls inside a class declared in a function are given to the function
import sys
T='src/ast/extractors/typescript.ts'; R='src/indexer/import-resolver.ts'
M={
 'm1':(T,"  for (const local of [...bindings.keys()]) if (timesDeclared.get(local) !== 1) bindings.delete(local);\n",""),
 'm2':(T,"new Set(['import', 'construction', 'static_method', 'new_expression']);","new Set(['import', 'construction', 'static_method', 'new_expression', 'parameter_type', 'field_type']);"),
 'm3':(T,"const module = value !== null && nodeType(value) === 'await_expression' ? dynamicImportSpecifier(value) : null;","const module = value !== null ? dynamicImportSpecifier(value) : null;"),
 'm4':(R,"TS_SOURCE.test(literal) && !DECLARATION_FILE.test(literal)) return literal;","TS_SOURCE.test(literal)) return literal;"),
 'm5':(T,"    if (NESTED_CLASS_TYPES.has(t) || t === 'decorator') return;","    if (t === 'decorator') return;"),
}
f,a,b=M[sys.argv[1]]; s=open(f).read(); assert s.count(a)==1,(sys.argv[1],s.count(a)); open(f,'w').write(s.replace(a,b))
