// A namespace import that is then exported, and one exported in the `from` form.
import * as helpers from './helpers';
export { helpers };
export * as viaFrom from './helpers';
