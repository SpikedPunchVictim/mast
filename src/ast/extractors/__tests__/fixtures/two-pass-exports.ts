// Declarations defined without export modifier,
// then re-exported via export { ... } clause.
function internalHandle(): void {}

class InternalService {
  run(): void {}
}

type InternalType = string;

export { internalHandle, InternalService, InternalType };
