-- caller-span.sql: for every `checker` edge, is the line of the call inside a chunk of the
-- symbol the edge is from? `start_line` and `end_line` are the declaration's own lines.
with ce as (
  select e.rowid id, e.call_line, s.name, f.path, s.kind,
    exists(select 1 from chunks c where c.file_path = f.path and c.symbol_name = s.name
           and e.call_line between c.start_line and c.end_line) inside,
    exists(select 1 from chunks c where c.file_path = f.path and c.symbol_name = s.name) has_chunk,
    e.from_id = e.to_id self
  from edges e join symbols s on s.id = e.from_id join files f on f.id = s.file_id
  where e.resolution = 'checker')
select 'checker edges', count(*) from ce
union all select 'call line inside a chunk of the caller', sum(inside) from ce
union all select 'call line outside every chunk of the caller', sum(has_chunk and not inside) from ce
union all select 'caller has no chunk of its name', sum(not has_chunk) from ce
union all select 'from and to are one symbol', sum(self) from ce
union all select 'from and to are one symbol, call line outside', sum(self and has_chunk and not inside) from ce;
