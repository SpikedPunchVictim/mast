import Shape, { Shape as Named } from './shape';
import go from './run';
import { default as again } from './run';
import cfg from './value';
export class Square extends Shape {}
export function use(s: Shape, n: Named, q: Square): Shape {
  s.area(); n.area(); q.area(); go(); again(); cfg.tool();
  return new Shape();
}
