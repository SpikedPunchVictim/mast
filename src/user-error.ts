/**
 * Something the user can fix without a code change: a config value mast rejects,
 * a project path that is not a directory, a directory mast may not read, a
 * command run before there is an index. The CLI prints the message as one line
 * and exits 1 (`runCli`); any other error keeps its stack trace, because that
 * one is a bug in mast.
 *
 * The message has to stand alone: it names the file or path and what to change.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
