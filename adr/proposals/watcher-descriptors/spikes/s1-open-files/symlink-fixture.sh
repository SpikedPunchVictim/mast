#!/bin/zsh
# A project of one .ts file with a symbolic link to a directory of eight .ts files outside
# it. The walk indexes one file. `zsh symlink-fixture.sh <empty dir>`, then count.mjs on
# <dir>/proj.
dir=${1:A}; mkdir -p $dir/proj/src $dir/outside
for i in 1 2 3 4 5 6 7 8; do echo "export const a$i = $i;" > $dir/outside/f$i.ts; done
echo "export const x = 1;" > $dir/proj/src/real.ts
ln -s $dir/outside $dir/proj/linked
