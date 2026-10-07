#!/bin/sh
# usage: watch-replay.sh <mast cli js> <label>   -- replays c8021eb..0a744c9 under a running `mast serve`
set -u
BIN=$1; L=$2; T=$(cd "$(dirname "$0")" && pwd); SRC=/Users/spikedpunchvictim/projects/mast
C=$T/corpus-$L; rm -rf "$C" "$T/full-$L"
git clone -q "$SRC" "$C" && cd "$C" && git checkout -q c8021eb
node "$BIN" index > /dev/null 2>&1
Q="select coalesce(resolution,edge_type), count(*) from edges group by 1 order by 1"
D="select e.edge_type||'|'||coalesce(e.resolution,'')||'|'||ff.path||':'||a.name||'>'||tf.path||':'||b.name from edges e join symbols a on a.id=e.from_id join files ff on ff.id=a.file_id join symbols b on b.id=e.to_id join files tf on tf.id=b.file_id order by 1"
echo "[$L] start, full index at c8021eb:"; sqlite3 .mast/graph.db "$Q" | tr '\n' ' '; echo
mkfifo "$T/fifo-$L" 2>/dev/null; sleep 900 > "$T/fifo-$L" & HOLD=$!
node "$BIN" serve < "$T/fifo-$L" > "$T/serve-$L.out" 2> "$T/serve-$L.err" & SERVE=$!
sleep 5
for c in $(git -C "$SRC" log --reverse --format=%h c8021eb..0a744c9); do git checkout -q "$c"; sleep 7; done
sleep 8
kill $SERVE $HOLD; sleep 1
echo "[$L] after 16 checkouts under serve:"; sqlite3 .mast/graph.db "$Q" | tr '\n' ' '; echo
sqlite3 .mast/graph.db "$D" > "$T/edges-watched-$L.txt"
node "$BIN" index --state-dir "$T/full-$L" . > /dev/null 2>&1
echo "[$L] full index of the same tree:"; sqlite3 "$T/full-$L/graph.db" "$Q" | tr '\n' ' '; echo
sqlite3 "$T/full-$L/graph.db" "$D" > "$T/edges-full-$L.txt"
echo "[$L] in full, not in watched: $(comm -13 "$T/edges-watched-$L.txt" "$T/edges-full-$L.txt" | wc -l)   in watched, not in full: $(comm -23 "$T/edges-watched-$L.txt" "$T/edges-full-$L.txt" | wc -l)"
echo "[$L] serve stderr tail:"; tail -3 "$T/serve-$L.err" | cut -c1-200
